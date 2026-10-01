/**
 * Enrolled patrol phones (supabase/migrations/20261001000200_patrol_devices.sql).
 *
 * Guards on a shared patrol phone tap their name instead of typing an e-mail / password.
 * That is only safe because the phone must first be ENROLLED by an org admin or a
 * supervisor of the site: the phone keeps a random secret, the database keeps its SHA-256,
 * and only the server (service role) can turn a valid secret into the site's roster or into
 * a sign-in for one guard on it. These tests run every rule as the real database roles
 * (PostgREST semantics) on copies of the two-tenant fixture:
 *   - who may enrol / revoke (and who may not), the secret format and what is stored,
 *   - which devices each role can see, and that the secret hash is never readable,
 *   - device_roster / device_guard_login: service role only, only active plain guards of
 *     that site and organisation (never managers, never other sites / orgs), no contact data,
 *   - the audit trail (and that it never contains the secret),
 *   - the migration applies, re-applies and survives a later re-run of the hardening file.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  asServiceRole,
  asSuperuser,
  asUser,
  cloneTestDb,
  createTestDb,
  describeError,
  listMigrationFiles,
  runSqlFile,
  tryAsUser,
  withClaims,
  type QueryOutcome
} from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertNoRows, assertRefused } from './assertions';
import { sha256 } from '@/lib/utils/hash';

const PATROL_DEVICES = '20261001000200_patrol_devices.sql';
const HARDENING = '20261001000000_security_audit_hardening.sql';
const SECRET_FORMAT = /^EED-[0-9a-f]{64}$/;

function migrationPath(name: string): string {
  const file = listMigrationFiles().find((f) => path.basename(f) === name);
  assert.ok(file, `migration ${name} not found`);
  return file;
}

interface Enrolment {
  device_id: string;
  device_secret: string;
  site_id: string;
  site_name: string;
  label: string;
}

interface Roster {
  device: { id: string; label: string };
  site: { id: string; name: string };
  guards: Array<{ id: string; first_name: string; last_name: string }>;
}

interface GuardLogin {
  user_id: string;
  email: string;
  device_id: string;
  site_id: string;
}

/** Extra people on top of the two-tenant fixture (all org A unless noted). */
interface Extra {
  /** admin role, profile inactive */
  disabledAdminA: string;
  /** guard + supervisor, assigned to siteA1 */
  guardSupA: string;
  /** guard + admin, assigned to siteA1 */
  adminGuardA: string;
  /** plain guard "Aaron Zulu", assigned to siteA1 (sorts first in the roster) */
  aaronA: string;
  /** plain guard assigned to siteA1 whose auth user has no e-mail */
  noEmailGuardA: string;
}

let base: PGlite;
let fx: Fixture;
let ex: Extra;

async function addPerson(
  db: PGlite,
  org: string,
  first: string,
  last: string,
  active: boolean,
  roles: string[],
  sites: string[],
  email: string | null
): Promise<string> {
  const id = randomUUID();
  await asSuperuser(db, `INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  await asSuperuser(
    db,
    `INSERT INTO profiles (id, organisation_id, first_name, last_name, is_active, phone_number, employee_number)
     VALUES ($1, $2, $3, $4, $5, '+27 82 555 0101', 'EMP-777')`,
    [id, org, first, last, active]
  );
  for (const role of roles) await asSuperuser(db, `INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  for (const site of sites) await asSuperuser(db, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [site, id]);
  return id;
}

before(async () => {
  base = await createTestDb();
  fx = await seedTwoTenantFixture(base);
  ex = {
    disabledAdminA: await addPerson(base, fx.orgA, 'Disabled', 'Admin', false, ['admin'], [], 'disabledadmin@example.test'),
    guardSupA: await addPerson(base, fx.orgA, 'Dual', 'GuardSupervisor', true, ['guard', 'supervisor'], [fx.siteA1], 'dualsup@example.test'),
    adminGuardA: await addPerson(base, fx.orgA, 'Dual', 'GuardAdmin', true, ['guard', 'admin'], [fx.siteA1], 'dualadmin@example.test'),
    aaronA: await addPerson(base, fx.orgA, 'Aaron', 'Zulu', true, ['guard'], [fx.siteA1], 'aaron@example.test'),
    noEmailGuardA: await addPerson(base, fx.orgA, 'Zed', 'NoEmail', true, ['guard'], [fx.siteA1], null)
  };
  // Contact details on the fixture guards: the roster must never carry them.
  await asSuperuser(base, `UPDATE profiles SET phone_number = '+27 82 555 0199', employee_number = 'EMP-001' WHERE id = $1`, [
    fx.users.guardA
  ]);
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

/** Like tryAsUser, as the service role (the server's createServiceRoleClient()). */
async function tryAsServiceRole<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<QueryOutcome<T>> {
  try {
    const r = await withClaims(db, { role: 'service_role', sub: null }, (tx) => tx.query<T>(sql, params));
    return { ok: true, rows: r.rows, affectedRows: r.affectedRows ?? 0 };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}

/** supabase.rpc('enrol_patrol_device', ...) as `userId` (null = anon). */
function tryEnrol(db: PGlite, userId: string | null, siteId: string | null, label: string | null) {
  return tryAsUser<{ r: Enrolment }>(db, userId, `SELECT public.enrol_patrol_device($1, $2) AS r`, [siteId, label]);
}

async function enrol(db: PGlite, userId: string, siteId: string, label = 'Gate phone'): Promise<Enrolment> {
  const outcome = await tryEnrol(db, userId, siteId, label);
  assertAllowed(outcome, `enrol ${siteId} as ${userId}`);
  return outcome.rows[0].r;
}

function tryRevoke(db: PGlite, userId: string | null, deviceId: string) {
  return tryAsUser(db, userId, `SELECT public.revoke_patrol_device($1)`, [deviceId]);
}

async function roster(db: PGlite, secret: string | null): Promise<Roster | null> {
  const r = await asServiceRole<{ r: Roster | null }>(db, `SELECT public.device_roster($1) AS r`, [secret]);
  return r.rows[0].r;
}

function tryLogin(db: PGlite, secret: string | null, guardId: string | null) {
  return tryAsServiceRole<{ r: GuardLogin }>(db, `SELECT public.device_guard_login($1, $2) AS r`, [secret, guardId]);
}

/** The login must fail with SQLSTATE 42501 and exactly this message. */
function assertLoginRefused(outcome: QueryOutcome<unknown>, message: 'device_not_enrolled' | 'guard_not_allowed', label: string) {
  assertRefused(outcome, '42501', label);
  if (!outcome.ok) assert.equal(outcome.message, message, `${label}: message`);
}

function randomSecret(): string {
  return `EED-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

async function deviceRow(db: PGlite, id: string) {
  const r = await asSuperuser<{
    organisation_id: string;
    site_id: string;
    label: string;
    secret_sha256: string;
    enrolled_by: string | null;
    last_used_at: Date | null;
    last_guard_id: string | null;
    revoked_at: Date | null;
    revoked_by: string | null;
  }>(db, `SELECT * FROM patrol_devices WHERE id = $1`, [id]);
  return r.rows[0];
}

async function auditRows(db: PGlite, action: string) {
  const r = await asSuperuser<{
    organisation_id: string;
    actor_id: string | null;
    resource_type: string;
    resource_id: string | null;
    details: Record<string, unknown>;
  }>(
    db,
    `SELECT organisation_id, actor_id, resource_type, resource_id, details FROM audit_logs WHERE action = $1 ORDER BY created_at`,
    [action]
  );
  return r.rows;
}

// ------------------------------------------------------------------------------------------

describe('migration', () => {
  test('creates the table with RLS on, exactly one SELECT policy for authenticated and no write policies', async () => {
    const t = await asSuperuser<{ relrowsecurity: boolean }>(
      base,
      `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'patrol_devices'`
    );
    assert.deepEqual(t.rows, [{ relrowsecurity: true }]);
    const p = await asSuperuser<{ policyname: string; cmd: string; roles: string }>(
      base,
      `SELECT policyname, cmd, array_to_string(roles, ',') AS roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'patrol_devices'`
    );
    assert.deepEqual(p.rows, [{ policyname: 'ee_patrol_devices_select', cmd: 'SELECT', roles: 'authenticated' }]);
  });

  test('every function is SECURITY DEFINER with search_path pinned to public, pg_temp', async () => {
    const r = await asSuperuser<{ proname: string; prosecdef: boolean; config: string }>(
      base,
      `SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ';') AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('enrol_patrol_device', 'revoke_patrol_device', 'device_roster', 'device_guard_login',
                           'patrol_devices_enroller_access_changed', 'patrol_devices_site_changed',
                           'profiles_guard_names_admin_only')
       ORDER BY p.proname`
    );
    assert.deepEqual(
      r.rows.map((row) => [row.proname, row.prosecdef, row.config]),
      [
        ['device_guard_login', true, 'search_path=public, pg_temp'],
        ['device_roster', true, 'search_path=public, pg_temp'],
        ['enrol_patrol_device', true, 'search_path=public, pg_temp'],
        ['patrol_devices_enroller_access_changed', true, 'search_path=public, pg_temp'],
        ['patrol_devices_site_changed', true, 'search_path=public, pg_temp'],
        ['profiles_guard_names_admin_only', true, 'search_path=public, pg_temp'],
        ['revoke_patrol_device', true, 'search_path=public, pg_temp']
      ]
    );
  });

  test('the trigger functions are not executable by PUBLIC, anon or authenticated', async () => {
    const r = await asSuperuser<{ proname: string; anon: boolean; authn: boolean }>(
      base,
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('patrol_devices_enroller_access_changed', 'patrol_devices_site_changed', 'profiles_guard_names_admin_only')
       ORDER BY p.proname`
    );
    assert.deepEqual(
      r.rows.map((row) => [row.proname, row.anon, row.authn]),
      [
        ['patrol_devices_enroller_access_changed', false, false],
        ['patrol_devices_site_changed', false, false],
        ['profiles_guard_names_admin_only', false, false]
      ]
    );
  });

  test('function privileges: enrol / revoke for authenticated only; roster / guard login for service_role only; nothing for PUBLIC / anon', async () => {
    const r = await asSuperuser<{ proname: string; anon: boolean; authn: boolean; service: boolean; public_grant: boolean }>(
      base,
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_grant
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('enrol_patrol_device', 'revoke_patrol_device', 'device_roster', 'device_guard_login')
       ORDER BY p.proname`
    );
    assert.deepEqual(
      r.rows.map((row) => [row.proname, row.public_grant, row.anon, row.authn, row.service]),
      [
        ['device_guard_login', false, false, false, true],
        ['device_roster', false, false, false, true],
        ['enrol_patrol_device', false, false, true, false],
        ['revoke_patrol_device', false, false, true, false]
      ]
    );
  });

  test('table privileges: anon nothing; authenticated SELECT on every column except secret_sha256 and no writes', async () => {
    const cols = await asSuperuser<{ column_name: string; authn: boolean; anon: boolean }>(
      base,
      `SELECT c.column_name::text AS column_name,
              has_column_privilege('authenticated', 'public.patrol_devices', c.column_name, 'SELECT') AS authn,
              has_column_privilege('anon', 'public.patrol_devices', c.column_name, 'SELECT') AS anon
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'patrol_devices'
       ORDER BY c.ordinal_position`
    );
    assert.deepEqual(
      cols.rows.map((row) => row.column_name),
      [
        'id',
        'organisation_id',
        'site_id',
        'label',
        'secret_sha256',
        'enrolled_by',
        'enrolled_at',
        'last_used_at',
        'last_guard_id',
        'revoked_at',
        'revoked_by',
        'created_at'
      ]
    );
    assert.deepEqual(
      cols.rows.filter((row) => !row.authn).map((row) => row.column_name),
      ['secret_sha256']
    );
    assert.deepEqual(
      cols.rows.filter((row) => row.anon).map((row) => row.column_name),
      []
    );
    const table = await asSuperuser<Record<string, boolean>>(
      base,
      `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        .flatMap((priv) => [
          `has_table_privilege('authenticated', 'public.patrol_devices', '${priv}') AS "authn_${priv}"`,
          `has_table_privilege('anon', 'public.patrol_devices', '${priv}') AS "anon_${priv}"`
        ])
        .join(', ')}`
    );
    for (const [key, value] of Object.entries(table.rows[0])) assert.equal(value, false, key);
  });

  test('the SQL creates nothing in auth / storage, needs no extension and contains no secret', () => {
    const sql = readFileSync(migrationPath(PATROL_DEVICES), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|TRIGGER)\s+(auth|storage)\./i);
    assert.doesNotMatch(sql, /ALTER\s+TABLE\s+(auth|storage)\./i);
    assert.doesNotMatch(sql, /CREATE\s+EXTENSION|gen_random_bytes|extensions\./i);
    assert.doesNotMatch(sql, /EED-[0-9a-f]{8}/i, 'no literal device secret');
    const functions = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? [];
    // 4 RPCs + 3 trigger functions (automatic revocation, guard names).
    assert.equal(functions.length, 7);
    for (const fn of functions) assert.match(fn, /SECURITY DEFINER\s+SET search_path = public, pg_temp/);
  });

  test('re-applying the migration (twice) changes nothing and keeps enrolled phones working', () =>
    withCopy(async (db) => {
      const e = await enrol(db, fx.users.adminA, fx.siteA1);
      const snapshot = async () => {
        const r = await asSuperuser<{ s: string }>(
          db,
          `SELECT concat_ws(' | ',
             (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE tablename = 'patrol_devices'),
             (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.patrol_devices'::regclass),
             (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'patrol_devices'),
             (SELECT relacl::text FROM pg_class WHERE oid = 'public.patrol_devices'::regclass),
             (SELECT string_agg(attname || '=' || coalesce(attacl::text, ''), ',' ORDER BY attnum) FROM pg_attribute
                WHERE attrelid = 'public.patrol_devices'::regclass AND attnum > 0),
             (SELECT string_agg(p.proname || '=' || coalesce(p.proacl::text, ''), ',' ORDER BY p.proname) FROM pg_proc p
                WHERE p.proname IN ('enrol_patrol_device', 'revoke_patrol_device', 'device_roster', 'device_guard_login'))
           ) AS s`
        );
        return r.rows[0].s;
      };
      const before = await snapshot();
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      assert.equal(await snapshot(), before);
      const count = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_devices`);
      assert.equal(count.rows[0].n, 1);
      assert.equal((await roster(db, e.device_secret))?.device.id, e.device_id);
    }));

  test('refuses to run before the hardening migration, with a clear message', async () => {
    const db = await createTestDb({ upTo: '20260930000100_phase2_hardening.sql' });
    try {
      await assert.rejects(runSqlFile(db, migrationPath(PATROL_DEVICES)), /Apply 20261001000000_security_audit_hardening\.sql before/);
    } finally {
      await db.close();
    }
  });

  test('live path: initial schema -> hardening -> patrol devices (phase 2 never ran), pasted twice', async () => {
    const db = await createTestDb({ upTo: '20260930000000_init_schema.sql' });
    try {
      await runSqlFile(db, migrationPath(HARDENING));
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'device_guard_login'`);
      assert.equal(r.rows[0].n, 1);
    } finally {
      await db.close();
    }
  });

  test('a later re-run of the hardening migration does not open the service-role functions; re-running this file restores the grants', () =>
    withCopy(async (db) => {
      const e = await enrol(db, fx.users.adminA, fx.siteA1);
      await runSqlFile(db, migrationPath(HARDENING));
      // The hardening file grants EXECUTE on every public function to authenticated ...
      const granted = await asSuperuser<{ ok: boolean }>(
        db,
        `SELECT has_function_privilege('authenticated', 'public.device_roster(text)', 'EXECUTE') AS ok`
      );
      assert.equal(granted.rows[0].ok, true);
      // ... but the function bodies still refuse signed-in callers.
      for (const who of [fx.users.adminA, fx.users.guardA]) {
        assertRefused(await tryAsUser(db, who, `SELECT public.device_roster($1)`, [e.device_secret]), '42501', 'roster as user');
        assertRefused(
          await tryAsUser(db, who, `SELECT public.device_guard_login($1, $2)`, [e.device_secret, fx.users.guardA]),
          '42501',
          'guard login as user'
        );
      }
      assert.equal((await roster(db, e.device_secret))?.device.id, e.device_id, 'service role still works');
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      const restored = await asSuperuser<{ roster: boolean; login: boolean; enrol: boolean }>(
        db,
        `SELECT has_function_privilege('authenticated', 'public.device_roster(text)', 'EXECUTE') AS roster,
                has_function_privilege('authenticated', 'public.device_guard_login(text, uuid)', 'EXECUTE') AS login,
                has_function_privilege('authenticated', 'public.enrol_patrol_device(uuid, text)', 'EXECUTE') AS enrol`
      );
      assert.deepEqual(restored.rows[0], { roster: false, login: false, enrol: true });
    }));
});

// ------------------------------------------------------------------------------------------

describe('enrol_patrol_device', () => {
  test('an org admin (any site of the org), a super_admin and a supervisor assigned to the site may enrol', () =>
    withCopy(async (db) => {
      const u = fx.users;
      for (const [who, site, siteName] of [
        [u.adminA, fx.siteA1, 'Farm A1'],
        [u.adminA, fx.siteA2, 'Farm A2'],
        [u.superA, fx.siteA2, 'Farm A2'],
        [u.supA, fx.siteA1, 'Farm A1'],
        [u.adminB, fx.siteB1, 'Farm B1']
      ] as const) {
        const e = await enrol(db, who, site, '  Gate phone 1  ');
        assert.equal(e.site_id, site);
        assert.equal(e.site_name, siteName);
        assert.equal(e.label, 'Gate phone 1', 'label is trimmed');
        assert.match(e.device_secret, SECRET_FORMAT);
        const row = await deviceRow(db, e.device_id);
        assert.equal(row.site_id, site);
        assert.equal(row.enrolled_by, who);
        assert.equal(row.label, 'Gate phone 1');
        assert.equal(row.revoked_at, null);
        assert.equal(row.organisation_id, site === fx.siteB1 ? fx.orgB : fx.orgA);
      }
    }));

  test('refused (42501) for a supervisor of another site, a guard, a client viewer, a disabled admin, another org, anon and unknown sites', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const cases: Array<[string, string | null, string | null]> = [
        ['supervisor of another site', u.supA, fx.siteA2],
        ['guard', u.guardA, fx.siteA1],
        ['guard + supervisor, other site', ex.guardSupA, fx.siteA2],
        ['client viewer', u.viewerA, fx.siteA1],
        ['disabled guard', u.disabledGuardA, fx.siteA1],
        ['disabled admin', ex.disabledAdminA, fx.siteA1],
        ['admin of another organisation', u.adminB, fx.siteA1],
        ['guard of another organisation', u.guardB, fx.siteA1],
        ['anon', null, fx.siteA1],
        ['unknown site', u.adminA, randomUUID()],
        ['no site', u.adminA, null]
      ];
      for (const [label, who, site] of cases) {
        assertRefused(await tryEnrol(db, who, site, 'Gate phone'), '42501', label);
      }
      const n = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_devices`);
      assert.equal(n.rows[0].n, 0, 'nothing was written');
      assert.equal((await auditRows(db, 'patrol_device.enrolled')).length, 0);
    }));

  test('the label must be 1 to 80 characters after trimming (22023)', () =>
    withCopy(async (db) => {
      const a = fx.users.adminA;
      for (const bad of ['', '    ', null, 'x'.repeat(81)]) {
        assertRefused(await tryEnrol(db, a, fx.siteA1, bad), '22023', `label ${JSON.stringify(bad)}`);
      }
      const max = await enrol(db, a, fx.siteA1, `  ${'x'.repeat(80)}  `);
      assert.equal(max.label.length, 80);
      const accents = await enrol(db, a, fx.siteA1, 'Hek-foon Ntabeni');
      assert.equal(accents.label, 'Hek-foon Ntabeni');
    }));

  test('the secret is EED- + 64 hex, unique per enrolment, and only its SHA-256 is stored', () =>
    withCopy(async (db) => {
      const a = fx.users.adminA;
      const one = await enrol(db, a, fx.siteA1);
      const two = await enrol(db, a, fx.siteA1);
      assert.match(one.device_secret, SECRET_FORMAT);
      assert.match(two.device_secret, SECRET_FORMAT);
      assert.notEqual(one.device_secret, two.device_secret);
      const row = await deviceRow(db, one.device_id);
      assert.equal(row.secret_sha256, await sha256(one.device_secret));
      const leaked = await asSuperuser<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM patrol_devices d WHERE to_jsonb(d)::text LIKE '%' || $1 || '%'`,
        [one.device_secret.slice(4)]
      );
      assert.equal(leaked.rows[0].n, 0, 'the raw secret is not stored');
    }));
});

// ------------------------------------------------------------------------------------------

describe('reading patrol_devices', () => {
  test('nobody signed in can read secret_sha256 (permission error), other columns are readable', () =>
    withCopy(async (db) => {
      await enrol(db, fx.users.adminA, fx.siteA1);
      const u = fx.users;
      for (const who of [u.adminA, u.superA, u.supA, u.guardA, u.viewerA]) {
        for (const sql of [
          `SELECT secret_sha256 FROM patrol_devices`,
          `SELECT * FROM patrol_devices`,
          `SELECT id FROM patrol_devices WHERE secret_sha256 LIKE 'a%'`
        ]) {
          assertRefused(await tryAsUser(db, who, sql), '42501', `${who}: ${sql}`);
        }
      }
      const ok = await tryAsUser(
        db,
        u.adminA,
        `SELECT id, organisation_id, site_id, label, enrolled_by, enrolled_at, last_used_at, last_guard_id,
                revoked_at, revoked_by, created_at FROM patrol_devices`
      );
      assertAllowed(ok);
      assert.equal(ok.rows.length, 1);
    }));

  test('anon gets a permission error; managers see only devices of the sites they manage', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const a1 = await enrol(db, u.adminA, fx.siteA1, 'A1 phone');
      const a2 = await enrol(db, u.adminA, fx.siteA2, 'A2 phone');
      const b1 = await enrol(db, u.adminB, fx.siteB1, 'B1 phone');
      assertRefused(await tryAsUser(db, null, `SELECT id FROM patrol_devices`), '42501', 'anon');
      const visible = async (who: string) => {
        const r = await asUser<{ id: string }>(db, who, `SELECT id FROM patrol_devices ORDER BY label`);
        return r.rows.map((row) => row.id);
      };
      assert.deepEqual(await visible(u.adminA), [a1.device_id, a2.device_id]);
      assert.deepEqual(await visible(u.superA), [a1.device_id, a2.device_id]);
      assert.deepEqual(await visible(u.supA), [a1.device_id]);
      assert.deepEqual(await visible(u.adminB), [b1.device_id]);
      for (const who of [u.guardA, u.guardA3, u.viewerA, u.disabledGuardA, ex.disabledAdminA, u.guardB]) {
        assert.deepEqual(await visible(who), [], `${who} sees no devices`);
      }
    }));

  test('no direct INSERT / UPDATE / DELETE, not even for an org admin', () =>
    withCopy(async (db) => {
      const a = fx.users.adminA;
      const e = await enrol(db, a, fx.siteA1);
      assertRefused(
        await tryAsUser(
          db,
          a,
          `INSERT INTO patrol_devices (organisation_id, site_id, label, secret_sha256) VALUES ($1, $2, 'x', $3)`,
          [fx.orgA, fx.siteA1, await sha256(randomSecret())]
        ),
        '42501',
        'insert'
      );
      assertRefused(await tryAsUser(db, a, `UPDATE patrol_devices SET revoked_at = NULL WHERE id = $1`, [e.device_id]), '42501', 'update');
      assertRefused(await tryAsUser(db, a, `UPDATE patrol_devices SET label = 'renamed' WHERE id = $1`, [e.device_id]), '42501', 'update label');
      assertRefused(await tryAsUser(db, a, `DELETE FROM patrol_devices WHERE id = $1`, [e.device_id]), '42501', 'delete');
      assertRefused(await tryAsUser(db, null, `DELETE FROM patrol_devices`), '42501', 'anon delete');
    }));
});

// ------------------------------------------------------------------------------------------

describe('revoke_patrol_device', () => {
  test('a supervisor of the site revokes an admin-enrolled phone; it stops working at once', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      assertAllowed(await tryLogin(db, e.device_secret, u.guardA));
      assertAllowed(await tryRevoke(db, u.supA, e.device_id), 'supervisor revokes');
      const row = await deviceRow(db, e.device_id);
      assert.ok(row.revoked_at instanceof Date);
      assert.equal(row.revoked_by, u.supA);
      assert.equal(await roster(db, e.device_secret), null);
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA), 'device_not_enrolled', 'login after revoke');
    }));

  test('refused (42501) for other sites, other orgs, guards, viewers, disabled admins, anon, and unknown devices alike', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const a1 = await enrol(db, u.adminA, fx.siteA1);
      const a2 = await enrol(db, u.adminA, fx.siteA2);
      const cases: Array<[string, string | null, string]> = [
        ['supervisor of another site', u.supA, a2.device_id],
        ['guard of the site', u.guardA, a1.device_id],
        ['client viewer of the site', u.viewerA, a1.device_id],
        ['disabled admin', ex.disabledAdminA, a1.device_id],
        ['admin of another organisation', u.adminB, a1.device_id],
        ['anon', null, a1.device_id],
        ['unknown device', u.adminA, randomUUID()]
      ];
      const messages = new Set<string>();
      for (const [label, who, device] of cases) {
        const outcome = await tryRevoke(db, who, device);
        assertRefused(outcome, '42501', label);
        if (!outcome.ok && who !== null) messages.add(outcome.message);
      }
      assert.equal(messages.size, 1, 'an unknown device gets the same refusal as a foreign one');
      for (const id of [a1.device_id, a2.device_id]) assert.equal((await deviceRow(db, id)).revoked_at, null);
      assert.equal((await auditRows(db, 'patrol_device.revoked')).length, 0);
    }));

  test('revoking twice keeps the first revocation (time, actor) and writes one audit row', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.supA, fx.siteA1);
      assertAllowed(await tryRevoke(db, u.supA, e.device_id));
      const first = await deviceRow(db, e.device_id);
      assertAllowed(await tryRevoke(db, u.adminA, e.device_id), 'second revoke is a no-op, not an error');
      const second = await deviceRow(db, e.device_id);
      assert.deepEqual([second.revoked_at, second.revoked_by], [first.revoked_at, u.supA]);
      assert.equal((await auditRows(db, 'patrol_device.revoked')).length, 1);
    }));
});

// ------------------------------------------------------------------------------------------

describe('device_roster (service role only)', () => {
  test('lists only the active plain guards assigned to the phone\'s site, in name order, names only', () =>
    withCopy(async (db) => {
      const u = fx.users;
      // A guard of org B wrongly assigned to an org A site must still not appear.
      await asSuperuser(db, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA1, u.guardB]);
      const e = await enrol(db, u.supA, fx.siteA1, 'Main gate phone');
      const r = await roster(db, e.device_secret);
      assert.ok(r);
      assert.deepEqual(r.device, { id: e.device_id, label: 'Main gate phone' });
      assert.deepEqual(r.site, { id: fx.siteA1, name: 'Farm A1' });
      assert.deepEqual(r.guards, [
        { id: ex.aaronA, first_name: 'Aaron', last_name: 'Zulu' },
        { id: u.guardA, first_name: 'Guard', last_name: 'guardA' },
        { id: u.guardA2, first_name: 'Guard', last_name: 'guardA2' },
        { id: ex.noEmailGuardA, first_name: 'Zed', last_name: 'NoEmail' }
      ]);
      // Never managers, viewers, disabled guards, other sites or other organisations.
      const ids = r.guards.map((g) => g.id);
      for (const id of [u.supA, u.adminA, u.superA, u.viewerA, u.disabledGuardA, u.guardA3, u.guardB, ex.guardSupA, ex.adminGuardA]) {
        assert.ok(!ids.includes(id), `${id} must not be on the roster`);
      }
      // No contact data of any kind.
      const text = JSON.stringify(r);
      for (const leak of ['@', '+27', 'EMP-', 'phone_number', 'employee_number', 'email']) {
        assert.ok(!text.includes(leak), `roster contains ${leak}`);
      }
      for (const g of r.guards) assert.deepEqual(Object.keys(g).sort(), ['first_name', 'id', 'last_name']);
      assert.deepEqual(Object.keys(r).sort(), ['device', 'guards', 'site']);
    }));

  test('a phone of another site lists that site\'s guards only; an empty site gives an empty list', () =>
    withCopy(async (db) => {
      const a2 = await enrol(db, fx.users.adminA, fx.siteA2);
      assert.deepEqual(
        (await roster(db, a2.device_secret))?.guards.map((g) => g.id),
        [fx.users.guardA3]
      );
      const b1 = await enrol(db, fx.users.adminB, fx.siteB1);
      assert.deepEqual(
        (await roster(db, b1.device_secret))?.guards.map((g) => g.id),
        [fx.users.guardB]
      );
      await asSuperuser(db, `DELETE FROM site_assignments WHERE site_id = $1`, [fx.siteA2]);
      assert.deepEqual((await roster(db, a2.device_secret))?.guards, []);
    }));

  test('NULL for an unknown, malformed or missing secret, a revoked phone and an inactive site', () =>
    withCopy(async (db) => {
      const e = await enrol(db, fx.users.adminA, fx.siteA1);
      for (const secret of [
        randomSecret(),
        e.device_secret.toUpperCase(),
        e.device_secret.slice(0, -1),
        `${e.device_secret}0`,
        e.device_secret.slice(4),
        await sha256(e.device_secret),
        '',
        null
      ]) {
        assert.equal(await roster(db, secret), null, `secret ${String(secret)}`);
      }
      assertAllowed(await tryRevoke(db, fx.users.adminA, e.device_id));
      assert.equal(await roster(db, e.device_secret), null, 'revoked');
      // An inactive site: see 'automatic revocation' below (the phone is revoked with it).
      const other = await enrol(db, fx.users.adminA, fx.siteA1);
      await asSuperuser(db, `UPDATE sites SET is_active = false WHERE id = $1`, [fx.siteA1]);
      assert.equal(await roster(db, other.device_secret), null, 'inactive site');
    }));

  test('not executable by any signed-in user or by anon, even with a valid secret', () =>
    withCopy(async (db) => {
      const e = await enrol(db, fx.users.adminA, fx.siteA1);
      const u = fx.users;
      for (const who of [null, u.guardA, u.supA, u.adminA, u.superA, u.viewerA]) {
        assertRefused(await tryAsUser(db, who, `SELECT public.device_roster($1)`, [e.device_secret]), '42501', `roster as ${who}`);
      }
    }));
});

// ------------------------------------------------------------------------------------------

describe('device_guard_login (service role only)', () => {
  test('signs in an assigned guard: returns that guard\'s auth e-mail and records the use', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.supA, fx.siteA1);
      const before = await deviceRow(db, e.device_id);
      assert.equal(before.last_used_at, null);
      const outcome = await tryLogin(db, e.device_secret, u.guardA);
      assertAllowed(outcome);
      assert.deepEqual(outcome.rows[0].r, {
        user_id: u.guardA,
        email: 'guarda@example.test',
        device_id: e.device_id,
        site_id: fx.siteA1
      });
      const after = await deviceRow(db, e.device_id);
      assert.ok(after.last_used_at instanceof Date);
      assert.equal(after.last_guard_id, u.guardA);

      const second = await tryLogin(db, e.device_secret, u.guardA2);
      assertAllowed(second);
      assert.equal(second.rows[0].r.email, 'guarda2@example.test');
      assert.equal((await deviceRow(db, e.device_id)).last_guard_id, u.guardA2);
    }));

  test("refuses unknown, malformed and revoked phones and phones of an inactive site ('device_not_enrolled')", () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      for (const secret of [randomSecret(), e.device_secret.toUpperCase(), e.device_secret.slice(4), await sha256(e.device_secret), '', null]) {
        assertLoginRefused(await tryLogin(db, secret, u.guardA), 'device_not_enrolled', `secret ${String(secret)}`);
      }
      assertAllowed(await tryRevoke(db, u.adminA, e.device_id));
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA), 'device_not_enrolled', 'revoked');
      const other = await enrol(db, u.adminA, fx.siteA1);
      await asSuperuser(db, `UPDATE sites SET is_active = false WHERE id = $1`, [fx.siteA1]);
      assertLoginRefused(await tryLogin(db, other.device_secret, u.guardA), 'device_not_enrolled', 'inactive site');
    }));

  test("refuses everyone who is not an active plain guard of the phone's site and organisation ('guard_not_allowed')", () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      // guardB (org B) additionally gets a (corrupt) assignment to the org A site.
      await asSuperuser(db, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA1, u.guardB]);
      const cases: Array<[string, string | null]> = [
        ['guard of another site', u.guardA3],
        ['guard of another organisation (even if assigned)', u.guardB],
        ['inactive guard', u.disabledGuardA],
        ['guard + supervisor', ex.guardSupA],
        ['guard + admin', ex.adminGuardA],
        ['supervisor of the site', u.supA],
        ['org admin', u.adminA],
        ['super_admin', u.superA],
        ['client viewer of the site', u.viewerA],
        ['admin of another organisation', u.adminB],
        ['disabled admin', ex.disabledAdminA],
        ['guard without an e-mail address', ex.noEmailGuardA],
        ['unknown user', randomUUID()],
        ['no user', null]
      ];
      for (const [label, who] of cases) {
        assertLoginRefused(await tryLogin(db, e.device_secret, who), 'guard_not_allowed', label);
      }
      const row = await deviceRow(db, e.device_id);
      assert.deepEqual([row.last_used_at, row.last_guard_id], [null, null], 'refusals leave no trace on the device');
      assert.equal((await auditRows(db, 'patrol_device.guard_signed_in')).length, 0);
    }));

  test('a guard removed from the site or deactivated after enrolment can no longer sign in on it', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      assertAllowed(await tryLogin(db, e.device_secret, u.guardA));
      await asSuperuser(db, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, u.guardA]);
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA), 'guard_not_allowed', 'unassigned');
      assertAllowed(await tryLogin(db, e.device_secret, u.guardA2));
      await asSuperuser(db, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.guardA2]);
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA2), 'guard_not_allowed', 'deactivated');
      await asSuperuser(db, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [ex.aaronA]);
      assertLoginRefused(await tryLogin(db, e.device_secret, ex.aaronA), 'guard_not_allowed', 'promoted to supervisor');
    }));

  test('not executable by any signed-in user (including the guard) or by anon', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      for (const who of [null, u.guardA, u.supA, u.adminA, u.viewerA]) {
        assertRefused(
          await tryAsUser(db, who, `SELECT public.device_guard_login($1, $2)`, [e.device_secret, u.guardA]),
          '42501',
          `guard login as ${who}`
        );
      }
      assert.equal((await deviceRow(db, e.device_id)).last_used_at, null);
    }));
});

// ------------------------------------------------------------------------------------------

describe('audit trail', () => {
  test('enrolment, device sign-in and revocation are audited with ids only, never the secret or its hash', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.supA, fx.siteA1, 'Night gate');
      assertAllowed(await tryLogin(db, e.device_secret, u.guardA));
      assertAllowed(await tryRevoke(db, u.adminA, e.device_id));

      assert.deepEqual(await auditRows(db, 'patrol_device.enrolled'), [
        {
          organisation_id: fx.orgA,
          actor_id: u.supA,
          resource_type: 'patrol_devices',
          resource_id: e.device_id,
          details: { device_id: e.device_id, site_id: fx.siteA1, label: 'Night gate' }
        }
      ]);
      assert.deepEqual(await auditRows(db, 'patrol_device.guard_signed_in'), [
        {
          organisation_id: fx.orgA,
          actor_id: u.guardA,
          resource_type: 'patrol_devices',
          resource_id: e.device_id,
          details: { device_id: e.device_id, site_id: fx.siteA1 }
        }
      ]);
      assert.deepEqual(await auditRows(db, 'patrol_device.revoked'), [
        {
          organisation_id: fx.orgA,
          actor_id: u.adminA,
          resource_type: 'patrol_devices',
          resource_id: e.device_id,
          details: { device_id: e.device_id, site_id: fx.siteA1, label: 'Night gate' }
        }
      ]);

      const hash = await sha256(e.device_secret);
      const leaked = await asSuperuser<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM audit_logs a
         WHERE to_jsonb(a)::text LIKE '%' || $1 || '%' OR to_jsonb(a)::text LIKE '%' || $2 || '%'`,
        [e.device_secret.slice(4), hash]
      );
      assert.equal(leaked.rows[0].n, 0);
    }));

  test('the org admin reads the patrol-phone audit rows of their organisation; nobody can change them', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      await enrol(db, u.adminB, fx.siteB1);
      const r = await asUser<{ action: string; resource_id: string }>(
        db,
        u.adminA,
        `SELECT action, resource_id FROM audit_logs WHERE action LIKE 'patrol_device.%'`
      );
      assert.deepEqual(r.rows, [{ action: 'patrol_device.enrolled', resource_id: e.device_id }]);
      assertNoRows(await tryAsUser(db, u.supA, `SELECT id FROM audit_logs WHERE action LIKE 'patrol_device.%'`), 'supervisor');
      assertRefused(await tryAsUser(db, u.adminA, `DELETE FROM audit_logs WHERE action LIKE 'patrol_device.%'`), '42501', 'delete audit');
    }));
});

// ------------------------------------------------------------------------------------------

describe("automatic revocation (a phone never outlives its enroller's right to manage the site)", () => {
  /** The phone is dead on every path: row revoked, no roster, no sign-in. */
  async function assertDead(db: PGlite, e: Enrolment, label: string) {
    const row = await deviceRow(db, e.device_id);
    assert.ok(row.revoked_at instanceof Date, `${label}: revoked_at is set`);
    assert.equal(await roster(db, e.device_secret), null, `${label}: no roster`);
    assertLoginRefused(await tryLogin(db, e.device_secret, fx.users.guardA), 'device_not_enrolled', `${label}: no sign-in`);
  }

  async function assertAlive(db: PGlite, e: Enrolment, label: string) {
    assert.equal((await deviceRow(db, e.device_id)).revoked_at, null, `${label}: not revoked`);
    assert.ok(await roster(db, e.device_secret), `${label}: roster still works`);
  }

  async function revokedReasons(db: PGlite) {
    return (await auditRows(db, 'patrol_device.revoked')).map((a) => [a.resource_id, a.actor_id, a.details.reason]);
  }

  test('deactivating the enrolling supervisor revokes the phones they enrolled (audited, actor = the admin)', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const bySup = await enrol(db, u.supA, fx.siteA1, 'Sup phone');
      const byAdmin = await enrol(db, u.adminA, fx.siteA1, 'Admin phone');
      assertAllowed(await tryAsUser(db, u.adminA, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.supA]));
      await assertDead(db, bySup, 'enroller deactivated');
      assert.equal((await deviceRow(db, bySup.device_id)).revoked_by, u.adminA);
      await assertAlive(db, byAdmin, 'phone of another enroller');
      assert.deepEqual(await revokedReasons(db), [[bySup.device_id, u.adminA, 'enroller_deactivated']]);
      // Re-activating the supervisor does not bring the phone back: enrol it again.
      assertAllowed(await tryAsUser(db, u.adminA, `UPDATE profiles SET is_active = true WHERE id = $1`, [u.supA]));
      await assertDead(db, bySup, 'enroller re-activated');
    }));

  test('unassigning the supervisor from the site, or removing their supervisor role, revokes their phones of that site', () =>
    withCopy(async (db) => {
      const u = fx.users;
      await asSuperuser(db, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA2, u.supA]);
      const a1 = await enrol(db, u.supA, fx.siteA1, 'A1 phone');
      const a2 = await enrol(db, u.supA, fx.siteA2, 'A2 phone');
      assertAllowed(
        await tryAsUser(db, u.adminA, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, u.supA])
      );
      await assertDead(db, a1, 'unassigned from A1');
      assert.equal((await deviceRow(db, a2.device_id)).revoked_at, null, 'the A2 phone stays (still assigned there)');
      assertAllowed(await tryAsUser(db, u.adminA, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'supervisor'`, [u.supA]));
      assert.ok((await deviceRow(db, a2.device_id)).revoked_at instanceof Date, 'supervisor role removed');
      assert.deepEqual(
        (await revokedReasons(db)).map(([, , reason]) => reason),
        ['enroller_unassigned', 'enroller_role_removed']
      );
    }));

  test('an admin enroller needs no assignment; losing the admin role, or being deleted, revokes the phone', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA2);
      await asSuperuser(db, `DELETE FROM site_assignments WHERE user_id = $1`, [u.adminA]);
      await assertAlive(db, e, 'admin without assignments');
      await asSuperuser(db, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'admin'`, [u.adminA]);
      await assertDead(db, e, 'admin role removed');

      const bySuper = await enrol(db, u.superA, fx.siteA1);
      await asSuperuser(db, `DELETE FROM profiles WHERE id = $1`, [u.superA]);
      const row = await deviceRow(db, bySuper.device_id);
      assert.equal(row.enrolled_by, null, 'the enroller reference is cleared by the cascade');
      assert.ok(row.revoked_at instanceof Date, 'but the phone was revoked first');
      assert.equal(await roster(db, bySuper.device_secret), null);
      assert.deepEqual((await revokedReasons(db)).at(-1), [bySuper.device_id, null, 'enroller_deleted']);
    }));

  test('the use-time check refuses a phone whose enroller no longer qualifies even when the triggers did not run', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.supA, fx.siteA1);
      // e.g. a restore or bulk load with triggers off.
      await db.transaction(async (tx) => {
        await tx.query(`SET LOCAL session_replication_role = replica`);
        await tx.query(`DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, u.supA]);
      });
      assert.equal((await deviceRow(db, e.device_id)).revoked_at, null, 'no trigger ran');
      assert.equal(await roster(db, e.device_secret), null);
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA), 'device_not_enrolled', 'enroller unassigned');
      // A row without an enroller at all never works.
      const orphan = randomSecret();
      await asSuperuser(
        db,
        `INSERT INTO patrol_devices (organisation_id, site_id, label, secret_sha256, enrolled_by) VALUES ($1, $2, 'x', $3, NULL)`,
        [fx.orgA, fx.siteA1, await sha256(orphan)]
      );
      assert.equal(await roster(db, orphan), null);
      assertLoginRefused(await tryLogin(db, orphan, u.guardA), 'device_not_enrolled', 'no enroller');
      // Re-running the migration revokes such rows so the list shows the truth.
      await runSqlFile(db, migrationPath(PATROL_DEVICES));
      const active = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_devices WHERE revoked_at IS NULL`);
      assert.equal(active.rows[0].n, 0);
    }));

  test('switching a site off revokes its phones (switching it on again does not revive them)', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const a1 = await enrol(db, u.supA, fx.siteA1);
      const a2 = await enrol(db, u.adminA, fx.siteA2);
      assertAllowed(await tryAsUser(db, u.adminA, `UPDATE sites SET is_active = false WHERE id = $1`, [fx.siteA1]));
      await assertDead(db, a1, 'site off');
      await assertAlive(db, a2, 'other site');
      assertAllowed(await tryAsUser(db, u.adminA, `UPDATE sites SET is_active = true WHERE id = $1`, [fx.siteA1]));
      await assertDead(db, a1, 'site on again');
      assert.deepEqual(await revokedReasons(db), [[a1.device_id, u.adminA, 'site_deactivated']]);
    }));

  test('deleting a site or a profile that has patrol phones still works (cascade)', () =>
    withCopy(async (db) => {
      const u = fx.users;
      // A fresh organisation C (no evidence rows that would RESTRICT a delete): admin, supervisor, two sites.
      // (An organisation itself cannot be deleted once it has audit rows - they are immutable.)
      const orgC = randomUUID();
      const [siteC1, siteC2] = [randomUUID(), randomUUID()];
      await asSuperuser(db, `INSERT INTO organisations (id, name) VALUES ($1, 'Org C')`, [orgC]);
      await asSuperuser(db, `INSERT INTO sites (id, organisation_id, name, code) VALUES ($1, $3, 'C1', 'C1'), ($2, $3, 'C2', 'C2')`, [
        siteC1,
        siteC2,
        orgC
      ]);
      const adminC = await addPerson(db, orgC, 'Admin', 'C', true, ['admin'], [], 'adminc@example.test');
      const supC = await addPerson(db, orgC, 'Sup', 'C', true, ['supervisor'], [siteC1, siteC2], 'supc@example.test');
      await enrol(db, adminC, siteC1);
      await enrol(db, supC, siteC2);
      await enrol(db, supC, siteC1);
      await asSuperuser(db, `DELETE FROM sites WHERE id = $1`, [siteC2]);
      await asSuperuser(db, `DELETE FROM profiles WHERE id = $1`, [supC]);
      const count = async () =>
        (await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_devices WHERE organisation_id = $1`, [orgC])).rows[0].n;
      assert.equal(await count(), 2, 'the C1 phones are kept (one revoked with its enroller)');
      const active = await asSuperuser<{ enrolled_by: string | null }>(
        db,
        `SELECT enrolled_by FROM patrol_devices WHERE organisation_id = $1 AND revoked_at IS NULL`,
        [orgC]
      );
      assert.deepEqual(active.rows, [{ enrolled_by: adminC }]);
      // Organisation A's phone is untouched.
      const a = await enrol(db, u.adminA, fx.siteA1);
      assert.ok(await roster(db, a.device_secret));
    }));
});

// ------------------------------------------------------------------------------------------

describe('who is a "guard" on a patrol phone (allow-list)', () => {
  test('a guard who also holds client_viewer (or any role besides guard) is neither listed nor signed in', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      await asSuperuser(db, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'client_viewer')`, [u.guardA]);
      assert.ok(!(await roster(db, e.device_secret))?.guards.some((g) => g.id === u.guardA), 'not listed');
      assertLoginRefused(await tryLogin(db, e.device_secret, u.guardA), 'guard_not_allowed', 'guard + client_viewer');
      await asSuperuser(db, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'client_viewer'`, [u.guardA]);
      assertAllowed(await tryLogin(db, e.device_secret, u.guardA), 'plain guard again');
    }));
});

// ------------------------------------------------------------------------------------------

describe('guard names are admin-controlled (they are the buttons on the phone)', () => {
  test('a guard cannot rename themselves into a second button of a colleague; phone and language stay self-service', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const e = await enrol(db, u.adminA, fx.siteA1);
      assertRefused(
        await tryAsUser(db, u.guardA, `UPDATE profiles SET first_name = 'Guard', last_name = 'guardA2' WHERE id = $1`, [u.guardA]),
        '42501',
        'guard renames themselves'
      );
      assertRefused(await tryAsUser(db, u.guardA, `UPDATE profiles SET last_name = 'X' WHERE id = $1`, [u.guardA]), '42501', 'last name only');
      const names = (await roster(db, e.device_secret))?.guards.map((g) => `${g.first_name} ${g.last_name}`) ?? [];
      assert.equal(new Set(names).size, names.length, 'no duplicate buttons');
      const own = await tryAsUser(db, u.guardA, `UPDATE profiles SET phone_number = '0821234567', preferred_language = 'zu' WHERE id = $1`, [
        u.guardA
      ]);
      assertAllowed(own);
      assert.equal(own.affectedRows, 1);
    }));

  test('the org admin (and the service role) can correct a guard name; a supervisor can still rename themselves', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const admin = await tryAsUser(db, u.adminA, `UPDATE profiles SET first_name = 'Sipho' WHERE id = $1`, [u.guardA]);
      assertAllowed(admin);
      assert.equal(admin.affectedRows, 1);
      await asServiceRole(db, `UPDATE profiles SET last_name = 'Dlamini' WHERE id = $1`, [u.guardA]);
      const sup = await tryAsUser(db, u.supA, `UPDATE profiles SET first_name = 'Johan' WHERE id = $1`, [u.supA]);
      assertAllowed(sup);
      assert.equal(sup.affectedRows, 1);
      // An admin of another organisation cannot (RLS: no row).
      assertNoRows(await tryAsUser(db, u.adminB, `UPDATE profiles SET first_name = 'X' WHERE id = $1`, [u.guardA]), 'foreign admin');
    }));
});
