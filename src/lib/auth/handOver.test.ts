/**
 * Shared-phone hand-over (src/lib/auth/handOver.ts) and its use by the patrol-phone sign-in.
 *
 * Regression for the hand-over race: supabase-js' signOut() removes whatever session is stored
 * when its server call settles (also after a timeout, also on error), while verifyOtp /
 * signInWithPassword store the new session without waiting for it. A previous sign-out that
 * settled AFTER the next guard's verifyOtp wiped that guard's session. The fake GoTrue client
 * below behaves exactly like that; the tests show the new guard's session survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_CACHE_CURRENT_KEY, AUTH_CACHE_PREFIX, type KeyValueStorage } from './identity';
import {
  PendingSignOut,
  captureSessionAccessToken,
  forgetReplacedUser,
  revokeReplacedSession
} from './handOver';
import { PATROL_DEVICE_STORAGE_KEY, signInGuardOnDevice } from './patrolDevice';

const OLD_GUARD = 'a1111111-2222-4333-8444-555555555555';
const NEW_GUARD = 'b2222222-2222-4333-8444-555555555555';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface StoredSession {
  access_token: string;
  user: { id: string };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A GoTrue-like client: one stored session; signOut() resolves when `release()` is called and
 * then removes WHATEVER session is stored (auth-js 2.117 _signOut → _removeSession); verifyOtp()
 * stores the new session immediately; admin.signOut(jwt) is a network call only.
 */
function fakeGoTrue(initial: StoredSession | null) {
  let stored: StoredSession | null = initial;
  const log: string[] = [];
  const gate = deferred();
  const auth = {
    async getSession() {
      log.push('getSession');
      return { data: { session: stored }, error: null };
    },
    async signOut() {
      log.push('signOut:start');
      await gate.promise;
      stored = null;
      log.push('signOut:removedStoredSession');
      return { error: null };
    },
    async verifyOtp(params: { token_hash: string }) {
      log.push(`verifyOtp:${params.token_hash}`);
      stored = { access_token: `new-${params.token_hash}`, user: { id: NEW_GUARD } };
      return { data: { session: stored, user: stored.user }, error: null };
    },
    admin: {
      async signOut(jwt: string, scope: string) {
        log.push(`admin.signOut:${jwt}:${scope}`);
        return { data: null, error: null };
      }
    }
  };
  return {
    client: { auth } as unknown as Pick<SupabaseClient, 'auth'>,
    log,
    release: () => gate.resolve(),
    stored: () => stored
  };
}

function enrolledStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(
    PATROL_DEVICE_STORAGE_KEY,
    JSON.stringify({
      deviceId: 'd1111111-2222-4333-8444-555555555555',
      secret: `EED-${'ab12'.repeat(16)}`,
      siteId: 'e1111111-2222-4333-8444-555555555555',
      siteName: 'Dawie Boerdery',
      label: 'Main gate phone',
      enrolledAt: '2026-10-01T18:00:00.000Z'
    })
  );
  return storage;
}

const okFetch = (async () =>
  new Response(JSON.stringify({ ok: true, tokenHash: 'tok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch;

describe('PendingSignOut', () => {
  it('settles at once when nothing is running, waits for a running sign-out, and gives up after the limit', async () => {
    const pending = new PendingSignOut();
    assert.equal(await pending.settle(10), true);
    const call = deferred<{ error: null }>();
    pending.track(call.promise);
    assert.equal(pending.isPending, true);
    assert.equal(await pending.settle(20), false, 'still running after the limit');
    const waiting = pending.settle(5_000);
    call.resolve({ error: null });
    assert.equal(await waiting, true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(pending.isPending, false);
  });

  it('a failed sign-out also counts as settled', async () => {
    const pending = new PendingSignOut();
    pending.track(Promise.reject(new Error('offline')));
    assert.equal(await pending.settle(1_000), true);
  });
});

describe('hand-over race (regression)', () => {
  it('the new guard keeps their session: verifyOtp waits until the earlier sign-out has settled', async () => {
    const go = fakeGoTrue({ access_token: 'old-token', user: { id: OLD_GUARD } });
    // The previous guard signed out; the app stopped waiting after 5 s and the call still runs.
    const pending = new PendingSignOut();
    pending.track(go.client.auth.signOut());

    const signIn = signInGuardOnDevice(go.client, NEW_GUARD, {
      fetch: okFetch,
      storage: enrolledStorage(),
      isOffline: () => false,
      beforeSession: async () => {
        await pending.settle(5_000);
      }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!go.log.some((entry) => entry.startsWith('verifyOtp')), 'verifyOtp waits for the running sign-out');
    go.release();
    const result = await signIn;
    assert.deepEqual(result, { ok: true, userId: NEW_GUARD });
    assert.deepEqual(go.log, ['signOut:start', 'signOut:removedStoredSession', 'verifyOtp:tok']);
    assert.equal(go.stored()?.user.id, NEW_GUARD, 'the stale sign-out did not remove the new session');
  });

  it('what used to happen: a sign-out that settles after verifyOtp removes the new session', async () => {
    const go = fakeGoTrue({ access_token: 'old-token', user: { id: OLD_GUARD } });
    const staleSignOut = go.client.auth.signOut();
    // No waiting before verifyOtp (the old beforeSession raced signOut against 5 s and moved on).
    const result = await signInGuardOnDevice(go.client, NEW_GUARD, { fetch: okFetch, storage: enrolledStorage(), isOffline: () => false });
    assert.equal(result.ok, true);
    go.release();
    await staleSignOut;
    assert.equal(go.stored(), null, 'documents why the hand-over must never run a parallel signOut()');
  });

  it('hand-over without any signOut(): capture the old token, store the new session, then end the old one on the server only', async () => {
    const go = fakeGoTrue({ access_token: 'old-token', user: { id: OLD_GUARD } });
    const storage = enrolledStorage();
    storage.setItem(AUTH_CACHE_PREFIX + OLD_GUARD, '{"cached":"identity"}');
    storage.setItem(AUTH_CACHE_CURRENT_KEY, OLD_GUARD);
    let replaced: string | null = null;
    const result = await signInGuardOnDevice(go.client, NEW_GUARD, {
      fetch: okFetch,
      storage,
      isOffline: () => false,
      beforeSession: async () => {
        replaced = await captureSessionAccessToken(go.client, OLD_GUARD);
      }
    });
    assert.deepEqual(result, { ok: true, userId: NEW_GUARD });
    forgetReplacedUser(storage, OLD_GUARD, NEW_GUARD);
    assert.equal(await revokeReplacedSession(go.client, replaced), true);
    assert.deepEqual(go.log, ['getSession', 'verifyOtp:tok', 'admin.signOut:old-token:local']);
    assert.ok(!go.log.includes('signOut:start'), 'no client signOut() during a hand-over');
    assert.equal(go.stored()?.user.id, NEW_GUARD);
    assert.equal(storage.getItem(AUTH_CACHE_PREFIX + OLD_GUARD), null, 'previous identity cache dropped');
    assert.equal(storage.getItem(AUTH_CACHE_CURRENT_KEY), NEW_GUARD);
  });

  it('a refused tap leaves the signed-in guard untouched (nothing captured, revoked or removed)', async () => {
    const go = fakeGoTrue({ access_token: 'old-token', user: { id: OLD_GUARD } });
    let before = 0;
    const refused = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'guard_not_allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })) as typeof fetch;
    const result = await signInGuardOnDevice(go.client, NEW_GUARD, {
      fetch: refused,
      storage: enrolledStorage(),
      isOffline: () => false,
      beforeSession: async () => {
        before += 1;
      }
    });
    assert.deepEqual(result, { ok: false, error: 'not_allowed' });
    assert.equal(before, 0);
    assert.deepEqual(go.log, []);
    assert.equal(go.stored()?.user.id, OLD_GUARD);
  });
});

describe('captureSessionAccessToken / revokeReplacedSession / forgetReplacedUser', () => {
  it('captures only the session of the expected person, and never throws', async () => {
    const go = fakeGoTrue({ access_token: 'old-token', user: { id: OLD_GUARD } });
    assert.equal(await captureSessionAccessToken(go.client, OLD_GUARD), 'old-token');
    assert.equal(await captureSessionAccessToken(go.client, NEW_GUARD), null);
    assert.equal(await captureSessionAccessToken(fakeGoTrue(null).client, OLD_GUARD), null);
    const throwing = { auth: { getSession: async () => Promise.reject(new Error('boom')) } } as unknown as Pick<SupabaseClient, 'auth'>;
    assert.equal(await captureSessionAccessToken(throwing, OLD_GUARD), null);
    const hanging = { auth: { getSession: () => new Promise(() => undefined) } } as unknown as Pick<SupabaseClient, 'auth'>;
    assert.equal(await captureSessionAccessToken(hanging, OLD_GUARD, 20), null);
  });

  it('revoking is server-only, skipped without a token, and reports failures as false', async () => {
    const go = fakeGoTrue({ access_token: 'x', user: { id: OLD_GUARD } });
    assert.equal(await revokeReplacedSession(go.client, null), false);
    assert.deepEqual(go.log, []);
    const failing = {
      auth: { admin: { signOut: async () => ({ data: null, error: { status: 401, message: 'expired' } }) } }
    } as unknown as Pick<SupabaseClient, 'auth'>;
    assert.equal(await revokeReplacedSession(failing, 'tok'), false);
    const throwing = { auth: { admin: { signOut: async () => Promise.reject(new TypeError('Failed to fetch')) } } } as unknown as Pick<
      SupabaseClient,
      'auth'
    >;
    assert.equal(await revokeReplacedSession(throwing, 'tok'), false);
  });

  it('forgets only a different previous person', () => {
    const storage = new MemoryStorage();
    storage.setItem(AUTH_CACHE_PREFIX + OLD_GUARD, '{}');
    forgetReplacedUser(storage, OLD_GUARD, OLD_GUARD);
    assert.equal(storage.getItem(AUTH_CACHE_PREFIX + OLD_GUARD), '{}', 'same person: kept');
    forgetReplacedUser(storage, null, NEW_GUARD);
    forgetReplacedUser(storage, OLD_GUARD, NEW_GUARD);
    assert.equal(storage.getItem(AUTH_CACHE_PREFIX + OLD_GUARD), null);
  });
});
