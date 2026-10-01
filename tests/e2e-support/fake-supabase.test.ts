/**
 * Verifies the E2E fake Supabase server with the REAL @supabase/supabase-js client over HTTP
 * (no browser): Auth, PostgREST semantics under RLS, Storage policies + signed URLs, JWT checks,
 * realtime refusal, fault injection, and production loaders (loadIdentity, loadCheckpoints)
 * running against it.
 *
 *   npx tsx --test tests/e2e-support/fake-supabase.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadIdentity } from '../../src/lib/auth/identity';
import { loadCheckpoints } from '../../src/lib/data/checkpoints';
import { TEST_ANON_KEY, TEST_CONTROL_HEADER, TEST_CONTROL_TOKEN, TEST_SERVICE_ROLE_KEY } from './constants';
import type { E2EFixture, E2EUserKey } from './fixture';
import { signJwt } from './jwt';
import { startFakeSupabase, type FakeSupabaseServer } from './fake-supabase/server';
import { retryFetch } from './netRetry';

let fake: FakeSupabaseServer;
let fixture: E2EFixture;

function client(key: string = TEST_ANON_KEY): SupabaseClient {
  return createClient(fake.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: retryFetch } });
}

async function signedIn(user: E2EUserKey): Promise<SupabaseClient> {
  const supabase = client();
  const u = fixture.users[user];
  const { data, error } = await supabase.auth.signInWithPassword({ email: u.email, password: u.password });
  assert.equal(error, null, `sign-in ${user}: ${error?.message}`);
  assert.ok(data.session?.access_token);
  return supabase;
}

async function control<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await retryFetch(`${fake.url}/__test/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { [TEST_CONTROL_HEADER]: TEST_CONTROL_TOKEN, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/__test/${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await control<{ rows: T[] }>('sql', { body: { sql: query, params } })).rows;
}

/** A tiny valid JPEG header + filler (Storage checks MIME type and size, not pixels). */
function jpegBlob(size = 2048): Blob {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < size; i += 1) bytes[i] = i % 251;
  return new Blob([bytes], { type: 'image/jpeg' });
}

before(async () => {
  fake = await startFakeSupabase({ port: 0, quiet: true });
  fixture = (await control<{ fixture: E2EFixture }>('reset', { body: {} })).fixture;
});

after(async () => {
  await fake?.close();
});

describe('fake Supabase: control + health', () => {
  it('reports health, the applied migrations and the seeded fixture', async () => {
    const res = await retryFetch(`${fake.url}/__test/health`);
    assert.equal(res.status, 200);
    const health = (await res.json()) as { ok: boolean; migrations: string[]; seeded: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.seeded, true);
    assert.ok(health.migrations.includes('20261001000000_security_audit_hardening.sql'), health.migrations.join(','));
  });

  it('refuses control calls without the control header', async () => {
    const res = await retryFetch(`${fake.url}/__test/fixture`);
    assert.equal(res.status, 403);
  });

  it('seeds random ids and strong checkpoint tokens', () => {
    assert.match(fixture.checkpoints.gate.qrToken, /^EE-CP-[0-9A-F]{32}$/);
    assert.notEqual(fixture.users.guard.id, fixture.users.guard2.id);
    assert.equal(fixture.users.guard.email, 'guard1@guards.test');
  });
});

describe('fake Supabase: Auth', () => {
  it('signs in with a password and rejects a wrong one with invalid_credentials', async () => {
    const supabase = client();
    const bad = await supabase.auth.signInWithPassword({ email: fixture.users.guard.email, password: 'wrong-password' });
    assert.equal(bad.data.session, null);
    assert.equal(bad.error?.status, 400);
    assert.equal(bad.error?.code, 'invalid_credentials');
    const good = await supabase.auth.signInWithPassword({ email: fixture.users.guard.email, password: fixture.users.guard.password });
    assert.equal(good.error, null);
    assert.equal(good.data.user?.id, fixture.users.guard.id);
    const user = await supabase.auth.getUser();
    assert.equal(user.data.user?.email, fixture.users.guard.email);
  });

  it('verifies tokens on getClaims (HS256 → /auth/v1/user) and after sign-out reports session_not_found', async () => {
    const supabase = await signedIn('supervisor');
    const claims = await supabase.auth.getClaims();
    assert.equal(claims.error, null);
    assert.equal(claims.data?.claims.sub, fixture.users.supervisor.id);
    const token = (await supabase.auth.getSession()).data.session!.access_token;
    await supabase.auth.signOut({ scope: 'local' });
    const after = await client().auth.getUser(token);
    assert.equal(after.data.user, null);
    assert.equal(after.error?.name, 'AuthSessionMissingError');
  });

  it('rotates refresh tokens and refuses reuse outside the reuse window', async () => {
    const supabase = await signedIn('guard');
    const first = (await supabase.auth.getSession()).data.session!;
    const refreshed = await supabase.auth.refreshSession();
    assert.equal(refreshed.error, null);
    assert.notEqual(refreshed.data.session?.refresh_token, first.refresh_token);
    const { data, error } = await supabase.from('profiles').select('id').eq('id', fixture.users.guard.id);
    assert.equal(error, null);
    assert.equal(data?.length, 1);
  });

  it('maps a disabled account to a signed-in session whose data is empty (RLS), not an auth failure', async () => {
    const supabase = await signedIn('disabledGuard');
    const identity = await loadIdentity(supabase, { id: fixture.users.disabledGuard.id, email: fixture.users.disabledGuard.email });
    assert.equal(identity.kind, 'disabled');
    const noProfile = await signedIn('noProfile');
    const none = await loadIdentity(noProfile, { id: fixture.users.noProfile.id, email: fixture.users.noProfile.email });
    assert.equal(none.kind, 'no_profile');
  });

  it('records password recovery requests (PKCE link) without revealing whether the account exists', async () => {
    const memory = new Map<string, string>();
    const pkce = createClient(fake.url, TEST_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage: {
          getItem: (k: string) => memory.get(k) ?? null,
          setItem: (k: string, v: string) => void memory.set(k, v),
          removeItem: (k: string) => void memory.delete(k)
        }
      },
      global: { fetch: retryFetch }
    });
    // Unknown address first: each request stores a fresh PKCE verifier on the client.
    const unknown = await pkce.auth.resetPasswordForEmail('nobody@e2e.test', { redirectTo: 'http://127.0.0.1:3100/auth/reset' });
    assert.equal(unknown.error, null);
    const res = await pkce.auth.resetPasswordForEmail(fixture.users.admin.email, { redirectTo: 'http://127.0.0.1:3100/auth/reset' });
    assert.equal(res.error, null);
    const { recoveries } = await control<{ recoveries: Array<{ email: string; link: string | null }> }>('recoveries');
    const link = recoveries.find((r) => r.email === fixture.users.admin.email)?.link;
    assert.ok(link, 'recovery link for the admin');
    const code = new URL(link).searchParams.get('code')!;
    const exchanged = await pkce.auth.exchangeCodeForSession(code);
    assert.equal(exchanged.error, null, exchanged.error?.message);
    assert.equal(exchanged.data.user?.id, fixture.users.admin.id);
    const updated = await pkce.auth.updateUser({ password: 'Admin-e2e-New-Pass-99' });
    assert.equal(updated.error, null);
    const relogin = await client().auth.signInWithPassword({ email: fixture.users.admin.email, password: 'Admin-e2e-New-Pass-99' });
    assert.equal(relogin.error, null);
    const old = await client().auth.signInWithPassword({ email: fixture.users.admin.email, password: fixture.users.admin.password });
    assert.equal(old.error?.code, 'invalid_credentials');
    // Restore the fixture password for the other tests.
    const restored = await pkce.auth.updateUser({ password: fixture.users.admin.password });
    assert.equal(restored.error, null);
    assert.equal(recoveries.find((r) => r.email === 'nobody@e2e.test')?.link, null);
  });

  it('verifies token-hash recovery links once (verifyOtp), and refuses reuse or forged hashes with otp_expired', async () => {
    const anon = client();
    const res = await anon.auth.resetPasswordForEmail(fixture.users.supervisor.email, { redirectTo: 'http://127.0.0.1:3100/auth/reset' });
    assert.equal(res.error, null);
    const { recoveries } = await control<{ recoveries: Array<{ email: string; tokenHashLink: string | null }> }>('recoveries');
    const link = recoveries.filter((r) => r.email === fixture.users.supervisor.email).at(-1)?.tokenHashLink;
    assert.ok(link, 'token-hash link for the supervisor');
    const url = new URL(link);
    assert.equal(url.pathname, '/auth/reset');
    assert.equal(url.searchParams.get('type'), 'recovery');
    const tokenHash = url.searchParams.get('token_hash')!;

    const forged = await client().auth.verifyOtp({ token_hash: 'f'.repeat(56), type: 'recovery' });
    assert.equal(forged.error?.code, 'otp_expired');
    const verified = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    assert.equal(verified.error, null, verified.error?.message);
    assert.equal(verified.data.user?.id, fixture.users.supervisor.id);
    assert.ok(verified.data.session?.access_token);
    const again = await client().auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    assert.equal(again.error?.code, 'otp_expired', 'a reset link works once');
    await anon.auth.signOut();
  });

  it('admin API (service role) creates a user that can sign in; the anon key cannot', async () => {
    const admin = client(TEST_SERVICE_ROLE_KEY);
    const created = await admin.auth.admin.createUser({ email: 'newguard@guards.test', password: 'NewGuard-Pass-1', email_confirm: true });
    assert.equal(created.error, null, created.error?.message);
    const denied = await client().auth.admin.createUser({ email: 'x@guards.test', password: 'Whatever-1', email_confirm: true });
    assert.ok(denied.error);
    const login = await client().auth.signInWithPassword({ email: 'newguard@guards.test', password: 'NewGuard-Pass-1' });
    assert.equal(login.error, null);
    const unconfirmed = await admin.auth.admin.createUser({ email: 'pending@guards.test', password: 'Pending-Pass-1' });
    assert.equal(unconfirmed.error, null);
    const pending = await client().auth.signInWithPassword({ email: 'pending@guards.test', password: 'Pending-Pass-1' });
    assert.equal(pending.error?.code, 'email_not_confirmed');
  });
});

describe('fake Supabase: PostgREST under RLS', () => {
  it('runs the production identity loader and checkpoint loader for a guard', async () => {
    const supabase = await signedIn('guard');
    const identity = await loadIdentity(supabase, { id: fixture.users.guard.id, email: fixture.users.guard.email });
    assert.equal(identity.kind, 'ok');
    if (identity.kind !== 'ok') return;
    assert.deepEqual(identity.snapshot.roles, ['guard']);
    assert.deepEqual(
      identity.snapshot.sites.map((s) => s.id),
      [fixture.siteA.id]
    );
    const site = identity.snapshot.sites[0];
    assert.equal(site.whatsappDispatchNumber, fixture.siteA.whatsappDispatchNumber);
    const loaded = await loadCheckpoints(fixture.siteA.id, { cache: null, supabase, isOnline: () => true });
    assert.equal(loaded.source, 'network');
    assert.deepEqual(
      loaded.checkpoints.map((c) => c.name),
      ['Main gate', 'Workshop', 'Borehole', 'Old pump']
    );
    // Guards never receive raw tokens / serials, only fingerprints.
    const workshop = loaded.checkpoints.find((c) => c.name === 'Workshop')!;
    assert.match(workshop.nfcUidSha256 ?? '', /^[0-9a-f]{64}$/);
  });

  it('enforces column privileges: select=* on checkpoints fails with 42501 for a guard', async () => {
    const supabase = await signedIn('guard');
    const { error, status } = await supabase.from('checkpoints').select('*').eq('site_id', fixture.siteA.id);
    assert.equal(status, 403);
    assert.equal(error?.code, '42501');
  });

  it('guard inserts a shift + scan like the sync engine (upsert ignore-duplicates, replay is a no-op)', async () => {
    const supabase = await signedIn('guard');
    const shiftId = randomUUID();
    const now = Date.now();
    const shift = {
      id: shiftId,
      site_id: fixture.siteA.id,
      guard_id: fixture.users.guard.id,
      shift_type: 'custom',
      scheduled_start: new Date(now - 60_000).toISOString(),
      scheduled_end: new Date(now + 8 * 3600_000).toISOString(),
      actual_start: new Date(now - 60_000).toISOString(),
      status: 'active'
    };
    const first = await supabase.from('shifts').upsert(shift, { onConflict: 'id', ignoreDuplicates: true });
    assert.equal(first.error, null, first.error?.message);
    assert.equal(first.status, 201);
    const replay = await supabase.from('shifts').upsert(shift, { onConflict: 'id', ignoreDuplicates: true });
    assert.equal(replay.error, null);

    const scanId = randomUUID();
    const scan = {
      id: scanId,
      offline_uuid: scanId,
      shift_id: shiftId,
      checkpoint_id: fixture.checkpoints.gate.id,
      guard_id: fixture.users.guard.id,
      scan_timestamp_device: new Date().toISOString(),
      latitude: fixture.siteA.latitude,
      longitude: fixture.siteA.longitude,
      accuracy_meters: 5,
      method: 'qr',
      payload_type: 'secure_token',
      raw_payload: fixture.checkpoints.gate.qrToken
    };
    const inserted = await supabase.from('patrol_scans').upsert(scan, { onConflict: 'offline_uuid', ignoreDuplicates: true });
    assert.equal(inserted.error, null, inserted.error?.message);
    const rows = await sql<{ gps_confidence: string; payload_verified: boolean; raw_payload: string; site_id: string }>(
      `SELECT gps_confidence, payload_verified, raw_payload, site_id FROM patrol_scans WHERE id = $1`,
      [scanId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gps_confidence, 'verified');
    assert.equal(rows[0].payload_verified, true);
    assert.match(rows[0].raw_payload, /^sha256:/);
    assert.equal(rows[0].site_id, fixture.siteA.id);

    // Clock-out: UPDATE … .is('actual_end', null).select('id') returns exactly the row.
    const end = await supabase
      .from('shifts')
      .update({ actual_end: new Date().toISOString(), status: 'completed' })
      .eq('id', shiftId)
      .eq('guard_id', fixture.users.guard.id)
      .is('actual_end', null)
      .select('id');
    assert.equal(end.error, null, end.error?.message);
    assert.deepEqual(end.data, [{ id: shiftId }]);
    const again = await supabase.from('shifts').update({ status: 'completed' }).eq('id', shiftId).is('actual_end', null).select('id');
    assert.deepEqual(again.data, []);
  });

  it('denies a client viewer writes (42501 → 403) and hides panic alerts', async () => {
    const viewer = await signedIn('viewer');
    const id = randomUUID();
    const denied = await viewer.from('incidents').insert({
      id,
      offline_uuid: id,
      site_id: fixture.siteA.id,
      guard_id: fixture.users.viewer.id,
      incident_type: 'fence',
      reported_at: new Date().toISOString()
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.error?.code, '42501');
    const panics = await viewer.from('panic_alerts').select('id');
    assert.equal(panics.error, null);
    assert.deepEqual(panics.data, []);
    const people = await viewer.rpc('site_people', { p_site_id: fixture.siteA.id });
    assert.equal(people.error, null, people.error?.message);
    assert.ok(Array.isArray(people.data) && people.data.length >= 3);
  });

  it('keeps tenants apart: guard B sees only site B', async () => {
    const guardB = await signedIn('guardB');
    const sites = await guardB.from('sites').select('id, name');
    assert.deepEqual(
      sites.data?.map((s) => s.id),
      [fixture.siteB.id]
    );
    const foreign = await guardB.from('checkpoints').select('id, name').eq('site_id', fixture.siteA.id);
    assert.deepEqual(foreign.data, []);
  });

  it('supports single/maybeSingle, count, or/in/not filters, order/limit, embeds and error shapes', async () => {
    const admin = await signedIn('admin');
    const none = await admin.from('sites').select('id').eq('id', randomUUID()).single();
    assert.equal(none.status, 406);
    assert.equal(none.error?.code, 'PGRST116');
    const maybe = await admin.from('sites').select('id').eq('id', randomUUID()).maybeSingle();
    assert.equal(maybe.error, null);
    assert.equal(maybe.data, null);
    const counted = await admin.from('checkpoints').select('id', { count: 'exact', head: true }).eq('site_id', fixture.siteA.id);
    assert.equal(counted.error, null);
    assert.equal(counted.count, 4);
    const filtered = await admin
      .from('checkpoints')
      .select('name, order_index')
      .eq('site_id', fixture.siteA.id)
      .or('legacy_code.eq.CP1,name.eq.Borehole')
      .not('latitude', 'is', null)
      .order('order_index', { ascending: false })
      .limit(5);
    assert.equal(filtered.error, null, filtered.error?.message);
    assert.deepEqual(filtered.data, [{ name: 'Main gate', order_index: 1 }]);
    const inList = await admin.from('user_roles').select('role').in('user_id', [fixture.users.guard.id, fixture.users.supervisor.id]).order('role');
    assert.deepEqual(
      inList.data?.map((r) => r.role),
      ['supervisor', 'guard']
    );
    const embedded = await admin
      .from('site_assignments')
      .select('site_id, profiles!inner(first_name, last_name), sites(name)')
      .eq('site_id', fixture.siteA.id)
      .eq('profiles.first_name', 'Thabo');
    assert.equal(embedded.error, null, embedded.error?.message);
    assert.equal(embedded.data?.length, 1);
    assert.deepEqual((embedded.data?.[0] as unknown as { sites: { name: string } }).sites, { name: fixture.siteA.name });
    const toMany = await admin.from('sites').select('name, checkpoints(name)').eq('id', fixture.siteA.id).single();
    assert.equal(toMany.error, null, toMany.error?.message);
    assert.equal((toMany.data as unknown as { checkpoints: unknown[] }).checkpoints.length, 4);
    const ambiguous = await admin.from('incidents').select('id, profiles(first_name)');
    assert.equal(ambiguous.status, 300);
    assert.equal(ambiguous.error?.code, 'PGRST201');
    const badColumn = await admin.from('sites').select('nope');
    assert.equal(badColumn.status, 400);
    assert.equal(badColumn.error?.code, '42703');
    const unknownTable = await admin.from('nope').select('*');
    assert.equal(unknownTable.status, 404);
    const unfiltered = await admin.from('sites').delete();
    assert.equal(unfiltered.error?.code, '21000');
  });

  it('rejects tampered or expired JWTs like PostgREST (401)', async () => {
    const forged = signJwt({ sub: fixture.users.admin.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }, 'not-the-secret');
    const res = await retryFetch(`${fake.url}/rest/v1/sites?select=id`, { headers: { apikey: TEST_ANON_KEY, Authorization: `Bearer ${forged}` } });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'PGRST301');
    const expired = signJwt({ sub: fixture.users.admin.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 5 }, 'e2e-only-fake-supabase-jwt-secret-do-not-use-anywhere-else-7f3a9c');
    const res2 = await retryFetch(`${fake.url}/rest/v1/sites?select=id`, { headers: { apikey: TEST_ANON_KEY, Authorization: `Bearer ${expired}` } });
    assert.equal(res2.status, 401);
    assert.equal(((await res2.json()) as { code: string }).code, 'PGRST303');
    // anon has no table privileges at all after the hardening migration: 42501 → 401 for anon.
    const anon = await client().from('sites').select('id');
    assert.equal(anon.status, 401);
    assert.equal(anon.error?.code, '42501');
    const noKey = await retryFetch(`${fake.url}/rest/v1/sites?select=id`);
    assert.equal(noKey.status, 401);
  });
});

describe('fake Supabase: Storage', () => {
  it('uploads evidence under the storage policies, answers 409 on a retry, and serves signed URLs', async () => {
    const guard = await signedIn('guard');
    const eventId = randomUUID();
    const path = `${fixture.orgA.id}/${fixture.siteA.id}/selfie/${fixture.users.guard.id}/${eventId}-selfie.jpg`;
    const blob = jpegBlob(3000);
    const up = await guard.storage.from('evidence-media').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    assert.equal(up.error, null, up.error?.message);
    const retry = await guard.storage.from('evidence-media').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    assert.ok(retry.error);
    assert.equal((retry.error as unknown as { statusCode: string }).statusCode, '409');

    const signed = await guard.storage.from('evidence-media').createSignedUrl(path, 60);
    assert.equal(signed.error, null, signed.error?.message);
    const download = await retryFetch(signed.data!.signedUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/jpeg');
    assert.equal((await download.arrayBuffer()).byteLength, 3000);

    const supervisor = await signedIn('supervisor');
    const supSigned = await supervisor.storage.from('evidence-media').createSignedUrl(path, 60);
    assert.equal(supSigned.error, null);
    const viewer = await signedIn('viewer');
    const viewerSigned = await viewer.storage.from('evidence-media').createSignedUrl(path, 60);
    assert.ok(viewerSigned.error, 'client viewers cannot open selfies');

    const wrongFolder = `${fixture.orgA.id}/${fixture.siteA.id}/selfie/${fixture.users.guard2.id}/${randomUUID()}-selfie.jpg`;
    const denied = await guard.storage.from('evidence-media').upload(wrongFolder, blob, { contentType: 'image/jpeg' });
    assert.equal((denied.error as unknown as { statusCode: string } | null)?.statusCode, '403');
    const badType = await guard.storage
      .from('evidence-media')
      .upload(`${fixture.orgA.id}/${fixture.siteA.id}/selfie/${fixture.users.guard.id}/${randomUUID()}-selfie.jpg`, new Blob(['x'], { type: 'text/plain' }));
    assert.equal((badType.error as unknown as { statusCode: string } | null)?.statusCode, '415');
  });
});

describe('fake Supabase: realtime and faults', () => {
  it('refuses WebSocket upgrades with 503', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${fake.url}/realtime/v1/websocket?apikey=${TEST_ANON_KEY}&vsn=1.0.0`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', () => reject(new Error('upgrade must be refused')));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 503);
  });

  it('survives clients that reset a refused upgrade (a browser context closing mid-request)', async () => {
    for (let i = 0; i < 30; i += 1) {
      await new Promise<void>((resolve) => {
        const socket = netConnect(fake.port, '127.0.0.1', () => {
          socket.write(
            `GET /realtime/v1/websocket?apikey=${TEST_ANON_KEY}&vsn=1.0.0 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
              'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
          );
          setTimeout(() => {
            socket.resetAndDestroy();
            resolve();
          }, i % 5);
        });
        socket.on('error', () => resolve());
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await retryFetch(`${fake.url}/__test/health`);
    assert.equal(res.status, 200, 'the fake server is still up');
  });

  it('lose_response applies the write but the client sees a network failure; outage drops everything', async () => {
    const guard = await signedIn('guard');
    await control('faults', { body: { rules: [{ method: 'POST', path: '^/rest/v1/sync_events', action: 'lose_response' }] } });
    const id = randomUUID();
    const res = await guard.from('sync_events').insert({ id, device_id: 'e2e', user_id: fixture.users.guard.id, events_count: 1, successful_count: 1, failed_count: 0, status: 'ok' });
    assert.equal(res.status, 0);
    assert.ok(res.error);
    const rows = await sql(`SELECT id FROM sync_events WHERE id = $1`, [id]);
    assert.equal(rows.length, 1);

    await control('outage', { body: { on: true } });
    const down = await guard.from('sites').select('id');
    assert.equal(down.status, 0);
    await control('outage', { body: { on: false } });
    const up = await guard.from('sites').select('id');
    assert.equal(up.status, 200);
    const log = await control<{ entries: Array<{ path: string; fault: string | null }> }>('requests');
    assert.ok(log.entries.some((e) => e.fault === 'lose_response' && e.path.startsWith('/rest/v1/sync_events')));
  });
});
