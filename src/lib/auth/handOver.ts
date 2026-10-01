/**
 * Handing a shared patrol phone from the person signed in on it to the next one.
 *
 * Rule: the NEXT person's session is created first (password check or patrol-phone token).
 * Only when it exists is the previous person forgotten on this phone. A wrong password or a
 * refused guard tap therefore leaves whoever was signed in untouched, and no sign-out call can
 * still be running when the new session is stored.
 *
 * Why no ordinary signOut() before the new sign-in: supabase-js' signOut() removes WHATEVER
 * session is stored when its server call settles - even after a timeout, even with an error
 * (@supabase/auth-js 2.117 GoTrueClient._signOut → _removeSession) - while signInWithPassword /
 * verifyOtp store the new session without waiting for it. A slow sign-out of the previous user
 * could therefore wipe the next guard's session seconds after they signed in. Instead:
 *   1. captureSessionAccessToken() reads the previous session's access token (no network unless
 *      it has to be refreshed);
 *   2. the new session replaces the stored one (signInWithPassword / verifyOtp);
 *   3. forgetReplacedUser() drops the previous person's cached identity on this phone, and
 *      revokeReplacedSession() ends their session on the server with admin.signOut(token) - a pure
 *      network call that never touches the stored session.
 * Their queued (not yet uploaded) records stay on the phone and upload when they sign in again.
 *
 * PendingSignOut covers the other path: an ordinary sign-out that gave up waiting (no signal)
 * leaves supabase-js' call running; the next sign-in on the phone waits for it to settle first.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raceWithTimeout } from '@/lib/supabase/timeouts';
import { clearIdentityCache, type KeyValueStorage } from './identity';

/** How long a new sign-in waits for an earlier, still running sign-out to settle. */
export const PENDING_SIGN_OUT_MAX_WAIT_MS = 45_000;
/** Reading the stored session (a refresh may be needed when the access token expired). */
export const CAPTURE_SESSION_TIMEOUT_MS = 8_000;
/** Ending the replaced session on the server (best effort, in the background). */
export const REVOKE_REPLACED_TIMEOUT_MS = 15_000;

type AuthClient = Pick<SupabaseClient, 'auth'>;

/**
 * The access token of the session stored on this phone, if it belongs to `userId`; null when
 * there is none, it belongs to someone else, or it cannot be read in time. Never throws.
 */
export async function captureSessionAccessToken(
  supabase: AuthClient,
  userId: string,
  timeoutMs: number = CAPTURE_SESSION_TIMEOUT_MS
): Promise<string | null> {
  try {
    const outcome = await raceWithTimeout(supabase.auth.getSession(), timeoutMs);
    if (outcome.timedOut) return null;
    const session = outcome.value.data?.session ?? null;
    if (!session || session.user?.id !== userId || typeof session.access_token !== 'string') return null;
    return session.access_token;
  } catch {
    return null;
  }
}

/**
 * Ends a session that was just replaced on this phone, on the server only (POST /logout with its
 * own access token). Does not read or write the stored session. Resolves true when the server
 * confirmed; false otherwise (offline, expired token - the refresh token then simply expires).
 */
export async function revokeReplacedSession(
  supabase: AuthClient,
  accessToken: string | null,
  timeoutMs: number = REVOKE_REPLACED_TIMEOUT_MS
): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const outcome = await raceWithTimeout(supabase.auth.admin.signOut(accessToken, 'local'), timeoutMs);
    return !outcome.timedOut && !outcome.value.error;
  } catch {
    return false;
  }
}

/** Forgets the previous person's cached identity on this phone (their queued records stay). */
export function forgetReplacedUser(storage: KeyValueStorage | null, previousUserId: string | null, newUserId: string): void {
  if (!previousUserId || previousUserId === newUserId) return;
  clearIdentityCache(storage, previousUserId);
}

/**
 * A sign-out whose server call is still running after the app stopped waiting for it. The next
 * sign-in on this phone calls settle() first so that call cannot remove the new session.
 */
export class PendingSignOut {
  private pending: Promise<void> | null = null;

  track(call: Promise<unknown>): void {
    const settled = call.then(
      () => undefined,
      () => undefined
    );
    this.pending = settled;
    void settled.then(() => {
      if (this.pending === settled) this.pending = null;
    });
  }

  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Waits (at most `maxWaitMs`) for a running sign-out. True when none is running any more. */
  async settle(maxWaitMs: number = PENDING_SIGN_OUT_MAX_WAIT_MS): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return true;
    const outcome = await raceWithTimeout(pending, maxWaitMs);
    return !outcome.timedOut;
  }
}
