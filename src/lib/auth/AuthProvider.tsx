'use client';

/**
 * Real Supabase authentication state for the whole app.
 *
 * Boot: supabase.auth.getSession() (works offline) → profile, roles and visible sites from
 * Supabase (RLS-scoped). The result is cached per user in localStorage so a guard whose token
 * cannot be refreshed (no signal) still gets the guard app; `isOfflineSession` is then true and
 * nothing is sent to the server until the session is valid again. The cache is display data
 * only — every server write is authorised by the JWT and RLS. A slow session check (expired
 * token, no signal) shows the cached identity after a few seconds instead of blocking the app;
 * see ./authState.ts.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { raceWithTimeout } from '@/lib/supabase/timeouts';
import { syncEngine } from '@/lib/offline/sync';
import {
  INITIAL_AUTH_STATE,
  resolveAuthState,
  signedOutState,
  type AuthState
} from './authState';
import {
  browserStorage,
  clearCurrentUserPointer,
  clearIdentityCache,
  readCurrentCachedUserId,
  setCurrentUserPointer,
  writeActiveSiteId
} from './identity';

export { signIn, loginToEmail } from './signIn';
export type { AuthState, AuthStatus, SignedOutReason } from './authState';

/** How long sign-out waits for the server before signing out this device only. */
export const SIGN_OUT_WAIT_MS = 5_000;

export type SignOutResult =
  | { ok: true; /** true when the server could not be told (offline): only this device was signed out. */ localOnly: boolean }
  | { ok: false; reason: 'pending_sync'; pendingCount: number };

export interface AuthContextValue extends AuthState {
  setActiveSiteId(siteId: string): void;
  /** Reloads session, profile, roles and sites. Resolves with the new state. */
  refresh(): Promise<AuthState>;
  /**
   * Signs out of this device. Refused while the user still has unsynced events unless
   * `force` is set; queued events are NEVER deleted (they sync when this user signs in again).
   */
  signOut(options?: { force?: boolean }): Promise<SignOutResult>;
}

/**
 * Removes this browser's Supabase auth cookies. Used when signOut() could not complete because
 * the device is offline, so the next person on a shared phone cannot continue the session.
 * (The refresh token stays valid on the server until it expires or an admin revokes it.)
 */
function clearLocalAuthCookies(): void {
  if (typeof document === 'undefined') return;
  document.cookie
    .split(';')
    .map((part) => part.split('=')[0]?.trim())
    .filter((name): name is string => !!name && /^sb-.+-auth-token(-code-verifier)?(\.\d+)?$/.test(name))
    .forEach((name) => {
      document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
    });
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_AUTH_STATE);
  const stateRef = useRef<AuthState>(INITIAL_AUTH_STATE);
  const refreshSeq = useRef(0);

  const apply = useCallback((next: AuthState) => {
    stateRef.current = next;
    setState(next);
    syncEngine?.setActiveUser(next.status === 'signed_in' ? next.user?.id ?? null : null);
  }, []);

  const refresh = useCallback(async (): Promise<AuthState> => {
    const seq = ++refreshSeq.current;
    let next: AuthState;
    try {
      next = await resolveAuthState({
        getClient: createClient,
        storage: browserStorage(),
        onInterim: (interim) => {
          // Only while nobody is shown as signed in yet (boot / "Try again"): never flip a live session.
          if (seq === refreshSeq.current && stateRef.current.status !== 'signed_in') apply(interim);
        }
      });
    } catch (error) {
      next = signedOutState('unavailable', error instanceof Error ? error.message : String(error));
    }
    // A newer refresh (e.g. triggered by an auth event) wins.
    if (seq === refreshSeq.current) apply(next);
    return seq === refreshSeq.current ? next : stateRef.current;
  }, [apply]);

  useEffect(() => {
    void refresh();

    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = createClient().auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION') return;
        if (event === 'SIGNED_OUT') {
          refreshSeq.current += 1;
          clearCurrentUserPointer(browserStorage());
          apply(signedOutState(null));
          return;
        }
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          // The account holding the session (e.g. signed in from another tab) is the only one
          // whose cached identity may be used to boot offline.
          if (session?.user?.id) setCurrentUserPointer(browserStorage(), session.user.id);
          // Deferred: Supabase calls made inside this callback can deadlock the auth lock.
          setTimeout(() => void refresh(), 0);
        }
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      // Not configured: refresh() already reported config_error.
    }

    const onOnline = () => {
      if (stateRef.current.isOfflineSession || stateRef.current.reason === 'unavailable') void refresh();
    };
    window.addEventListener('online', onOnline);
    return () => {
      unsubscribe?.();
      window.removeEventListener('online', onOnline);
    };
  }, [apply, refresh]);

  const setActiveSiteId = useCallback(
    (siteId: string) => {
      const current = stateRef.current;
      if (!current.user) return;
      const site = current.sites.find((candidate) => candidate.id === siteId);
      if (!site) return;
      writeActiveSiteId(browserStorage(), current.user.id, site.id);
      apply({ ...current, activeSite: site });
    },
    [apply]
  );

  const signOut = useCallback(
    async (options: { force?: boolean } = {}): Promise<SignOutResult> => {
      const current = stateRef.current;
      const userId = current.user?.id ?? null;
      if (userId && syncEngine) {
        const pendingCount = await syncEngine.pendingCountForUser(userId);
        if (pendingCount > 0 && !options.force) return { ok: false, reason: 'pending_sync', pendingCount };
      }

      const storage = browserStorage();
      let localOnly = false;
      let serverCall: Promise<unknown> | null = null;
      try {
        // 'local': end this device's session only (a guard's other devices stay signed in).
        // Offline with an expired token this first retries a refresh for ~30 s: do not wait for it.
        serverCall = createClient()
          .auth.signOut({ scope: 'local' })
          .then(
            ({ error }) => error ?? null,
            (error: unknown) => error ?? new Error('Sign-out failed')
          );
        const outcome = await raceWithTimeout(serverCall, SIGN_OUT_WAIT_MS);
        localOnly = outcome.timedOut || outcome.value !== null;
      } catch {
        localOnly = true;
      }
      if (userId) clearIdentityCache(storage, userId);
      clearCurrentUserPointer(storage);
      if (localOnly) {
        clearLocalAuthCookies();
        // The slow call may still complete a token refresh that writes the session back; clear it
        // again when it settles, unless somebody has signed in on this device in the meantime.
        void serverCall?.then(() => {
          if (!readCurrentCachedUserId(browserStorage())) clearLocalAuthCookies();
        });
      }
      refreshSeq.current += 1;
      apply(signedOutState(null));
      return { ok: true, localOnly };
    },
    [apply]
  );

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, setActiveSiteId, refresh, signOut }),
    [state, setActiveSiteId, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an <AuthProvider>');
  return context;
}
