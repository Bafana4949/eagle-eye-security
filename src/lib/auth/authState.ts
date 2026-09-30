/**
 * How the app decides who is signed in (used by AuthProvider; plain functions so they can be
 * tested without React).
 *
 * supabase.auth.getSession() works offline, but with an expired access token (normal after an
 * hour on a night shift) it first tries to refresh it, retrying for up to ~30 s with no signal
 * — or longer on a connection that answers nothing. The guard app (and its SOS button) must not
 * sit on "Checking your sign-in…" meanwhile, so after SESSION_WAIT_MS the cached identity of the
 * account holding this device's session is shown (isOfflineSession: true) while the check
 * continues; its final answer replaces it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Site, UserProfile, UserRole } from '@/types/models';
import { raceWithTimeout } from '@/lib/supabase/timeouts';
import { isDefinitelySignedOut } from './authErrors';
import {
  clearCurrentUserPointer,
  clearIdentityCache,
  loadIdentity,
  pickActiveSite,
  readActiveSiteId,
  readCurrentCachedUserId,
  readIdentityCache,
  setCurrentUserPointer,
  writeIdentityCache,
  type IdentitySnapshot,
  type KeyValueStorage,
  type LoadIdentityResult
} from './identity';

export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';
/**
 * Why the user is signed out: no profile row, account disabled, identity could not be loaded
 * (offline on a phone that never cached it, or a server error), or the app is not configured.
 */
export type SignedOutReason = 'no_profile' | 'disabled' | 'unavailable' | 'config_error';

export interface AuthState {
  status: AuthStatus;
  reason: SignedOutReason | null;
  /** Identity came from this device's cache because the server could not be reached (yet). */
  isOfflineSession: boolean;
  user: { id: string; email: string | null } | null;
  profile: UserProfile | null;
  roles: UserRole[];
  /** Sites this user may see (assigned sites; the whole organisation for admins). */
  sites: Site[];
  activeSite: Site | null;
  /** Human-readable detail for 'unavailable' / 'config_error'. */
  error: string | null;
}

/** How long boot waits for the session check before showing the cached identity. */
export const SESSION_WAIT_MS = 3_000;
/** How long boot waits for profile, roles and sites before falling back to the cache. */
export const IDENTITY_TIMEOUT_MS = 10_000;

export const INITIAL_AUTH_STATE: AuthState = {
  status: 'loading',
  reason: null,
  isOfflineSession: false,
  user: null,
  profile: null,
  roles: [],
  sites: [],
  activeSite: null,
  error: null
};

export function signedOutState(reason: SignedOutReason | null, error: string | null = null): AuthState {
  return { ...INITIAL_AUTH_STATE, status: 'signed_out', reason, error };
}

export function stateFromSnapshot(
  snapshot: IdentitySnapshot,
  isOfflineSession: boolean,
  storage: KeyValueStorage | null
): AuthState {
  return {
    status: 'signed_in',
    reason: null,
    isOfflineSession,
    user: snapshot.user,
    profile: snapshot.profile,
    roles: snapshot.roles,
    sites: snapshot.sites,
    activeSite: pickActiveSite(snapshot.sites, readActiveSiteId(storage, snapshot.user.id)),
    error: null
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * The cached identity of the account that holds this device's session. The pointer is set when
 * a session is established (sign-in), not when an identity loads, so it never names a previous
 * user whose cache happens to be newer.
 */
export function cachedIdentityForSession(storage: KeyValueStorage | null): IdentitySnapshot | null {
  const userId = readCurrentCachedUserId(storage);
  return userId ? readIdentityCache(storage, userId) : null;
}

type SessionCheck = { user: { id: string; email?: string | null } | null; error: unknown };

export interface ResolveAuthOptions {
  getClient: () => Pick<SupabaseClient, 'auth' | 'from'>;
  storage: KeyValueStorage | null;
  /** Receives the cached identity when the session check is slow; the final state follows. */
  onInterim?: (state: AuthState) => void;
  sessionWaitMs?: number;
  identityTimeoutMs?: number;
}

/** Session → profile, roles and sites (RLS-scoped) → AuthState. Never throws. */
export async function resolveAuthState(options: ResolveAuthOptions): Promise<AuthState> {
  const { storage } = options;
  let supabase: Pick<SupabaseClient, 'auth' | 'from'>;
  try {
    supabase = options.getClient();
  } catch (error) {
    return signedOutState('config_error', messageOf(error));
  }

  const sessionCheck: Promise<SessionCheck> = supabase.auth.getSession().then(
    ({ data, error }) => ({ user: data.session?.user ?? null, error }),
    (error: unknown) => ({ user: null, error })
  );
  const quick = await raceWithTimeout(sessionCheck, options.sessionWaitMs ?? SESSION_WAIT_MS);
  if (quick.timedOut) {
    const cached = cachedIdentityForSession(storage);
    if (cached) options.onInterim?.(stateFromSnapshot(cached, true, storage));
  }
  const { user: sessionUser, error } = quick.timedOut ? await sessionCheck : quick.value;

  if (sessionUser) {
    const user = { id: sessionUser.id, email: sessionUser.email ?? null };
    // This account holds the session now, whether or not its identity can be loaded.
    setCurrentUserPointer(storage, user.id);
    const identityTimeoutMs = options.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS;
    const loaded = await raceWithTimeout(loadIdentity(supabase, user), identityTimeoutMs);
    const result: LoadIdentityResult = loaded.timedOut
      ? {
          kind: 'unavailable',
          network: true,
          message: `Could not load your account details within ${Math.round(identityTimeoutMs / 1000)} s`
        }
      : loaded.value;
    switch (result.kind) {
      case 'ok':
        writeIdentityCache(storage, result.snapshot);
        return stateFromSnapshot(result.snapshot, false, storage);
      case 'no_profile':
        clearIdentityCache(storage, user.id);
        return signedOutState('no_profile');
      case 'disabled':
        clearIdentityCache(storage, user.id);
        return signedOutState('disabled');
      case 'unavailable': {
        const cached = readIdentityCache(storage, user.id);
        if (cached) return stateFromSnapshot(cached, true, storage);
        return signedOutState('unavailable', result.message);
      }
    }
  }

  if (error && !isDefinitelySignedOut(error)) {
    // An expired access token could not be refreshed (no connection). The session is still
    // stored; boot from the cached identity of the account that holds it.
    const cached = cachedIdentityForSession(storage);
    if (cached) return stateFromSnapshot(cached, true, storage);
    return signedOutState('unavailable', messageOf(error));
  }

  // Definitely no session: nobody's cache may be used to boot this device any more.
  clearCurrentUserPointer(storage);
  return signedOutState(null);
}
