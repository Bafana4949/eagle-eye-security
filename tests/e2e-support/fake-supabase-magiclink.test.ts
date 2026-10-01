/**
 * Verifies the fake Supabase server's service-role magic-link support with the REAL
 * @supabase/supabase-js client over HTTP (no browser, no Next.js):
 *   - POST /auth/v1/admin/generate_link: service role only, existing accounts only, GoTrue shape
 *     (auth-js exposes data.properties.hashed_token);
 *   - POST /auth/v1/verify { token_hash, type: 'magiclink' | 'email' }: a real session, single
 *     use, only the newest link, short expiry, banned accounts refused;
 *   - RPC calls made with the service-role key run as the database role service_role, so
 *     "service-role only" EXECUTE grants are genuinely enforced (anon / users are refused);
 *   - when supabase/migrations/20261001000200_patrol_devices.sql is present: the whole
 *     patrol-phone chain (enrol_patrol_device → device_roster → device_guard_login →
 *     generate_link → verifyOtp) against the real migration.
 *
 *   npx tsx --test tests/e2e-support/fake-supabase-magiclink.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MIGRATIONS_DIR } from '../db/harness';
import { TEST_ANON_KEY, TEST_CONTROL_HEADER, TEST_CONTROL_TOKEN, TEST_SERVICE_ROLE_KEY } from './constants';
import type { E2EFixture, E2EUserKey } from './fixture';
import { startFakeSupabase, type FakeSupabaseServer } from './fake-supabase/server';
import { retryFetch } from './netRetry';

const PATROL_MIGRATION = path.join(MIGRATIONS_DIR, '20261001000200_patrol_devices.sql');
const hasPatrolMigration = existsSync(PATROL_MIGRATION);

let fake: FakeSupabaseServer;
let fixture: E2EFixture;

function client(key: string = TEST_ANON_KEY): SupabaseClient {
  return createClient(fake.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: retryFetch }
  });
}

const service = (): SupabaseClient => client(TEST_SERVICE_ROLE_KEY);

async function signedIn(user: E2EUserKey): Promise<SupabaseClient> {
  const supabase = client();
  const u = fixture.users[user];
  const { error } = await supabase.auth.signInWithPassword({ email: u.email, password: u.password });
  assert.equal(error, null, `sign-in ${user}: ${error?.message}`);
  return supabase;
}

async function control<T>(controlPath: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await retryFetch(`${fake.url}/__test/${controlPath}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { [TEST_CONTROL_HEADER]: TEST_CONTROL_TOKEN, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/__test/${controlPath} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await control<{ rows: T[] }>('sql', { body: { sql: query, params } })).rows;
}

async function mint(email: string): Promise<string> {
  const { data, error } = await service().auth.admin.generateLink({ type: 'magiclink', email });
  assert.equal(error, null, `generateLink ${email}: ${error?.message}`);
  const hash = data.properties?.hashed_token;
  assert.ok(hash, 'hashed_token');
  return hash;
}

async function resetFake(): Promise<void> {
  fixture = (await control<{ fixture: E2EFixture }>('reset', { body: {} })).fixture;
}

before(async () => {
  fake = await startFakeSupabase({ port: 0, quiet: true });
  await resetFake();
});

after(async () => {
  await fake?.close();
});

describe('fake Supabase: admin generate_link (magic links)', () => {
  beforeEach(resetFake);

  it('mints a GoTrue-shaped magic link for an existing account with the service-role key', async () => {
    const guard = fixture.users.guard;
    const { data, error } = await service().auth.admin.generateLink({ type: 'magiclink', email: guard.email });
    assert.equal(error, null);
    assert.equal(data.user?.id, guard.id);
    assert.equal(data.user?.email, guard.email);
    assert.equal(data.properties?.verification_type, 'magiclink');
    assert.match(data.properties?.hashed_token ?? '', /^[0-9a-f]{56}$/);
    assert.match(data.properties?.email_otp ?? '', /^\d{6}$/);
    assert.equal(
      data.properties?.hashed_token,
      createHash('sha224').update(`${guard.email}${data.properties?.email_otp}`).digest('hex'),
      'hashed_token = sha224(email + otp) like GoTrue'
    );
    const action = new URL(data.properties!.action_link);
    assert.equal(action.searchParams.get('token'), data.properties?.hashed_token);
    assert.equal(action.searchParams.get('type'), 'magiclink');

    const links = await control<{ magicLinks: Array<{ userId: string; used: boolean; expired: boolean }> }>('magiclinks');
    assert.deepEqual(
      links.magicLinks.map((l) => ({ userId: l.userId, used: l.used, expired: l.expired })),
      [{ userId: guard.id, used: false, expired: false }]
    );
    assert.equal(JSON.stringify(links).includes(data.properties!.hashed_token), false, 'the control API never echoes token material');
  });

  it('refuses the anon key, a signed-in user token, unknown accounts and other link types', async () => {
    const guard = fixture.users.guard;
    const anon = await client().auth.admin.generateLink({ type: 'magiclink', email: guard.email });
    assert.equal(anon.data.properties, null);
    assert.equal(anon.error?.status, 403);
    assert.equal(anon.error?.code, 'not_admin');

    const user = await signedIn('admin');
    const token = (await user.auth.getSession()).data.session!.access_token;
    const res = await retryFetch(`${fake.url}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: TEST_ANON_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email: guard.email })
    });
    assert.equal(res.status, 403, 'even an org admin user token is not the service role');
    assert.equal(((await res.json()) as { code?: string }).code, 'not_admin');

    const unknown = await service().auth.admin.generateLink({ type: 'magiclink', email: 'nobody@guards.test' });
    assert.equal(unknown.error?.status, 404);
    assert.equal(unknown.error?.code, 'user_not_found');

    const signup = await service().auth.admin.generateLink({ type: 'signup', email: 'new@guards.test', password: 'Whatever-123' });
    assert.equal(signup.error?.status, 400);
    assert.equal(signup.error?.code, 'validation_failed');

    const bad = await retryFetch(`${fake.url}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: TEST_SERVICE_ROLE_KEY, authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email: 'not-an-email' })
    });
    assert.equal(bad.status, 400);

    const links = await control<{ magicLinks: unknown[] }>('magiclinks');
    assert.equal(links.magicLinks.length, 0, 'no refused request minted a link');
  });

  it('verifyOtp({ token_hash, type: magiclink }) returns a real session for that user, exactly once', async () => {
    const guard = fixture.users.guard;
    const hash = await mint(guard.email);
    const phone = client();
    const first = await phone.auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    assert.equal(first.error, null, first.error?.message);
    assert.equal(first.data.user?.id, guard.id);
    assert.ok(first.data.session?.access_token);
    assert.ok(first.data.session?.refresh_token);

    // The session is genuine: Auth knows the user and PostgREST runs as that user under RLS.
    const me = await phone.auth.getUser();
    assert.equal(me.data.user?.id, guard.id);
    const profile = await phone.from('profiles').select('id, first_name').eq('id', guard.id).single();
    assert.equal(profile.error, null, profile.error?.message);
    assert.equal(profile.data?.first_name, guard.firstName);
    const sessions = await control<{ sessions: Array<{ userId: string; amr: Array<{ method: string }> }> }>('sessions');
    assert.deepEqual(
      sessions.sessions.filter((s) => s.userId === guard.id).map((s) => s.amr[0]?.method),
      ['magiclink']
    );

    const again = await client().auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    assert.equal(again.data.session, null);
    assert.equal(again.error?.status, 403);
    assert.equal(again.error?.code, 'otp_expired');
    const links = await control<{ magicLinks: Array<{ used: boolean }> }>('magiclinks');
    assert.deepEqual(links.magicLinks.map((l) => l.used), [true]);
  });

  it('accepts type "email" too, and refuses unknown or forged hashes and e-mail + OTP pairs', async () => {
    const guard2 = fixture.users.guard2;
    const hash = await mint(guard2.email);
    const forged = await client().auth.verifyOtp({ token_hash: randomBytes(28).toString('hex'), type: 'magiclink' });
    assert.equal(forged.error?.code, 'otp_expired');
    const recoveryType = await client().auth.verifyOtp({ token_hash: hash, type: 'recovery' });
    assert.equal(recoveryType.error?.code, 'otp_expired', 'a magic-link hash is not a recovery token');
    const otp = await client().auth.verifyOtp({ email: guard2.email, token: '123456', type: 'email' });
    assert.equal(otp.error?.status, 400);
    const ok = await client().auth.verifyOtp({ token_hash: hash, type: 'email' });
    assert.equal(ok.error, null, ok.error?.message);
    assert.equal(ok.data.user?.id, guard2.id);
  });

  it('only the newest link of a user works (a new link replaces the old one)', async () => {
    const guard = fixture.users.guard;
    const older = await mint(guard.email);
    const newer = await mint(guard.email);
    assert.notEqual(older, newer);
    const stale = await client().auth.verifyOtp({ token_hash: older, type: 'magiclink' });
    assert.equal(stale.error?.code, 'otp_expired');
    const fresh = await client().auth.verifyOtp({ token_hash: newer, type: 'magiclink' });
    assert.equal(fresh.error, null, fresh.error?.message);
    assert.equal(fresh.data.user?.id, guard.id);
  });

  it('expires links after the configured lifetime', async () => {
    await control('config', { body: { magicLinkTtlSeconds: 1 } });
    const hash = await mint(fixture.users.guard.email);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const late = await client().auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    assert.equal(late.error?.code, 'otp_expired');
    const links = await control<{ magicLinks: Array<{ expired: boolean; used: boolean }> }>('magiclinks');
    assert.deepEqual(links.magicLinks, [{ ...links.magicLinks[0], expired: true, used: false }]);
  });

  it('refuses banned accounts and links minted before an e-mail change', async () => {
    const guard = fixture.users.guard;
    const hash = await mint(guard.email);
    const ban = await service().auth.admin.updateUserById(guard.id, { ban_duration: '24h' });
    assert.equal(ban.error, null);
    const banned = await client().auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    assert.equal(banned.error?.code, 'user_banned');

    const guard2 = fixture.users.guard2;
    const before = await mint(guard2.email);
    const moved = await service().auth.admin.updateUserById(guard2.id, { email: 'moved-guard2@guards.test' });
    assert.equal(moved.error, null);
    const stale = await client().auth.verifyOtp({ token_hash: before, type: 'magiclink' });
    assert.equal(stale.error?.code, 'otp_expired');
  });
});

describe('fake Supabase: service-role RPC runs as the service_role database role', () => {
  before(async () => {
    await resetFake();
    await control('sql', {
      body: {
        multi: true,
        sql: `
          CREATE FUNCTION public.e2e_probe_service_only(p_text text) RETURNS jsonb
            LANGUAGE sql STABLE SET search_path = public, pg_temp
            AS $$ SELECT jsonb_build_object('role', current_user::text, 'echo', p_text) $$;
          REVOKE EXECUTE ON FUNCTION public.e2e_probe_service_only(text) FROM PUBLIC, anon, authenticated;
          GRANT EXECUTE ON FUNCTION public.e2e_probe_service_only(text) TO service_role;
          CREATE FUNCTION public.e2e_probe_null() RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
          CREATE FUNCTION public.e2e_probe_refuse() RETURNS jsonb LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'device_not_enrolled' USING ERRCODE = '42501';
          END $$;`
      }
    });
    await control('schema/reload', { body: {} });
  });

  after(resetFake);

  it('lets the service-role key execute a service-role-only function as service_role', async () => {
    const { data, error } = await service().rpc('e2e_probe_service_only', { p_text: 'hello' });
    assert.equal(error, null, error?.message);
    assert.deepEqual(data, { role: 'service_role', echo: 'hello' });
  });

  it('refuses the same function to anon (401) and to signed-in users (403)', async () => {
    const anon = await client().rpc('e2e_probe_service_only', { p_text: 'x' });
    assert.equal(anon.data, null);
    assert.equal(anon.error?.code, '42501');
    assert.equal(anon.status, 401);
    const admin = await signedIn('admin');
    const asUser = await admin.rpc('e2e_probe_service_only', { p_text: 'x' });
    assert.equal(asUser.error?.code, '42501');
    assert.equal(asUser.status, 403);
  });

  it('answers a NULL jsonb result as JSON null and passes RAISE ... ERRCODE 42501 through', async () => {
    const empty = await service().rpc('e2e_probe_null');
    assert.equal(empty.error, null);
    assert.equal(empty.status, 200);
    assert.equal(empty.data, null);
    const raw = await retryFetch(`${fake.url}/rest/v1/rpc/e2e_probe_null`, {
      method: 'POST',
      headers: { apikey: TEST_SERVICE_ROLE_KEY, authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(await raw.text(), 'null');

    const refused = await service().rpc('e2e_probe_refuse');
    assert.equal(refused.status, 403);
    assert.equal(refused.error?.code, '42501');
    assert.equal(refused.error?.message, 'device_not_enrolled');
  });

  it('a reset restores the migrated schema cache (ad-hoc functions disappear)', async () => {
    await resetFake();
    const gone = await service().rpc('e2e_probe_null');
    assert.equal(gone.status, 404);
    assert.equal(gone.error?.code, 'PGRST202');
  });
});

describe('fake Supabase: patrol-phone chain on the real migration', { skip: hasPatrolMigration ? false : 'patrol_devices migration not present yet' }, () => {
  beforeEach(resetFake);

  it('enrol (supervisor) → roster + guard login (service role only) → magic link → guard session', async () => {
    const supervisor = await signedIn('supervisor');
    const enrolled = await supervisor.rpc('enrol_patrol_device', { p_site_id: fixture.siteA.id, p_label: '  Gate phone  ' });
    assert.equal(enrolled.error, null, enrolled.error?.message);
    const device = enrolled.data as { device_id: string; device_secret: string; site_id: string; site_name: string; label: string };
    assert.match(device.device_secret, /^EED-[0-9a-f]{64}$/);
    assert.equal(device.site_id, fixture.siteA.id);
    assert.equal(device.site_name, fixture.siteA.name);
    assert.equal(device.label, 'Gate phone');
    const stored = await sql<{ secret_sha256: string }>(`SELECT secret_sha256 FROM public.patrol_devices WHERE id = $1`, [device.device_id]);
    assert.equal(stored[0]?.secret_sha256, createHash('sha256').update(device.device_secret).digest('hex'));

    // Service-role-only functions: anon and signed-in users are refused.
    for (const caller of [client(), supervisor]) {
      const roster = await caller.rpc('device_roster', { p_secret: device.device_secret });
      assert.equal(roster.error?.code, '42501', 'device_roster must not be executable by anon / authenticated');
      const login = await caller.rpc('device_guard_login', { p_secret: device.device_secret, p_guard_id: fixture.users.guard.id });
      assert.equal(login.error?.code, '42501', 'device_guard_login must not be executable by anon / authenticated');
    }

    const roster = await service().rpc('device_roster', { p_secret: device.device_secret });
    assert.equal(roster.error, null, roster.error?.message);
    const body = roster.data as { device: { id: string }; site: { id: string }; guards: Array<{ id: string; first_name: string; last_name: string }> };
    assert.equal(body.device.id, device.device_id);
    assert.equal(body.site.id, fixture.siteA.id);
    assert.deepEqual(
      body.guards.map((g) => g.id),
      [fixture.users.guard2.id, fixture.users.guard.id],
      'active site-A guards only, ordered by first name (Pieter, Thabo)'
    );
    assert.equal(JSON.stringify(body).includes('@'), false, 'no e-mail addresses in the roster');

    const unknown = await service().rpc('device_roster', { p_secret: `EED-${randomBytes(32).toString('hex')}` });
    assert.equal(unknown.error, null);
    assert.equal(unknown.data, null);

    for (const other of [fixture.users.admin, fixture.users.supervisor, fixture.users.disabledGuard, fixture.users.guardB, fixture.users.viewer]) {
      const refused = await service().rpc('device_guard_login', { p_secret: device.device_secret, p_guard_id: other.id });
      assert.equal(refused.error?.code, '42501', `${other.key} must not get a session through a patrol phone`);
      assert.equal(refused.error?.message, 'guard_not_allowed');
    }

    const login = await service().rpc('device_guard_login', { p_secret: device.device_secret, p_guard_id: fixture.users.guard.id });
    assert.equal(login.error, null, login.error?.message);
    const grant = login.data as { user_id: string; email: string; device_id: string; site_id: string };
    assert.equal(grant.user_id, fixture.users.guard.id);
    assert.equal(grant.email, fixture.users.guard.email);
    const hash = await mint(grant.email);
    const phone = client();
    const verified = await phone.auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
    assert.equal(verified.error, null, verified.error?.message);
    assert.equal(verified.data.user?.id, fixture.users.guard.id);

    const revoke = await supervisor.rpc('revoke_patrol_device', { p_device_id: device.device_id });
    assert.equal(revoke.error, null, revoke.error?.message);
    const afterRevoke = await service().rpc('device_guard_login', { p_secret: device.device_secret, p_guard_id: fixture.users.guard.id });
    assert.equal(afterRevoke.error?.code, '42501');
    assert.equal(afterRevoke.error?.message, 'device_not_enrolled');
    const rosterAfter = await service().rpc('device_roster', { p_secret: device.device_secret });
    assert.equal(rosterAfter.data, null);
  });
});
