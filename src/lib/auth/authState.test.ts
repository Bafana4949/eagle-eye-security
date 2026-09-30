import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { resolveAuthState, type AuthState } from './authState';
import {
  AUTH_CACHE_CURRENT_KEY,
  readCurrentCachedUserId,
  writeIdentityCache,
  type IdentitySnapshot,
  type KeyValueStorage
} from './identity';
import { signIn } from './signIn';

const ORG = '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c';
const USER_A = { id: 'a1111111-2222-4333-8444-555555555555', email: 'wag1@guards.eagleeye.local' };
const USER_B = { id: 'b1111111-2222-4333-8444-555555555555', email: 'wag2@guards.eagleeye.local' };

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  };
}

function snapshot(user: { id: string; email: string }, firstName: string): IdentitySnapshot {
  return {
    user,
    profile: {
      id: user.id,
      organisationId: ORG,
      firstName,
      lastName: 'Guard',
      preferredLanguage: 'en',
      roles: ['guard'],
      isActive: true
    },
    roles: ['guard'],
    sites: [],
    loadedAt: '2026-09-30T16:00:00.000Z'
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type SessionResult = { data: { session: { user: { id: string; email?: string } } | null }; error: unknown };

/** A client whose getSession answers when the test says so; table reads answer from `tables` (or never). */
function fakeClient(session: Promise<SessionResult>, tables?: Record<string, { data: unknown; error: unknown }>) {
  const answer = (table: string) =>
    tables ? Promise.resolve({ ...tables[table], status: 200 }) : new Promise<never>(() => undefined);
  const client = {
    auth: { getSession: () => session },
    from: (table: string) => ({
      select: () => {
        const result = answer(table);
        return { eq: () => ({ maybeSingle: () => result, then: result.then.bind(result) }), order: () => result };
      }
    })
  };
  return client as unknown as Pick<SupabaseClient, 'auth' | 'from'>;
}

describe('resolveAuthState', () => {
  it('shows the cached identity of the session holder when the session check is slow, then settles', async () => {
    const storage = memoryStorage();
    writeIdentityCache(storage, snapshot(USER_A, 'Sipho'));
    const session = deferred<SessionResult>();
    const interim: AuthState[] = [];

    const started = Date.now();
    const final = resolveAuthState({
      getClient: () => fakeClient(session.promise),
      storage,
      onInterim: (state) => interim.push(state),
      sessionWaitMs: 30
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(interim.length, 1, 'cached identity shown while the check continues');
    assert.equal(interim[0].status, 'signed_in');
    assert.equal(interim[0].isOfflineSession, true);
    assert.equal(interim[0].user?.id, USER_A.id);
    assert.ok(Date.now() - started < 1_000);

    // Offline with an expired token: the refresh finally gives up with a retryable error.
    session.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    const state = await final;
    assert.equal(state.status, 'signed_in');
    assert.equal(state.isOfflineSession, true);
    assert.equal(state.profile?.firstName, 'Sipho');
  });

  it('never boots offline as a previous account: the pointer follows the latest sign-in', async () => {
    const storage = memoryStorage();
    writeIdentityCache(storage, snapshot(USER_A, 'Sipho'));
    // B signs in over A's session on the login page; B's identity has never been loaded here.
    const result = await signIn(
      'wag2',
      'secret',
      {
        auth: {
          signInWithPassword: async () => ({ data: { user: { id: USER_B.id }, session: { access_token: 't' } }, error: null })
        }
      } as unknown as Pick<SupabaseClient, 'auth'>,
      storage
    );
    assert.equal(result.ok, true);
    assert.equal(readCurrentCachedUserId(storage), USER_B.id);

    const interim: AuthState[] = [];
    const state = await resolveAuthState({
      getClient: () =>
        fakeClient(Promise.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })),
      storage,
      onInterim: (s) => interim.push(s)
    });
    assert.equal(state.status, 'signed_out');
    assert.equal(state.reason, 'unavailable');
    assert.equal(state.user, null, 'not booted as the previous account');
    assert.equal(interim.length, 0);
  });

  it('records the session holder even when its identity cannot be loaded, and falls back after a time limit', async () => {
    const storage = memoryStorage();
    writeIdentityCache(storage, snapshot(USER_A, 'Sipho'));
    writeIdentityCache(storage, snapshot(USER_B, 'Thabo'));
    storage.setItem(AUTH_CACHE_CURRENT_KEY, USER_A.id);

    const state = await resolveAuthState({
      // Session is B's; profile/roles/sites never answer (connection black hole).
      getClient: () => fakeClient(Promise.resolve({ data: { session: { user: USER_B } }, error: null })),
      storage,
      identityTimeoutMs: 30
    });
    assert.equal(readCurrentCachedUserId(storage), USER_B.id);
    assert.equal(state.status, 'signed_in');
    assert.equal(state.isOfflineSession, true);
    assert.equal(state.profile?.firstName, 'Thabo');
  });

  it('a definite sign-out clears the pointer; a disabled account is signed out and its cache removed', async () => {
    const storage = memoryStorage();
    writeIdentityCache(storage, snapshot(USER_A, 'Sipho'));
    const gone = await resolveAuthState({
      getClient: () => fakeClient(Promise.resolve({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') })),
      storage
    });
    assert.deepEqual([gone.status, gone.reason], ['signed_out', null]);
    assert.equal(readCurrentCachedUserId(storage), null);

    writeIdentityCache(storage, snapshot(USER_A, 'Sipho'));
    const disabled = await resolveAuthState({
      getClient: () =>
        fakeClient(Promise.resolve({ data: { session: { user: USER_A } }, error: null }), {
          profiles: {
            data: {
              id: USER_A.id,
              organisation_id: ORG,
              first_name: 'Sipho',
              last_name: 'Guard',
              employee_number: null,
              phone_number: null,
              preferred_language: 'en',
              is_active: false
            },
            error: null
          }
        }),
      storage
    });
    assert.deepEqual([disabled.status, disabled.reason], ['signed_out', 'disabled']);
    assert.equal(storage.getItem(`ee.authcache.${USER_A.id}`), null);
  });

  it('reports a missing configuration instead of pretending', async () => {
    const state = await resolveAuthState({
      getClient: () => {
        throw new Error('Supabase is not configured');
      },
      storage: memoryStorage()
    });
    assert.deepEqual([state.status, state.reason, state.error], ['signed_out', 'config_error', 'Supabase is not configured']);
  });
});
