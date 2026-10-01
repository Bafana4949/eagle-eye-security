/**
 * Patrol-phone guard sign-in, end to end against the REAL database.
 *
 * The production server library (src/lib/auth/deviceLogin.ts: createDeviceLoginDeps,
 * getDeviceRoster, issueGuardDeviceSession and the two HTTP handlers) runs against PGlite with
 * the shipped migrations. Its database calls go through the supabase-js-shaped adapter in
 * ./pgSupabase.ts executed AS THE SERVICE ROLE (request.jwt role service_role, like the route's
 * createServiceRoleClient()), so the EXECUTE grants and the bodies of device_roster /
 * device_guard_login are exercised for real. Only Supabase Auth is stubbed:
 * auth.admin.generateLink records which e-mail the server asked a magic link for and returns a
 * token hash; the browser-side verifyOtp redeems exactly those tokens.
 *
 * Covered: the roster (only active plain guards of the phone's site, names only), a successful
 * sign-in (e-mail read from auth.users, never from the request, never returned; last-used fields
 * and the audit row written) and every refusal - malformed input, unknown / revoked phone,
 * inactive site, guards of other sites / organisations, disabled guards, managers (also when they
 * hold the guard role too), client viewers, unknown ids, accounts without e-mail, a missing
 * service key, a client that is not the service role, and a failing Auth call. Refusals never
 * reach generateLink, never write an audit row and never report success. The last block drives
 * the real browser library (enrolThisPhone → fetchDeviceRoster → signInGuardOnDevice →
 * revokePatrolDevice) through the handlers.
 */
// Must stay the first import: lets node:test load the `server-only` library below.
import '@/lib/testing/allowServerOnly';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createDeviceLoginDeps,
  getDeviceRoster,
  handleDeviceLoginRequest,
  handleDeviceRosterRequest,
  issueGuardDeviceSession,
  type DeviceHttpRequest,
  type DeviceLoginDeps,
  type DeviceLoginErrorCode
} from '@/lib/auth/deviceLogin';
import {
  PATROL_DEVICE_STORAGE_KEY,
  enrolThisPhone,
  fetchDeviceRoster,
  loadPatrolDevice,
  revokePatrolDevice,
  signInGuardOnDevice,
  type PatrolDevice
} from '@/lib/auth/patrolDevice';
import type { KeyValueStorage } from '@/lib/auth/identity';
import { asSuperuser, cloneTestDb, createTestDb, withClaims } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { PgSupabase } from './pgSupabase';

// ---------------------------------------------------------------------------------------------
// Test doubles: service-role client (real database) + stubbed Supabase Auth
// ---------------------------------------------------------------------------------------------

/** The pgSupabase adapter, but every request runs as the service role (no auth.uid()). */
class ServiceRolePgSupabase extends PgSupabase {
  constructor(db: PGlite) {
    super(db, null);
  }
  asSession<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withClaims(this.db, { role: 'service_role', sub: null }, fn);
  }
}

type ServiceClient = Pick<SupabaseClient, 'rpc' | 'auth'>;

interface LinkRequest {
  type: string;
  email: string;
}

interface AuthStub {
  /** Every generateLink call the server made. */
  links: LinkRequest[];
  /** hashed_token → e-mail it was minted for (redeemed by the fake verifyOtp). */
  tokens: Map<string, string>;
  /** Replaces the default "mint a token" behaviour. */
  override: ((request: LinkRequest) => Promise<unknown>) | null;
}

interface Env {
  deps: DeviceLoginDeps;
  /** Requests the service-role adapter executed (rpc names). */
  pg: PgSupabase;
  auth: AuthStub;
  logs: string[];
}

/** Real createDeviceLoginDeps over a client built from `pg` (service role unless told otherwise). */
function makeEnv(db: PGlite, pg: PgSupabase = new ServiceRolePgSupabase(db)): Env {
  const auth: AuthStub = { links: [], tokens: new Map(), override: null };
  const logs: string[] = [];
  const client = {
    rpc: (fn: string, args?: Record<string, unknown>) => pg.rpc(fn, args ?? {}),
    auth: {
      admin: {
        generateLink: async (params: { type: string; email: string }) => {
          const request = { type: params.type, email: params.email };
          auth.links.push(request);
          if (auth.override) return auth.override(request);
          const hashed = randomBytes(28).toString('hex');
          auth.tokens.set(hashed, request.email);
          return {
            data: {
              properties: {
                action_link: `http://auth.test/verify?token=${hashed}`,
                email_otp: '123456',
                hashed_token: hashed,
                redirect_to: 'http://localhost',
                verification_type: 'magiclink'
              },
              user: { id: 'from-auth', email: request.email }
            },
            error: null
          };
        }
      }
    }
  } as unknown as ServiceClient;
  const deps = createDeviceLoginDeps(
    () => client,
    (message, detail) => logs.push(`${message} ${JSON.stringify(detail ?? {})}`)
  );
  return { deps, pg, auth, logs };
}

/** A request as the route handler receives it. */
function httpRequest(body: unknown, contentType = 'application/json'): DeviceHttpRequest {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    contentType,
    contentLength: String(Buffer.byteLength(text)),
    body: new Blob([text]).stream()
  };
}

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

/** Browser fetch → the two route handlers (what the Next.js routes do), recording what was sent. */
function handlerFetch(deps: DeviceLoginDeps, sent: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const body = typeof init?.body === 'string' ? init.body : '';
    sent.push(body);
    const headers = new Headers(init?.headers);
    const request: DeviceHttpRequest = {
      contentType: headers.get('content-type'),
      contentLength: String(Buffer.byteLength(body)),
      body: new Blob([body]).stream()
    };
    if (path === '/api/auth/device-roster') {
      const outcome = await handleDeviceRosterRequest(request, deps);
      return Response.json(outcome.body, { status: outcome.status });
    }
    if (path === '/api/auth/device-login') {
      const outcome = await handleDeviceLoginRequest(request, deps);
      return Response.json(outcome.body, { status: outcome.status });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** Browser Supabase client: verifyOtp redeems tokens minted by the stubbed generateLink (once). */
function browserAuth(db: PGlite, auth: AuthStub, verified: unknown[]): Pick<SupabaseClient, 'auth'> {
  return {
    auth: {
      verifyOtp: async (params: { token_hash?: string; type?: string }) => {
        verified.push(params);
        const email = params.type === 'magiclink' && params.token_hash ? auth.tokens.get(params.token_hash) : undefined;
        if (!email) return { data: { user: null, session: null }, error: Object.assign(new Error('Token has expired or is invalid'), { status: 403 }) };
        auth.tokens.delete(params.token_hash as string);
        const r = await asSuperuser<{ id: string }>(db, `SELECT id FROM auth.users WHERE email = $1`, [email]);
        const user = { id: r.rows[0].id, email };
        return { data: { user, session: { access_token: 'access', refresh_token: 'refresh', user } }, error: null };
      },
      signOut: async () => ({ error: null })
    }
  } as unknown as Pick<SupabaseClient, 'auth'>;
}

const online = () => false;

// ---------------------------------------------------------------------------------------------
// Fixture: two-tenant fixture + extra people, sites and enrolled phones
// ---------------------------------------------------------------------------------------------

interface Extra {
  /** plain guard "Aaron Zulu", siteA1 (first in the roster) */
  aaronA: string;
  /** guard + supervisor, siteA1 */
  guardSupA: string;
  /** guard + admin, siteA1 */
  guardAdminA: string;
  /** plain guard, siteA1, auth user without e-mail */
  noEmailA: string;
  /** org A site that is deactivated after its phone was enrolled */
  siteA3: string;
  /** plain guard of siteA3 */
  guardA4: string;
}

interface Phones {
  /** siteA1, enrolled by supA through the browser library */
  a1: PatrolDevice;
  /** siteA2, enrolled by adminA */
  a2: PatrolDevice;
  /** siteB1 (org B), enrolled by adminB */
  b1: PatrolDevice;
  /** siteA1, enrolled then revoked by supA */
  revoked: PatrolDevice;
  /** siteA3, site deactivated afterwards */
  inactiveSite: PatrolDevice;
}

let base: PGlite;
let fx: Fixture;
let ex: Extra;
let phones: Phones;

async function addPerson(
  db: PGlite,
  org: string,
  first: string,
  last: string,
  roles: string[],
  sites: string[],
  email: string | null
): Promise<string> {
  const id = randomUUID();
  await asSuperuser(db, `INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  await asSuperuser(
    db,
    `INSERT INTO profiles (id, organisation_id, first_name, last_name, is_active, phone_number, employee_number)
     VALUES ($1, $2, $3, $4, true, '+27 82 555 0101', 'EMP-777')`,
    [id, org, first, last]
  );
  for (const role of roles) await asSuperuser(db, `INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  for (const site of sites) await asSuperuser(db, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [site, id]);
  return id;
}

/** Enrols a phone for `siteId` as `userId` with the real browser library (RPC as that user). */
async function enrolAs(db: PGlite, userId: string, siteId: string, label: string): Promise<PatrolDevice> {
  const storage = new MemoryStorage();
  const result = await enrolThisPhone(new PgSupabase(db, { userId }).client, siteId, label, storage);
  assert.ok(result.ok, `enrol ${label}: ${JSON.stringify(result)}`);
  assert.deepEqual(loadPatrolDevice(storage), result.device, 'the secret is kept on the phone');
  return result.device;
}

before(async () => {
  base = await createTestDb();
  fx = await seedTwoTenantFixture(base);
  const siteA3 = randomUUID();
  await asSuperuser(base, `INSERT INTO sites (id, organisation_id, name, code) VALUES ($1, $2, 'Farm A3', 'A3')`, [siteA3, fx.orgA]);
  ex = {
    aaronA: await addPerson(base, fx.orgA, 'Aaron', 'Zulu', ['guard'], [fx.siteA1], 'aaron@example.test'),
    guardSupA: await addPerson(base, fx.orgA, 'Dual', 'GuardSupervisor', ['guard', 'supervisor'], [fx.siteA1], 'dualsup@example.test'),
    guardAdminA: await addPerson(base, fx.orgA, 'Dual', 'GuardAdmin', ['guard', 'admin'], [fx.siteA1], 'dualadmin@example.test'),
    noEmailA: await addPerson(base, fx.orgA, 'Zed', 'NoEmail', ['guard'], [fx.siteA1], null),
    siteA3,
    guardA4: await addPerson(base, fx.orgA, 'Farm', 'ThreeGuard', ['guard'], [siteA3], 'guarda4@example.test')
  };
  // Contact details on a fixture guard: the roster must never carry them.
  await asSuperuser(base, `UPDATE profiles SET phone_number = '+27 82 555 0199', employee_number = 'EMP-001' WHERE id = $1`, [
    fx.users.guardA
  ]);

  phones = {
    a1: await enrolAs(base, fx.users.supA, fx.siteA1, 'Main gate phone'),
    a2: await enrolAs(base, fx.users.adminA, fx.siteA2, 'A2 patrol phone'),
    b1: await enrolAs(base, fx.users.adminB, fx.siteB1, 'B1 gate phone'),
    revoked: await enrolAs(base, fx.users.supA, fx.siteA1, 'Lost phone'),
    inactiveSite: await enrolAs(base, fx.users.adminA, siteA3, 'A3 phone')
  };
  const revoked = await revokePatrolDevice(new PgSupabase(base, { userId: fx.users.supA }).client, phones.revoked.deviceId, null);
  assert.deepEqual(revoked, { ok: true });
  await asSuperuser(base, `UPDATE sites SET is_active = false WHERE id = $1`, [siteA3]);
});

after(async () => {
  await base.close();
});

/** Runs `fn` on a private copy of the fixture database. */
async function withCopy(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await cloneTestDb(base);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

interface DeviceState {
  last_used_at: string | null;
  last_guard_id: string | null;
}

async function deviceState(db: PGlite, deviceId: string): Promise<DeviceState> {
  const r = await asSuperuser<DeviceState>(
    db,
    `SELECT last_used_at::text AS last_used_at, last_guard_id::text AS last_guard_id FROM patrol_devices WHERE id = $1`,
    [deviceId]
  );
  return r.rows[0];
}

async function signInAuditRows(db: PGlite): Promise<Array<{ actor_id: string; resource_id: string; details: Record<string, unknown>; organisation_id: string }>> {
  const r = await asSuperuser<{ actor_id: string; resource_id: string; details: Record<string, unknown>; organisation_id: string }>(
    db,
    `SELECT actor_id::text AS actor_id, resource_id::text AS resource_id, details, organisation_id::text AS organisation_id
     FROM audit_logs WHERE action = 'patrol_device.guard_signed_in' ORDER BY created_at`
  );
  return r.rows;
}

function assertLogsRedacted(logs: string[], label: string): void {
  for (const line of logs) {
    assert.doesNotMatch(line, /EED-[0-9a-f]{16,}/i, `${label}: a device secret reached the server log: ${line}`);
    assert.doesNotMatch(line, /@/, `${label}: an e-mail address reached the server log: ${line}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------------------------

describe('device roster: real server library → service-role database function', () => {
  test('an enrolled phone lists only the active plain guards of its own site, names only, in name order', async () => {
    const env = makeEnv(base);
    const result = await getDeviceRoster(env.deps, phones.a1.secret);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.device, { id: phones.a1.deviceId, label: 'Main gate phone' });
    assert.deepEqual(result.site, { id: fx.siteA1, name: 'Farm A1' });
    // Not listed: disabledGuardA (inactive), supA, viewerA, guard+supervisor, guard+admin,
    // guardA3 (siteA2), guardA4 (siteA3), guardB (org B), adminA / superA (no assignment).
    assert.deepEqual(result.guards, [
      { id: ex.aaronA, firstName: 'Aaron', lastName: 'Zulu' },
      { id: fx.users.guardA, firstName: 'Guard', lastName: 'guardA' },
      { id: fx.users.guardA2, firstName: 'Guard', lastName: 'guardA2' },
      { id: ex.noEmailA, firstName: 'Zed', lastName: 'NoEmail' }
    ]);
    assert.deepEqual(
      env.pg.calls.map((call) => call.target),
      ['device_roster']
    );
    assert.equal(env.auth.links.length, 0, 'listing never creates a sign-in link');
  });

  test('another site / organisation phone lists only its own guards', async () => {
    const env = makeEnv(base);
    const a2 = await getDeviceRoster(env.deps, phones.a2.secret);
    assert.ok(a2.ok);
    assert.deepEqual(
      a2.guards.map((g) => g.id),
      [fx.users.guardA3]
    );
    const b1 = await getDeviceRoster(env.deps, phones.b1.secret);
    assert.ok(b1.ok);
    assert.equal(b1.site.id, fx.siteB1);
    assert.deepEqual(
      b1.guards.map((g) => g.id),
      [fx.users.guardB]
    );
  });

  test('HTTP handler: 200 { ok, device, site, guards } with no e-mail, phone number, employee number or secret', async () => {
    const env = makeEnv(base);
    const outcome = await handleDeviceRosterRequest(httpRequest({ deviceSecret: phones.a1.secret }), env.deps);
    assert.equal(outcome.status, 200);
    assert.deepEqual(Object.keys(outcome.body).sort(), ['device', 'guards', 'ok', 'site']);
    const text = JSON.stringify(outcome.body);
    assert.doesNotMatch(text, /@/, 'no e-mail address');
    assert.doesNotMatch(text, /EMP-|\+27/, 'no employee or phone number');
    assert.doesNotMatch(text, /EED-/, 'the secret is never echoed');
    for (const guard of (outcome.body as { guards: object[] }).guards) {
      assert.deepEqual(Object.keys(guard).sort(), ['firstName', 'id', 'lastName']);
    }
  });

  const notEnrolled: Array<[string, () => string]> = [
    ['an unknown (well-formed) secret', () => `EED-${randomBytes(32).toString('hex')}`],
    ['a revoked phone', () => phones.revoked.secret],
    ['a phone whose site was deactivated', () => phones.inactiveSite.secret]
  ];
  for (const [label, secret] of notEnrolled) {
    test(`${label} → 401 device_not_enrolled, no roster`, async () => {
      const env = makeEnv(base);
      assert.deepEqual(await getDeviceRoster(env.deps, secret()), { ok: false, error: 'device_not_enrolled' });
      const outcome = await handleDeviceRosterRequest(httpRequest({ deviceSecret: secret() }), env.deps);
      assert.deepEqual(outcome, { status: 401, body: { ok: false, error: 'device_not_enrolled' } });
    });
  }

  test('malformed secrets and extra fields → 400 invalid_request without touching the database', async () => {
    const env = makeEnv(base);
    const bad: unknown[] = [
      {},
      { deviceSecret: '' },
      { deviceSecret: phones.a1.secret.toUpperCase() },
      { deviceSecret: `${phones.a1.secret}0` },
      { deviceSecret: phones.a1.secret, email: 'guarda@example.test' },
      { deviceSecret: phones.a1.secret, userId: fx.users.guardA },
      { deviceSecret: phones.a1.secret, padding: 'x'.repeat(3000) }
    ];
    for (const body of bad) {
      const outcome = await handleDeviceRosterRequest(httpRequest(body), env.deps);
      assert.deepEqual(outcome, { status: 400, body: { ok: false, error: 'invalid_request' } }, JSON.stringify(body).slice(0, 80));
    }
    const wrongType = await handleDeviceRosterRequest(httpRequest({ deviceSecret: phones.a1.secret }, 'text/plain'), env.deps);
    assert.equal(wrongType.status, 400);
    assert.equal(env.pg.calls.length, 0, 'no database call for an invalid request');
  });
});

// ---------------------------------------------------------------------------------------------
// Guard sign-in
// ---------------------------------------------------------------------------------------------

describe('guard sign-in: real server library → device_guard_login → magic link', () => {
  test('success: the database supplies the e-mail, the server links exactly that guard, the use is recorded and audited', async () => {
    await withCopy(async (db) => {
      const env = makeEnv(db);
      const auditBefore = (await signInAuditRows(db)).length;
      const result = await issueGuardDeviceSession(env.deps, phones.a1.secret, fx.users.guardA);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(env.auth.tokens.get(result.tokenHash), 'guarda@example.test', 'the token was minted for the tapped guard');
      assert.deepEqual(env.auth.links, [{ type: 'magiclink', email: 'guarda@example.test' }]);
      assert.deepEqual(
        env.pg.calls.map((call) => call.target),
        ['device_guard_login']
      );

      const state = await deviceState(db, phones.a1.deviceId);
      assert.ok(state.last_used_at, 'last_used_at set');
      assert.equal(state.last_guard_id, fx.users.guardA);

      const audit = await signInAuditRows(db);
      assert.equal(audit.length, auditBefore + 1);
      const row = audit[audit.length - 1];
      assert.equal(row.actor_id, fx.users.guardA);
      assert.equal(row.resource_id, phones.a1.deviceId);
      assert.equal(row.organisation_id, fx.orgA);
      assert.deepEqual(row.details, { device_id: phones.a1.deviceId, site_id: fx.siteA1 });
      const auditText = JSON.stringify(row);
      assert.ok(!auditText.includes(phones.a1.secret), 'the audit row never contains the secret');
      assert.doesNotMatch(auditText, /@/, 'the audit row never contains the e-mail');
      assertLogsRedacted(env.logs, 'success');
    });
  });

  test('HTTP handler: 200 { ok, tokenHash } only — the e-mail and user id are never returned', async () => {
    await withCopy(async (db) => {
      const env = makeEnv(db);
      const outcome = await handleDeviceLoginRequest(httpRequest({ deviceSecret: phones.a1.secret, guardId: fx.users.guardA2 }), env.deps);
      assert.equal(outcome.status, 200);
      assert.deepEqual(Object.keys(outcome.body).sort(), ['ok', 'tokenHash']);
      assert.doesNotMatch(JSON.stringify(outcome.body), /@|guarda2/i);
      assert.deepEqual(env.auth.links, [{ type: 'magiclink', email: 'guarda2@example.test' }]);
    });
  });

  test('an upper-case guard id is normalised and still signs in exactly that guard', async () => {
    await withCopy(async (db) => {
      const env = makeEnv(db);
      const result = await issueGuardDeviceSession(env.deps, phones.a1.secret, ex.aaronA.toUpperCase());
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(env.auth.links, [{ type: 'magiclink', email: 'aaron@example.test' }]);
    });
  });

  test('a request that carries an e-mail (or any identity besides the roster id) is refused before the database', async () => {
    const env = makeEnv(base);
    const bodies: unknown[] = [
      { deviceSecret: phones.a1.secret, guardId: fx.users.guardA, email: 'admina@example.test' },
      { deviceSecret: phones.a1.secret, email: 'guarda@example.test' },
      { deviceSecret: phones.a1.secret, guardId: fx.users.guardA, password: 'x' },
      { deviceSecret: phones.a1.secret, guardId: 'guarda@example.test' },
      { deviceSecret: phones.a1.secret, guardId: 'not-a-uuid' },
      { deviceSecret: 'EagleEye2026', guardId: fx.users.guardA },
      { guardId: fx.users.guardA }
    ];
    for (const body of bodies) {
      const outcome = await handleDeviceLoginRequest(httpRequest(body), env.deps);
      assert.deepEqual(outcome, { status: 400, body: { ok: false, error: 'invalid_request' } }, JSON.stringify(body));
    }
    const oversized = await handleDeviceLoginRequest(
      httpRequest(`{"deviceSecret":"${phones.a1.secret}","guardId":"${fx.users.guardA}"${' '.repeat(2100)}}`),
      env.deps
    );
    assert.equal(oversized.status, 400, 'bodies over 2 KB are refused');
    assert.equal(env.pg.calls.length, 0);
    assert.equal(env.auth.links.length, 0);
  });

  const refusals: Array<[string, () => string, () => string, DeviceLoginErrorCode]> = [
    ['unknown (well-formed) secret', () => `EED-${randomBytes(32).toString('hex')}`, () => fx.users.guardA, 'device_not_enrolled'],
    ['revoked phone', () => phones.revoked.secret, () => fx.users.guardA, 'device_not_enrolled'],
    ['phone of a deactivated site', () => phones.inactiveSite.secret, () => ex.guardA4, 'device_not_enrolled'],
    ['guard of another site of the same organisation', () => phones.a1.secret, () => fx.users.guardA3, 'guard_not_allowed'],
    ['guard of another organisation', () => phones.a1.secret, () => fx.users.guardB, 'guard_not_allowed'],
    ['guard of this site on a phone of the other organisation', () => phones.b1.secret, () => fx.users.guardA, 'guard_not_allowed'],
    ['disabled guard assigned to the site', () => phones.a1.secret, () => fx.users.disabledGuardA, 'guard_not_allowed'],
    ['supervisor of the site', () => phones.a1.secret, () => fx.users.supA, 'guard_not_allowed'],
    ['org admin', () => phones.a1.secret, () => fx.users.adminA, 'guard_not_allowed'],
    ['super admin', () => phones.a1.secret, () => fx.users.superA, 'guard_not_allowed'],
    ['guard who is also a supervisor', () => phones.a1.secret, () => ex.guardSupA, 'guard_not_allowed'],
    ['guard who is also an admin', () => phones.a1.secret, () => ex.guardAdminA, 'guard_not_allowed'],
    ['client viewer assigned to the site', () => phones.a1.secret, () => fx.users.viewerA, 'guard_not_allowed'],
    ['unknown user id', () => phones.a1.secret, () => randomUUID(), 'guard_not_allowed'],
    ['guard whose account has no e-mail', () => phones.a1.secret, () => ex.noEmailA, 'guard_not_allowed']
  ];
  const statusFor: Record<DeviceLoginErrorCode, number> = {
    invalid_request: 400,
    device_not_enrolled: 401,
    guard_not_allowed: 403,
    server_not_configured: 503,
    session_failed: 502
  };

  for (const [label, secret, guardId, expected] of refusals) {
    test(`refused: ${label} → ${statusFor[expected]} ${expected}; no link, no audit row, no use recorded`, async () => {
      const env = makeEnv(base);
      const auditBefore = (await signInAuditRows(base)).length;
      const phoneStates = await Promise.all(Object.values(phones).map((phone) => deviceState(base, phone.deviceId)));

      const result = await issueGuardDeviceSession(env.deps, secret(), guardId());
      assert.deepEqual(result, { ok: false, error: expected });
      const outcome = await handleDeviceLoginRequest(httpRequest({ deviceSecret: secret(), guardId: guardId() }), env.deps);
      assert.deepEqual(outcome, { status: statusFor[expected], body: { ok: false, error: expected } });

      assert.equal(env.auth.links.length, 0, 'generateLink must not be reached');
      assert.equal((await signInAuditRows(base)).length, auditBefore, 'no sign-in audit row');
      assert.deepEqual(await Promise.all(Object.values(phones).map((phone) => deviceState(base, phone.deviceId))), phoneStates);
      assertLogsRedacted(env.logs, label);
    });
  }

  test('a guard removed from the site or disabled after the roster was shown can no longer sign in', async () => {
    await withCopy(async (db) => {
      const env = makeEnv(db);
      const roster = await getDeviceRoster(env.deps, phones.a1.secret);
      assert.ok(roster.ok && roster.guards.some((g) => g.id === fx.users.guardA2));
      await asSuperuser(db, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, fx.users.guardA2]);
      assert.deepEqual(await issueGuardDeviceSession(env.deps, phones.a1.secret, fx.users.guardA2), { ok: false, error: 'guard_not_allowed' });
      await asSuperuser(db, `UPDATE profiles SET is_active = false WHERE id = $1`, [fx.users.guardA]);
      assert.deepEqual(await issueGuardDeviceSession(env.deps, phones.a1.secret, fx.users.guardA), { ok: false, error: 'guard_not_allowed' });
      assert.equal(env.auth.links.length, 0);
    });
  });

  test('Supabase Auth failing to create the link → 502 session_failed, never a fallback success', async () => {
    await withCopy(async (db) => {
      const cases: Array<[string, (request: LinkRequest) => Promise<unknown>]> = [
        ['auth error', async () => ({ data: { properties: null, user: null }, error: { code: 'unexpected_failure', status: 500, message: 'Error for guarda@example.test' } })],
        ['no hashed_token', async () => ({ data: { properties: { hashed_token: '' }, user: null }, error: null })],
        ['thrown', async () => {
          throw new Error('connect ECONNREFUSED for guarda@example.test');
        }]
      ];
      for (const [label, override] of cases) {
        const env = makeEnv(db);
        env.auth.override = override;
        assert.deepEqual(await issueGuardDeviceSession(env.deps, phones.a1.secret, fx.users.guardA), { ok: false, error: 'session_failed' }, label);
        const outcome = await handleDeviceLoginRequest(httpRequest({ deviceSecret: phones.a1.secret, guardId: fx.users.guardA }), env.deps);
        assert.deepEqual(outcome, { status: 502, body: { ok: false, error: 'session_failed' } }, label);
        assert.equal(env.auth.links.length, 2, `${label}: the link was only asked for the authorised guard`);
        assert.ok(env.auth.links.every((link) => link.email === 'guarda@example.test' && link.type === 'magiclink'));
        assertLogsRedacted(env.logs, label);
      }
    });
  });

  test('missing service-role key → 503 server_not_configured for both routes, nothing reaches the database', async () => {
    let created = 0;
    const deps = createDeviceLoginDeps(
      () => {
        created += 1;
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
      },
      () => undefined
    );
    assert.deepEqual(await handleDeviceRosterRequest(httpRequest({ deviceSecret: phones.a1.secret }), deps), {
      status: 503,
      body: { ok: false, error: 'server_not_configured' }
    });
    assert.deepEqual(await handleDeviceLoginRequest(httpRequest({ deviceSecret: phones.a1.secret, guardId: fx.users.guardA }), deps), {
      status: 503,
      body: { ok: false, error: 'server_not_configured' }
    });
    assert.ok(created >= 1);
  });

  test('a server wired with a non-service key (anon or a user session) is refused by the database → session_failed, never "not enrolled"', async () => {
    const clients: Array<[string, PgSupabase]> = [
      ['anon', new PgSupabase(base, null)],
      ['signed-in guard', new PgSupabase(base, { userId: fx.users.guardA })],
      ['signed-in supervisor', new PgSupabase(base, { userId: fx.users.supA })],
      ['signed-in admin', new PgSupabase(base, { userId: fx.users.adminA })]
    ];
    for (const [label, pg] of clients) {
      const env = makeEnv(base, pg);
      assert.deepEqual(await getDeviceRoster(env.deps, phones.a1.secret), { ok: false, error: 'session_failed' }, `${label}: roster`);
      assert.deepEqual(
        await issueGuardDeviceSession(env.deps, phones.a1.secret, fx.users.guardA),
        { ok: false, error: 'session_failed' },
        `${label}: sign-in`
      );
      assert.equal(env.auth.links.length, 0, `${label}: no link`);
      assertLogsRedacted(env.logs, label);
    }
    assert.equal((await deviceState(base, phones.a1.deviceId)).last_used_at, null, 'nothing was recorded');
  });
});

// ---------------------------------------------------------------------------------------------
// Whole chain with the real browser library
// ---------------------------------------------------------------------------------------------

describe('patrol phone, whole chain: enrol → roster → tap → session → revoke', () => {
  test('supervisor enrols the phone, a guard taps in without typing anything, the supervisor revokes the phone', async () => {
    await withCopy(async (db) => {
      const env = makeEnv(db);
      const sent: string[] = [];
      const verified: unknown[] = [];
      const phone = new MemoryStorage();

      // 1. Supervisor signed in on the shared phone enrols it (RPC as the supervisor, RLS applies).
      const enrolled = await enrolThisPhone(new PgSupabase(db, { userId: fx.users.supA }).client, fx.siteA1, 'Night gate phone', phone);
      assert.ok(enrolled.ok, JSON.stringify(enrolled));
      const stored = await asSuperuser<{ secret_sha256: string }>(db, `SELECT secret_sha256 FROM patrol_devices WHERE id = $1`, [
        enrolled.device.deviceId
      ]);
      assert.notEqual(stored.rows[0].secret_sha256, enrolled.device.secret, 'only the hash is stored');

      // 2. The phone lists its site's guards.
      const roster = await fetchDeviceRoster({ fetch: handlerFetch(env.deps, sent), storage: phone, isOffline: online });
      assert.ok(roster.ok, JSON.stringify(roster));
      assert.equal(roster.site.name, 'Farm A1');
      const tapped = roster.guards.find((g) => g.id === fx.users.guardA);
      assert.ok(tapped, 'the guard is on the roster');

      // 3. The guard taps their name: token hash → verifyOtp → a session for exactly that guard.
      const signedIn = await signInGuardOnDevice(browserAuth(db, env.auth, verified), tapped.id, {
        fetch: handlerFetch(env.deps, sent),
        storage: phone,
        isOffline: online
      });
      assert.deepEqual(signedIn, { ok: true, userId: fx.users.guardA });
      assert.equal(verified.length, 1);
      assert.equal((verified[0] as { type: string }).type, 'magiclink');
      assert.equal(env.auth.tokens.size, 0, 'the one-time token was redeemed');

      // The phone only ever sent its secret and a roster id — never an e-mail or password.
      assert.equal(sent.length, 2);
      for (const body of sent) {
        const keys = Object.keys(JSON.parse(body) as object).sort();
        assert.ok(
          JSON.stringify(keys) === '["deviceSecret"]' || JSON.stringify(keys) === '["deviceSecret","guardId"]',
          `unexpected request body keys ${keys.join(',')}`
        );
        assert.doesNotMatch(body, /@|password/i);
      }

      // 4. The phone is revoked (e.g. lost): no more roster, and the phone forgets its enrolment.
      const revoked = await revokePatrolDevice(new PgSupabase(db, { userId: fx.users.supA }).client, enrolled.device.deviceId, null);
      assert.deepEqual(revoked, { ok: true });
      const after = await fetchDeviceRoster({ fetch: handlerFetch(env.deps, sent), storage: phone, isOffline: online });
      assert.deepEqual(after, { ok: false, error: 'not_enrolled' });
      assert.equal(phone.getItem(PATROL_DEVICE_STORAGE_KEY), null, 'local enrolment cleared on 401');
      assert.deepEqual(
        await issueGuardDeviceSession(env.deps, enrolled.device.secret, fx.users.guardA),
        { ok: false, error: 'device_not_enrolled' },
        'the old secret no longer signs anyone in'
      );

      const actions = await asSuperuser<{ action: string }>(
        db,
        `SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action`,
        [enrolled.device.deviceId]
      );
      assert.deepEqual(actions.rows.map((r) => r.action).sort(), [
        'patrol_device.enrolled',
        'patrol_device.guard_signed_in',
        'patrol_device.revoked'
      ]);
      assertLogsRedacted(env.logs, 'whole chain');
    });
  });

  test('a guard, supervisor or viewer cannot enrol a phone for a site they do not manage', async () => {
    await withCopy(async (db) => {
      const attempts: Array<[string, string, string]> = [
        ['guard', fx.users.guardA, fx.siteA1],
        ['client viewer', fx.users.viewerA, fx.siteA1],
        ['supervisor of another site', fx.users.supA, fx.siteA2],
        ['admin of another organisation', fx.users.adminB, fx.siteA1]
      ];
      for (const [label, userId, siteId] of attempts) {
        const storage = new MemoryStorage();
        const result = await enrolThisPhone(new PgSupabase(db, { userId }).client, siteId, 'Sneaky phone', storage);
        assert.equal(result.ok, false, label);
        assert.equal(!result.ok && result.error, 'not_allowed', label);
        assert.equal(loadPatrolDevice(storage), null, `${label}: nothing stored`);
      }
      const count = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_devices WHERE label = 'Sneaky phone'`);
      assert.equal(count.rows[0].n, 0);
    });
  });
});
