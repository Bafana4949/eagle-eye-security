import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_CACHE_CURRENT_KEY, readActiveSiteId, type KeyValueStorage } from './identity';
import {
  DEVICE_LOGIN_PATH,
  DEVICE_REQUEST_TIMEOUT_MS,
  DEVICE_ROSTER_PATH,
  DEVICE_SIGN_IN_CHECK_MS,
  ENROLLED_NOTE_KEY,
  PATROL_DEVICE_STORAGE_KEY,
  clearDeviceSignIn,
  clearPatrolDevice,
  enrolThisPhone,
  fetchDeviceRoster,
  isFreshDeviceSignIn,
  isManagerAccount,
  loadPatrolDevice,
  markDeviceSignIn,
  parsePatrolDevice,
  removeThisPhoneEnrolment,
  revokePatrolDevice,
  saveEnrolledNote,
  savePatrolDevice,
  signInGuardOnDevice,
  takeEnrolledNote,
  type PatrolDevice
} from './patrolDevice';

const SECRET = `EED-${'ab12'.repeat(16)}`;
const DEVICE_ID = 'd1111111-2222-4333-8444-555555555555';
const SITE_ID = 'e1111111-2222-4333-8444-555555555555';
const GUARD_ID = 'a1111111-2222-4333-8444-555555555555';
const OTHER_GUARD_ID = 'a2222222-2222-4333-8444-555555555555';

const DEVICE: PatrolDevice = {
  deviceId: DEVICE_ID,
  secret: SECRET,
  siteId: SITE_ID,
  siteName: 'Dawie Boerdery',
  label: 'Main gate phone',
  enrolledAt: '2026-10-01T18:00:00.000Z'
};

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

/** Storage that throws on every access (blocked site data, private mode, quota). */
const throwingStorage: KeyValueStorage = {
  getItem() {
    throw new Error('SecurityError: storage blocked');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError: storage blocked');
  }
};

function enrolledStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(PATROL_DEVICE_STORAGE_KEY, JSON.stringify(DEVICE));
  return storage;
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(answer: { status: number; body?: unknown; text?: string } | 'network') {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ url: String(input), init: init ?? {}, body });
    if (answer === 'network') throw new TypeError('Failed to fetch');
    const payload = answer.text ?? JSON.stringify(answer.body ?? null);
    return new Response(payload, { status: answer.status, headers: { 'Content-Type': answer.text ? 'text/html' : 'application/json' } });
  }) as typeof fetch;
  return { impl, requests };
}

function fakeAuth(
  result: { data: { session: unknown; user: unknown }; error: unknown } = {
    data: { session: { access_token: 'x', user: { id: GUARD_ID } }, user: { id: GUARD_ID } },
    error: null
  }
) {
  const calls: { verifyOtp: unknown[]; signOut: unknown[] } = { verifyOtp: [], signOut: [] };
  const client = {
    auth: {
      async verifyOtp(params: unknown) {
        calls.verifyOtp.push(params);
        return result;
      },
      async signOut(params: unknown) {
        calls.signOut.push(params);
        return { error: null };
      }
    }
  };
  return { client: client as unknown as Pick<SupabaseClient, 'auth'>, calls };
}

function fakeRpc(responses: Record<string, { data: unknown; error: unknown; status?: number }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return responses[fn] ?? { data: null, error: { code: 'PGRST202', message: 'unknown function' }, status: 404 };
    }
  };
  return { client: client as unknown as Pick<SupabaseClient, 'rpc'>, calls };
}

const online = () => false;

describe('patrol phone enrolment storage', () => {
  it('round-trips the enrolment under ee.patrolDevice and clears it', () => {
    const storage = new MemoryStorage();
    assert.equal(loadPatrolDevice(storage), null);
    assert.equal(savePatrolDevice(DEVICE, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(PATROL_DEVICE_STORAGE_KEY) ?? 'null'), DEVICE);
    assert.deepEqual(loadPatrolDevice(storage), DEVICE);
    clearPatrolDevice(storage);
    assert.equal(storage.getItem(PATROL_DEVICE_STORAGE_KEY), null);
    assert.equal(loadPatrolDevice(storage), null);
  });

  it('treats malformed or tampered values as not enrolled', () => {
    assert.equal(parsePatrolDevice('not json'), null);
    assert.equal(parsePatrolDevice(JSON.stringify({ ...DEVICE, secret: 'EED-short' })), null);
    assert.equal(parsePatrolDevice(JSON.stringify({ ...DEVICE, secret: SECRET.toUpperCase() })), null);
    assert.equal(parsePatrolDevice(JSON.stringify({ ...DEVICE, deviceId: 'x' })), null);
    assert.equal(parsePatrolDevice(JSON.stringify({ ...DEVICE, label: '  ' })), null);
    assert.equal(parsePatrolDevice(JSON.stringify(null)), null);
    // Extra fields (e.g. an e-mail someone added by hand) are dropped.
    assert.deepEqual(parsePatrolDevice(JSON.stringify({ ...DEVICE, email: 'x@example.com' })), DEVICE);
  });

  it('refuses to store an invalid enrolment', () => {
    const storage = new MemoryStorage();
    assert.equal(savePatrolDevice({ ...DEVICE, secret: 'hunter2' }, storage), false);
    assert.equal(storage.getItem(PATROL_DEVICE_STORAGE_KEY), null);
  });

  it('is tolerant of storage exceptions and missing storage', () => {
    assert.equal(loadPatrolDevice(throwingStorage), null);
    assert.equal(savePatrolDevice(DEVICE, throwingStorage), false);
    assert.doesNotThrow(() => clearPatrolDevice(throwingStorage));
    assert.equal(loadPatrolDevice(null), null);
    assert.equal(savePatrolDevice(DEVICE, null), false);
    assert.doesNotThrow(() => clearPatrolDevice(null));
  });
});

describe('fetchDeviceRoster', () => {
  it('reports not_enrolled without contacting the server when this phone has no enrolment', async () => {
    const { impl, requests } = fakeFetch({ status: 200, body: {} });
    const result = await fetchDeviceRoster({ fetch: impl, storage: new MemoryStorage(), isOffline: online });
    assert.deepEqual(result, { ok: false, error: 'not_enrolled' });
    assert.equal(requests.length, 0);
  });

  it('reports offline without a request when the phone has no connection', async () => {
    const { impl, requests } = fakeFetch({ status: 200, body: {} });
    const result = await fetchDeviceRoster({ fetch: impl, storage: enrolledStorage(), isOffline: () => true });
    assert.deepEqual(result, { ok: false, error: 'offline' });
    assert.equal(requests.length, 0);
  });

  it('sends only the device secret and returns the site roster', async () => {
    const storage = enrolledStorage();
    const { impl, requests } = fakeFetch({
      status: 200,
      body: {
        ok: true,
        device: { id: DEVICE_ID, label: 'Main gate phone' },
        site: { id: SITE_ID, name: 'Dawie Boerdery' },
        guards: [
          { id: GUARD_ID, firstName: 'Sipho', lastName: 'Dlamini' },
          { id: 'not-a-uuid', firstName: 'Bad', lastName: 'Row' },
          { id: OTHER_GUARD_ID, firstName: 'Annelie', lastName: 'Botha' }
        ]
      }
    });
    const result = await fetchDeviceRoster({ fetch: impl, storage, isOffline: online });
    assert.deepEqual(result, {
      ok: true,
      device: { id: DEVICE_ID, label: 'Main gate phone' },
      site: { id: SITE_ID, name: 'Dawie Boerdery' },
      guards: [
        { id: GUARD_ID, firstName: 'Sipho', lastName: 'Dlamini' },
        { id: OTHER_GUARD_ID, firstName: 'Annelie', lastName: 'Botha' }
      ]
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, DEVICE_ROSTER_PATH);
    assert.equal(requests[0].init.method, 'POST');
    assert.deepEqual(requests[0].body, { deviceSecret: SECRET });
  });

  it('updates the stored site name when the server reports a new one', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({
      status: 200,
      body: { ok: true, device: { id: DEVICE_ID, label: 'Main gate phone' }, site: { id: SITE_ID, name: 'Dawie Boerdery Noord' }, guards: [] }
    });
    const result = await fetchDeviceRoster({ fetch: impl, storage, isOffline: online });
    assert.equal(result.ok, true);
    assert.equal(loadPatrolDevice(storage)?.siteName, 'Dawie Boerdery Noord');
    assert.equal(loadPatrolDevice(storage)?.secret, SECRET);
  });

  it('clears the local enrolment on 401 and reports not_enrolled', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({ status: 401, body: { ok: false, error: 'device_not_enrolled' } });
    const result = await fetchDeviceRoster({ fetch: impl, storage, isOffline: online });
    assert.deepEqual(result, { ok: false, error: 'not_enrolled' });
    assert.equal(storage.getItem(PATROL_DEVICE_STORAGE_KEY), null);
  });

  it('keeps the enrolment when a 401 did not come from the API (e.g. a captive portal page)', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({ status: 401, text: '<html>Wi-Fi login</html>' });
    const result = await fetchDeviceRoster({ fetch: impl, storage, isOffline: online });
    assert.deepEqual(result, { ok: false, error: 'failed' });
    assert.deepEqual(loadPatrolDevice(storage), DEVICE);
  });

  it('maps server_not_configured, network failures and bad answers honestly', async () => {
    const cases: Array<[Parameters<typeof fakeFetch>[0], string]> = [
      [{ status: 503, body: { ok: false, error: 'server_not_configured' } }, 'server_not_configured'],
      [{ status: 503, text: 'Service Unavailable' }, 'failed'],
      [{ status: 502, body: { ok: false, error: 'session_failed' } }, 'failed'],
      [{ status: 200, body: { ok: true } }, 'failed'],
      [{ status: 200, body: { ok: false, error: 'x' } }, 'failed'],
      ['network', 'offline']
    ];
    for (const [answer, expected] of cases) {
      const storage = enrolledStorage();
      const { impl } = fakeFetch(answer);
      const result = await fetchDeviceRoster({ fetch: impl, storage, isOffline: online });
      assert.deepEqual(result, { ok: false, error: expected }, JSON.stringify(answer));
      assert.deepEqual(loadPatrolDevice(storage), DEVICE, 'the enrolment is kept');
    }
  });
});

describe('signInGuardOnDevice', () => {
  it('posts the device secret + guard id, then verifies the token hash as a magic link', async () => {
    const storage = enrolledStorage();
    const { impl, requests } = fakeFetch({ status: 200, body: { ok: true, tokenHash: 'hashed-token-123' } });
    const { client, calls } = fakeAuth();
    const order: string[] = [];
    const result = await signInGuardOnDevice(client, GUARD_ID, {
      fetch: impl,
      storage,
      isOffline: online,
      beforeSession: async () => {
        order.push(`beforeSession after ${requests.length} request(s), ${calls.verifyOtp.length} verify`);
      }
    });

    assert.deepEqual(result, { ok: true, userId: GUARD_ID });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, DEVICE_LOGIN_PATH);
    assert.deepEqual(requests[0].body, { deviceSecret: SECRET, guardId: GUARD_ID });
    assert.deepEqual(calls.verifyOtp, [{ token_hash: 'hashed-token-123', type: 'magiclink' }]);
    assert.deepEqual(order, ['beforeSession after 1 request(s), 0 verify']);
    // This account now holds the phone's session and opens on the phone's site.
    assert.equal(storage.getItem(AUTH_CACHE_CURRENT_KEY), GUARD_ID);
    assert.equal(readActiveSiteId(storage, GUARD_ID), SITE_ID);
  });

  it('never sends an e-mail address or a password', async () => {
    const storage = enrolledStorage();
    const { impl, requests } = fakeFetch({ status: 200, body: { ok: true, tokenHash: 'h' } });
    const { client, calls } = fakeAuth();
    await signInGuardOnDevice(client, GUARD_ID, { fetch: impl, storage, isOffline: online });
    const sent = JSON.stringify(requests.map((r) => ({ url: r.url, headers: r.init.headers, body: r.body })));
    assert.doesNotMatch(sent, /@|email|e-mail|password/i);
    assert.deepEqual(Object.keys(requests[0].body).sort(), ['deviceSecret', 'guardId']);
    for (const params of calls.verifyOtp) {
      assert.deepEqual(Object.keys(params as object).sort(), ['token_hash', 'type']);
    }
  });

  it('does not create a session when the server refuses the guard', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({ status: 403, body: { ok: false, error: 'guard_not_allowed' } });
    const { client, calls } = fakeAuth();
    let before = 0;
    const result = await signInGuardOnDevice(client, GUARD_ID, {
      fetch: impl,
      storage,
      isOffline: online,
      beforeSession: async () => {
        before += 1;
      }
    });
    assert.deepEqual(result, { ok: false, error: 'not_allowed' });
    assert.equal(calls.verifyOtp.length, 0);
    assert.equal(before, 0, 'the signed-in user is not signed out for a refused guard');
    assert.deepEqual(loadPatrolDevice(storage), DEVICE);
  });

  it('clears the enrolment on 401', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({ status: 401, body: { ok: false, error: 'device_not_enrolled' } });
    const { client, calls } = fakeAuth();
    const result = await signInGuardOnDevice(client, GUARD_ID, { fetch: impl, storage, isOffline: online });
    assert.deepEqual(result, { ok: false, error: 'not_enrolled' });
    assert.equal(loadPatrolDevice(storage), null);
    assert.equal(calls.verifyOtp.length, 0);
  });

  it('reports failed (never success) without a token hash, and offline on a network error', async () => {
    for (const [answer, expected] of [
      [{ status: 200, body: { ok: true } }, 'failed'],
      [{ status: 200, body: { ok: true, fallback: true } }, 'failed'],
      [{ status: 502, body: { ok: false, error: 'session_failed' } }, 'failed'],
      [{ status: 503, body: { ok: false, error: 'server_not_configured' } }, 'server_not_configured'],
      ['network', 'offline']
    ] as const) {
      const { impl } = fakeFetch(answer);
      const { client, calls } = fakeAuth();
      const result = await signInGuardOnDevice(client, GUARD_ID, { fetch: impl, storage: enrolledStorage(), isOffline: online });
      assert.deepEqual(result, { ok: false, error: expected }, JSON.stringify(answer));
      assert.equal(calls.verifyOtp.length, 0);
    }
  });

  it('refuses without a request when not enrolled, offline, or given a non-uuid guard id', async () => {
    const { impl, requests } = fakeFetch({ status: 200, body: { ok: true, tokenHash: 'h' } });
    const { client } = fakeAuth();
    assert.deepEqual(await signInGuardOnDevice(client, GUARD_ID, { fetch: impl, storage: new MemoryStorage(), isOffline: online }), {
      ok: false,
      error: 'not_enrolled'
    });
    assert.deepEqual(await signInGuardOnDevice(client, GUARD_ID, { fetch: impl, storage: enrolledStorage(), isOffline: () => true }), {
      ok: false,
      error: 'offline'
    });
    assert.deepEqual(await signInGuardOnDevice(client, 'sipho@example.com', { fetch: impl, storage: enrolledStorage(), isOffline: online }), {
      ok: false,
      error: 'failed'
    });
    assert.equal(requests.length, 0);
  });

  it('reports a failed verifyOtp and drops a session that belongs to someone else', async () => {
    const storage = enrolledStorage();
    const { impl } = fakeFetch({ status: 200, body: { ok: true, tokenHash: 'h' } });

    const rejected = fakeAuth({ data: { session: null, user: null }, error: { status: 403, code: 'otp_expired', message: 'expired' } });
    assert.deepEqual(await signInGuardOnDevice(rejected.client, GUARD_ID, { fetch: impl, storage, isOffline: online }), {
      ok: false,
      error: 'failed'
    });

    const wrongUser = fakeAuth({
      data: { session: { access_token: 'x', user: { id: OTHER_GUARD_ID } }, user: { id: OTHER_GUARD_ID } },
      error: null
    });
    assert.deepEqual(await signInGuardOnDevice(wrongUser.client, GUARD_ID, { fetch: impl, storage, isOffline: online }), {
      ok: false,
      error: 'failed'
    });
    assert.deepEqual(wrongUser.calls.signOut, [{ scope: 'local' }]);
    assert.equal(storage.getItem(AUTH_CACHE_CURRENT_KEY), null);
  });
});

describe('enrolThisPhone / revokePatrolDevice', () => {
  const enrolAnswer = {
    data: { device_id: DEVICE_ID, device_secret: SECRET, site_id: SITE_ID, site_name: 'Dawie Boerdery', label: 'Main gate phone' },
    error: null,
    status: 200
  };

  it('enrols through the RPC with the trimmed label and stores the secret on this phone', async () => {
    const storage = new MemoryStorage();
    const { client, calls } = fakeRpc({ enrol_patrol_device: enrolAnswer });
    const result = await enrolThisPhone(client, SITE_ID, '  Main gate phone ', storage, () => new Date(DEVICE.enrolledAt));
    assert.deepEqual(result, { ok: true, device: DEVICE });
    assert.deepEqual(calls, [{ fn: 'enrol_patrol_device', args: { p_site_id: SITE_ID, p_label: 'Main gate phone' } }]);
    assert.deepEqual(loadPatrolDevice(storage), DEVICE);
  });

  it('validates the label before calling the server', async () => {
    const { client, calls } = fakeRpc({ enrol_patrol_device: enrolAnswer });
    assert.deepEqual(await enrolThisPhone(client, SITE_ID, '   ', new MemoryStorage()), { ok: false, error: 'invalid_label' });
    assert.deepEqual(await enrolThisPhone(client, SITE_ID, 'x'.repeat(81), new MemoryStorage()), { ok: false, error: 'invalid_label' });
    assert.equal(calls.length, 0);
  });

  it('reports a refusal (42501) as not_allowed and stores nothing', async () => {
    const storage = new MemoryStorage();
    const { client } = fakeRpc({ enrol_patrol_device: { data: null, error: { code: '42501', message: 'not allowed' }, status: 403 } });
    const result = await enrolThisPhone(client, SITE_ID, 'Gate', storage);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, 'not_allowed');
    assert.equal(loadPatrolDevice(storage), null);
  });

  it('revokes the new entry again when this browser cannot keep the secret', async () => {
    const { client, calls } = fakeRpc({ enrol_patrol_device: enrolAnswer, revoke_patrol_device: { data: null, error: null, status: 204 } });
    const result = await enrolThisPhone(client, SITE_ID, 'Gate', throwingStorage);
    assert.deepEqual(result, { ok: false, error: 'storage_unavailable' });
    assert.deepEqual(
      calls.map((c) => c.fn),
      ['enrol_patrol_device', 'revoke_patrol_device']
    );
    assert.deepEqual(calls[1].args, { p_device_id: DEVICE_ID });
  });

  it('revoking this phone also forgets its local enrolment; another phone leaves it alone', async () => {
    const storage = enrolledStorage();
    const { client, calls } = fakeRpc({ revoke_patrol_device: { data: null, error: null, status: 204 } });
    assert.deepEqual(await revokePatrolDevice(client, 'd2222222-2222-4333-8444-555555555555', storage), { ok: true });
    assert.deepEqual(loadPatrolDevice(storage), DEVICE);
    assert.deepEqual(await revokePatrolDevice(client, DEVICE_ID, storage), { ok: true });
    assert.equal(loadPatrolDevice(storage), null);
    assert.equal(calls.length, 2);
  });
});

describe('slow server vs no connection', () => {
  /** A fetch that never answers, but honours the abort signal like the real one. */
  const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    })) as typeof fetch;

  it('a request that is still unanswered at the deadline is "timeout", not "offline"', async () => {
    const roster = await fetchDeviceRoster({ fetch: hangingFetch, storage: enrolledStorage(), isOffline: online, timeoutMs: 20 });
    assert.deepEqual(roster, { ok: false, error: 'timeout' });
    const { client, calls } = fakeAuth();
    const storage = enrolledStorage();
    const login = await signInGuardOnDevice(client, GUARD_ID, { fetch: hangingFetch, storage, isOffline: online, timeoutMs: 20 });
    assert.deepEqual(login, { ok: false, error: 'timeout' });
    assert.equal(calls.verifyOtp.length, 0);
    assert.deepEqual(loadPatrolDevice(storage), DEVICE, 'a slow server never wipes the enrolment');
  });

  it('the phone waits longer than the server can take (two upstream calls of 15 s)', () => {
    assert.ok(DEVICE_REQUEST_TIMEOUT_MS > 2 * 15_000, `${DEVICE_REQUEST_TIMEOUT_MS} ms`);
  });
});

describe('removeThisPhoneEnrolment', () => {
  it('revokes the server entry and forgets the secret', async () => {
    const storage = enrolledStorage();
    const { client, calls } = fakeRpc({ revoke_patrol_device: { data: null, error: null, status: 204 } });
    assert.deepEqual(await removeThisPhoneEnrolment(client, storage), { revoked: true });
    assert.deepEqual(calls, [{ fn: 'revoke_patrol_device', args: { p_device_id: DEVICE_ID } }]);
    assert.equal(loadPatrolDevice(storage), null);
  });

  it('without a connection (no client) or when refused, the local copy is still removed and the result says "not revoked"', async () => {
    const offline = enrolledStorage();
    assert.deepEqual(await removeThisPhoneEnrolment(null, offline), { revoked: false, error: 'offline' });
    assert.equal(loadPatrolDevice(offline), null);

    const refusedStorage = enrolledStorage();
    const { client } = fakeRpc({ revoke_patrol_device: { data: null, error: { code: '42501', message: 'no' }, status: 403 } });
    assert.deepEqual(await removeThisPhoneEnrolment(client, refusedStorage), { revoked: false, error: 'not_allowed' });
    assert.equal(loadPatrolDevice(refusedStorage), null);

    assert.deepEqual(await removeThisPhoneEnrolment(client, new MemoryStorage()), { revoked: false }, 'not enrolled: nothing to do');
  });
});

describe('notes for the next screen and manager accounts', () => {
  it('"Signed in as … – not you?" is offered for one minute after a tap, for that guard only', () => {
    const storage = new MemoryStorage();
    markDeviceSignIn(GUARD_ID, 1_000, storage);
    assert.equal(isFreshDeviceSignIn(GUARD_ID, 1_000 + DEVICE_SIGN_IN_CHECK_MS - 1, storage), true);
    assert.equal(isFreshDeviceSignIn(GUARD_ID, 1_000 + DEVICE_SIGN_IN_CHECK_MS, storage), false);
    assert.equal(isFreshDeviceSignIn(OTHER_GUARD_ID, 1_001, storage), false);
    assert.equal(isFreshDeviceSignIn(null, 1_001, storage), false);
    clearDeviceSignIn(storage);
    assert.equal(isFreshDeviceSignIn(GUARD_ID, 1_001, storage), false);
    assert.equal(isFreshDeviceSignIn(GUARD_ID, 1_001, throwingStorage), false);
    markDeviceSignIn(GUARD_ID, 1_000, throwingStorage); // never throws
  });

  it('the enrolment confirmation is read once', () => {
    const storage = new MemoryStorage();
    saveEnrolledNote({ siteName: 'Dawie Boerdery', oldRevokeFailed: true }, storage);
    assert.deepEqual(takeEnrolledNote(storage), { siteName: 'Dawie Boerdery', oldRevokeFailed: true });
    assert.equal(takeEnrolledNote(storage), null);
    storage.setItem(ENROLLED_NOTE_KEY, '{not json');
    assert.equal(takeEnrolledNote(storage), null);
    assert.equal(takeEnrolledNote(throwingStorage), null);
  });

  it('admins, super admins and supervisors are manager accounts; guards and viewers are not', () => {
    assert.equal(isManagerAccount(['guard']), false);
    assert.equal(isManagerAccount(['client_viewer']), false);
    assert.equal(isManagerAccount([]), false);
    for (const role of ['admin', 'super_admin', 'supervisor'] as const) assert.equal(isManagerAccount(['guard', role]), true, role);
  });
});
