import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import {
  AUTH_CACHE_CURRENT_KEY,
  PROFILE_COLUMNS,
  SITE_COLUMNS,
  clearIdentityCache,
  loadIdentity,
  mapSiteRow,
  pickActiveSite,
  readCurrentCachedUserId,
  readIdentityCache,
  writeIdentityCache,
  type KeyValueStorage
} from './identity';
import { DEFAULT_GUARD_LOGIN_DOMAIN, classifySignInError, loginToEmail, signIn } from './signIn';

const USER = { id: 'a1111111-2222-4333-8444-555555555555', email: 'wag1@guards.eagleeye.local' };
const ORG = '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c';

const profileRow = {
  id: USER.id,
  organisation_id: ORG,
  first_name: 'Sipho',
  last_name: 'Dlamini',
  employee_number: 'WAG1',
  phone_number: null,
  preferred_language: 'zu',
  is_active: true
};

const siteRows = [
  {
    id: 'e1111111-2222-4333-8444-555555555555',
    organisation_id: ORG,
    name: 'Dawie Boerdery',
    code: 'DB',
    address: null,
    latitude: '-25.684100',
    longitude: 27.8145,
    default_radius_meters: 40,
    day_shift_start: '06:00:00',
    day_shift_end: '18:00:00',
    night_shift_start: '18:00:00',
    night_shift_end: '06:00:00',
    round_interval_minutes: 45,
    emergency_phone: null,
    police_phone: null,
    whatsapp_dispatch_number: '27821234567',
    is_active: true,
    allow_legacy_qr: true
  }
];

type Response = { data: unknown; error: { message: string } | null; status?: number };

function fakeClient(responses: Record<string, Response>, selects: Record<string, string>) {
  const client = {
    from: (table: string) => ({
      select: (columns: string) => {
        selects[table] = columns;
        const result = Promise.resolve(responses[table]);
        return {
          eq: () => ({ maybeSingle: () => result, then: result.then.bind(result) }),
          order: () => result
        };
      }
    })
  };
  return client as unknown as Pick<SupabaseClient, 'from'>;
}

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  };
}

describe('loadIdentity', () => {
  it('loads profile, roles and sites with explicit columns and maps them to models', async () => {
    const selects: Record<string, string> = {};
    const result = await loadIdentity(
      fakeClient(
        {
          profiles: { data: profileRow, error: null },
          user_roles: { data: [{ role: 'guard' }, { role: 'not-a-role' }], error: null },
          sites: { data: siteRows, error: null }
        },
        selects
      ),
      USER,
      () => new Date('2026-09-30T18:00:00Z')
    );
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(selects.profiles, PROFILE_COLUMNS);
    assert.equal(selects.sites, SITE_COLUMNS);
    assert.doesNotMatch(selects.profiles, /\*|pin_hash/);
    assert.deepEqual(result.snapshot.roles, ['guard']);
    assert.equal(result.snapshot.profile.firstName, 'Sipho');
    assert.equal(result.snapshot.profile.preferredLanguage, 'zu');
    const [site] = result.snapshot.sites;
    assert.equal(site.latitude, -25.6841);
    assert.equal(site.defaultRadiusMeters, 40);
    assert.equal(site.nightShiftStart, '18:00');
    assert.equal(site.roundIntervalMinutes, 45);
    assert.equal(site.whatsappDispatchNumber, '27821234567');
    assert.equal(site.policePhone, '', 'no invented phone number');
    assert.equal(site.allowLegacyQr, true);
    assert.equal(mapSiteRow({ ...siteRows[0], allow_legacy_qr: null }).allowLegacyQr, false, 'unknown = not allowed');
  });

  it('reports a missing profile and a disabled account', async () => {
    const noProfile = await loadIdentity(fakeClient({ profiles: { data: null, error: null } }, {}), USER);
    assert.deepEqual(noProfile, { kind: 'no_profile' });
    const disabled = await loadIdentity(fakeClient({ profiles: { data: { ...profileRow, is_active: false }, error: null } }, {}), USER);
    assert.deepEqual(disabled, { kind: 'disabled' });
  });

  it('reports network failures as unavailable (never as signed out)', async () => {
    const result = await loadIdentity(
      fakeClient({ profiles: { data: null, error: { message: 'TypeError: fetch failed' }, status: 0 } }, {}),
      USER
    );
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.kind === 'unavailable' && result.network, true);
  });
});

describe('offline identity cache', () => {
  it('round-trips per user and points at the last user', async () => {
    const storage = memoryStorage();
    const loaded = await loadIdentity(
      fakeClient(
        {
          profiles: { data: profileRow, error: null },
          user_roles: { data: [{ role: 'guard' }], error: null },
          sites: { data: siteRows, error: null }
        },
        {}
      ),
      USER
    );
    assert.equal(loaded.kind, 'ok');
    if (loaded.kind !== 'ok') return;
    writeIdentityCache(storage, loaded.snapshot);
    assert.equal(readCurrentCachedUserId(storage), USER.id);
    // Stored as JSON: optional members that were undefined are simply absent.
    assert.deepEqual(readIdentityCache(storage, USER.id), JSON.parse(JSON.stringify(loaded.snapshot)));
    assert.equal(readIdentityCache(storage, 'someone-else'), null);

    clearIdentityCache(storage, USER.id);
    assert.equal(readIdentityCache(storage, USER.id), null);
    assert.equal(storage.map.has(AUTH_CACHE_CURRENT_KEY), false);
  });

  it('rejects tampered or inconsistent cache entries', () => {
    const storage = memoryStorage();
    storage.setItem(`ee.authcache.${USER.id}`, JSON.stringify({ user: { id: 'other' }, profile: { id: USER.id }, roles: [], sites: [] }));
    assert.equal(readIdentityCache(storage, USER.id), null);
    storage.setItem(`ee.authcache.${USER.id}`, '{not json');
    assert.equal(readIdentityCache(storage, USER.id), null);
  });

  it('keeps the chosen active site while it is visible, otherwise the first active one', () => {
    const sites = [mapSiteRow({ ...siteRows[0], id: 'x1', is_active: false }), mapSiteRow({ ...siteRows[0], id: 'x2' })];
    assert.equal(pickActiveSite(sites, 'x1')?.id, 'x1');
    assert.equal(pickActiveSite(sites, 'gone')?.id, 'x2');
    assert.equal(pickActiveSite([], null), null);
  });
});

describe('signIn', () => {
  it('maps a guard login without "@" to the guard login domain', () => {
    assert.equal(loginToEmail(' WAG1 '), `wag1@${DEFAULT_GUARD_LOGIN_DOMAIN}`);
    assert.equal(loginToEmail('wag1', 'farm.example'), 'wag1@farm.example');
    assert.equal(loginToEmail('Admin@Aiguille.co.za'), 'admin@aiguille.co.za');
    assert.equal(loginToEmail(''), null);
    assert.equal(loginToEmail('two words'), null);
  });

  it('uses Supabase signInWithPassword and reports failures truthfully', async () => {
    const calls: Array<{ email: string; password: string }> = [];
    const make = (outcome: unknown) =>
      ({
        auth: {
          signInWithPassword: async (credentials: { email: string; password: string }) => {
            calls.push(credentials);
            if (outcome instanceof Error) return { data: { user: null, session: null }, error: outcome };
            return outcome;
          }
        }
      }) as unknown as Pick<SupabaseClient, 'auth'>;

    const ok = await signIn('wag1', 'secret', make({ data: { user: { id: USER.id }, session: { access_token: 't' } }, error: null }));
    assert.deepEqual(ok, { ok: true, userId: USER.id });
    assert.deepEqual(calls[0], { email: `wag1@${DEFAULT_GUARD_LOGIN_DOMAIN}`, password: 'secret' });

    const wrong = await signIn('wag1', 'nope', make(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')));
    assert.equal(wrong.ok === false && wrong.reason, 'invalid_credentials');

    const offline = await signIn('wag1', 'secret', make(new AuthRetryableFetchError('fetch failed', 0)));
    assert.equal(offline.ok === false && offline.reason, 'network');

    const empty = await signIn('wag1', '', make({}));
    assert.equal(empty.ok === false && empty.reason, 'invalid_input');
    assert.equal(calls.length, 3, 'no request without a password');
  });

  it('tells rate limiting, unconfirmed and blocked accounts apart from a lost connection', () => {
    const reason = (error: unknown) => {
      const result = classifySignInError(error);
      return result.ok ? 'ok' : result.reason;
    };
    assert.equal(reason(new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit')), 'rate_limited');
    assert.equal(reason(new AuthApiError('Too many requests', 429, undefined)), 'rate_limited');
    assert.equal(reason(new AuthApiError('Email not confirmed', 400, 'email_not_confirmed')), 'not_activated');
    assert.equal(reason(new AuthApiError('User is banned', 400, 'user_banned')), 'account_blocked');
    assert.equal(reason(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')), 'invalid_credentials');
    assert.equal(reason(new AuthApiError('Invalid login credentials', 400, undefined)), 'invalid_credentials');
    assert.equal(reason(new AuthRetryableFetchError('Failed to fetch', 0)), 'network');
    assert.equal(reason(new AuthRetryableFetchError('Bad gateway', 502)), 'network');
    assert.equal(reason(new TypeError('Failed to fetch')), 'network');
    assert.equal(reason(new AuthApiError('Database error querying schema', 500, 'unexpected_failure')), 'network');
    const other = classifySignInError(new AuthApiError('Signups not allowed', 422, 'signup_disabled'));
    assert.deepEqual(other, { ok: false, reason: 'error', message: 'Signups not allowed' });
    const limited = classifySignInError(new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit'));
    assert.match(limited.ok ? '' : limited.message, /Wait a minute/);
  });

  it('records the signed-in account as the session holder only on success', async () => {
    const storage = memoryStorage();
    storage.setItem(AUTH_CACHE_CURRENT_KEY, 'previous-user');
    const failing = {
      auth: { signInWithPassword: async () => ({ data: { user: null, session: null }, error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials') }) }
    } as unknown as Pick<SupabaseClient, 'auth'>;
    await signIn('wag1', 'nope', failing, storage);
    assert.equal(readCurrentCachedUserId(storage), 'previous-user');
    const ok = {
      auth: { signInWithPassword: async () => ({ data: { user: { id: USER.id }, session: { access_token: 't' } }, error: null }) }
    } as unknown as Pick<SupabaseClient, 'auth'>;
    await signIn('wag1', 'secret', ok, storage);
    assert.equal(readCurrentCachedUserId(storage), USER.id);
  });
});
