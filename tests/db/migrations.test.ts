/**
 * Migration hygiene: the shipped SQL applies cleanly on a Supabase-shaped Postgres,
 * the hardening migration is idempotent, anon has no access, and the realtime
 * publication is configured.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  asSuperuser,
  createTestDb,
  listMigrationFiles,
  runSqlFile,
  SEED_FILE,
  tryAsUser
} from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { sha256 } from '@/lib/utils/hash';

const HARDENING = '20261001000000_security_audit_hardening.sql';

function migrationPath(name: string): string {
  const file = listMigrationFiles().find((f) => path.basename(f) === name);
  assert.ok(file, `migration ${name} not found`);
  return file;
}

async function policySnapshot(db: PGlite): Promise<string[]> {
  const r = await asSuperuser<{ p: string }>(
    db,
    `SELECT schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') AS p
     FROM pg_policies
     WHERE schemaname = 'public' OR (schemaname = 'storage' AND tablename = 'objects')
     ORDER BY 1`
  );
  return r.rows.map((row) => row.p);
}

describe('migration files', () => {
  test('every migration has a unique 14-digit version', () => {
    const names = listMigrationFiles().map((f) => path.basename(f));
    const versions = names.map((n) => n.split('_')[0]);
    for (const v of versions) assert.match(v, /^\d{14}$/, `bad version prefix in ${v}`);
    assert.equal(new Set(versions).size, versions.length, `duplicate versions: ${versions.join(', ')}`);
    assert.deepEqual(names, [
      '20260930000000_init_schema.sql',
      '20260930000100_phase2_hardening.sql',
      HARDENING
    ]);
  });

  test('phase 2 no longer tries to ALTER storage.objects (not owned by postgres on hosted Supabase)', () => {
    const sql = readFileSync(migrationPath('20260930000100_phase2_hardening.sql'), 'utf8');
    const executable = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(executable, /ALTER\s+TABLE\s+storage\.objects/i);
  });

  test('hardening migration creates nothing in auth/storage and does not alter storage tables', () => {
    const sql = readFileSync(migrationPath(HARDENING), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|TRIGGER)\s+(auth|storage)\./i);
    assert.doesNotMatch(sql, /ALTER\s+TABLE\s+(auth|storage)\./i);
  });
});

describe('applying migrations', () => {
  let db: PGlite;

  before(async () => {
    db = await createTestDb();
  });
  after(async () => {
    await db.close();
  });

  test('all migrations apply cleanly in version order', async () => {
    const r = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
    );
    assert.equal(r.rows[0].n, 15);
    const fn = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('is_site_member', 'can_manage_site', 'try_uuid')`
    );
    assert.equal(fn.rows[0].n, 3);
  });

  test('hardening migration can be applied a second time without error and without duplicating anything', async () => {
    const before = await policySnapshot(db);
    const pubBefore = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`
    );
    await runSqlFile(db, migrationPath(HARDENING));
    await runSqlFile(db, migrationPath(HARDENING));
    assert.deepEqual(await policySnapshot(db), before);
    const pubAfter = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`
    );
    assert.equal(pubAfter.rows[0].n, pubBefore.rows[0].n);
  });

  test('realtime publication contains shifts, patrol_scans, incidents, panic_alerts, gate_entries', async () => {
    const r = await asSuperuser<{ tablename: string }>(
      db,
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' ORDER BY tablename`
    );
    assert.deepEqual(
      r.rows.map((row) => row.tablename),
      ['gate_entries', 'incidents', 'panic_alerts', 'patrol_scans', 'shifts']
    );
  });

  test('PIN oracle removed: verify_guard_pin() and profiles.pin_hash no longer exist', async () => {
    const fn = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'verify_guard_pin'`);
    assert.equal(fn.rows[0].n, 0);
    const col = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'pin_hash'`
    );
    assert.equal(col.rows[0].n, 0);
  });

  test('every public policy targets authenticated only (no PUBLIC / anon policies)', async () => {
    const r = await asSuperuser<{ p: string }>(
      db,
      `SELECT tablename || ':' || policyname AS p FROM pg_policies
       WHERE schemaname = 'public' AND roles <> ARRAY['authenticated']::name[]`
    );
    assert.deepEqual(r.rows, []);
    const rlsOff = await asSuperuser<{ relname: string }>(
      db,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`
    );
    assert.deepEqual(rlsOff.rows, []);
  });

  test('every SECURITY DEFINER function in public pins its search_path', async () => {
    const r = await asSuperuser<{ proname: string }>(
      db,
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`
    );
    assert.deepEqual(r.rows, []);
  });

  test('signed-in users can call the policy helpers and RPCs, but not trigger or internal evidence functions', async () => {
    const r = await asSuperuser<{ sig: string; authn: boolean }>(
      db,
      `SELECT p.oid::regprocedure::text AS sig, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('get_checkpoint_secrets', 'site_people', 'managed_site_ids', 'is_site_guard',
                           'resolve_shift_schedule', 'site_shift_candidates', 'assert_device_time', 'selfie_in_use',
                           'shifts_before_insert', 'audit_log_change')
       ORDER BY 1`
    );
    const callable = Object.fromEntries(r.rows.map((row) => [row.sig.replace(/\(.*$/, ''), row.authn]));
    assert.deepEqual(callable, {
      assert_device_time: false,
      audit_log_change: false,
      get_checkpoint_secrets: true,
      is_site_guard: true,
      managed_site_ids: true,
      resolve_shift_schedule: false,
      selfie_in_use: false,
      shifts_before_insert: false,
      site_people: true,
      site_shift_candidates: false
    });
  });

  test('the checkpoint secret columns are not selectable by signed-in users; their fingerprints are', async () => {
    const r = await asSuperuser<{ column_name: string; can: boolean }>(
      db,
      `SELECT c.column_name::text AS column_name,
              has_column_privilege('authenticated', 'public.checkpoints', c.column_name, 'SELECT') AS can
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'checkpoints'
       ORDER BY 1`
    );
    const hidden = r.rows.filter((row) => !row.can).map((row) => row.column_name);
    assert.deepEqual(hidden, ['nfc_uid', 'qr_code_hash']);
    for (const column of ['qr_token_sha256', 'nfc_uid_sha256', 'qr_token_strong', 'legacy_code', 'deactivated_at']) {
      assert.ok(r.rows.some((row) => row.column_name === column && row.can), column);
    }
  });

  test('phase 2 refuses to run again after the hardening migration (it would restore permissive policies)', async () => {
    const before = await policySnapshot(db);
    await assert.rejects(runSqlFile(db, migrationPath('20260930000100_phase2_hardening.sql')), /must not run after/);
    assert.deepEqual(await policySnapshot(db), before);
  });
});

describe('objects created after the migrations (later migrations, SQL editor)', () => {
  test('a new function is not executable by anon, and a new table grants no TRUNCATE to authenticated', async () => {
    const db = await createTestDb();
    try {
      await asSuperuser(db, `CREATE FUNCTION public.later_fn() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$`);
      await asSuperuser(db, `CREATE TABLE public.later_tbl (id int)`);
      const r = await asSuperuser<{ anon_exec: boolean; authn_exec: boolean; anon_select: boolean; authn_truncate: boolean }>(
        db,
        `SELECT has_function_privilege('anon', 'public.later_fn()', 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', 'public.later_fn()', 'EXECUTE') AS authn_exec,
                has_table_privilege('anon', 'public.later_tbl', 'SELECT') AS anon_select,
                has_table_privilege('authenticated', 'public.later_tbl', 'TRUNCATE') AS authn_truncate`
      );
      assert.deepEqual(r.rows[0], { anon_exec: false, authn_exec: true, anon_select: false, authn_truncate: false });
      const call = await tryAsUser(db, null, `SELECT public.later_fn()`);
      assert.equal(call.ok, false);
      if (!call.ok) assert.equal(call.code, '42501');
    } finally {
      await db.close();
    }
  });
});

describe('anon (not signed in) has no access', () => {
  let db: PGlite;
  let fx: Fixture;

  before(async () => {
    db = await createTestDb();
    fx = await seedTwoTenantFixture(db);
  });
  after(async () => {
    await db.close();
  });

  test('anon has no privilege on any public table and every read is refused', async () => {
    const tables = await asSuperuser<{ tablename: string }>(
      db,
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
    );
    assert.equal(tables.rows.length, 15);
    for (const { tablename } of tables.rows) {
      const priv = await asSuperuser<{ any: boolean }>(
        db,
        `SELECT has_table_privilege('anon', format('public.%I', $1::text), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS any`,
        [tablename]
      );
      assert.equal(priv.rows[0].any, false, `anon has a privilege on ${tablename}`);
      const read = await tryAsUser(db, null, `SELECT * FROM public.${tablename} LIMIT 1`);
      assert.equal(read.ok, false, `anon could read ${tablename}`);
      if (!read.ok) assert.equal(read.code, '42501');
    }
  });

  test('anon cannot execute any application function in public (helpers included)', async () => {
    const fns = await asSuperuser<{ sig: string }>(
      db,
      `SELECT p.oid::regprocedure::text AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1`
    );
    assert.ok(fns.rows.length >= 20, 'expected the helper functions to exist');
    for (const { sig } of fns.rows) {
      const priv = await asSuperuser<{ ok: boolean }>(db, `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok`, [sig]);
      assert.equal(priv.rows[0].ok, false, `anon can execute ${sig}`);
    }
    for (const call of [
      `SELECT public.get_auth_org_id()`,
      `SELECT public.has_role('admin')`,
      `SELECT public.is_org_admin()`,
      `SELECT public.is_site_member('${fx.siteA1}')`,
      `SELECT public.can_manage_site('${fx.siteA1}')`,
      `SELECT public.try_uuid('x')`,
      `SELECT public.normalize_nfc_uid('04a23b1c5d8000')`
    ]) {
      const r = await tryAsUser(db, null, call);
      assert.equal(r.ok, false, `anon could run: ${call}`);
      if (!r.ok) assert.equal(r.code, '42501');
    }
  });

  test('anon sees no evidence objects in storage', async () => {
    await asSuperuser(
      db,
      `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('evidence-media', $1, $2)`,
      [`${fx.orgA}/${fx.siteA1}/selfie/${fx.users.guardA}/${randomUUID()}-start.jpg`, fx.users.guardA]
    );
    const r = await tryAsUser<{ n: number }>(db, null, `SELECT count(*)::int AS n FROM storage.objects`);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.rows[0].n, 0);
  });
});

describe('seed.sql (local / staging only)', () => {
  let db: PGlite;

  before(async () => {
    db = await createTestDb({ seed: true });
  });
  after(async () => {
    await db.close();
  });

  test('applies on top of the migrations and can be re-run', async () => {
    await runSqlFile(db, SEED_FILE);
    const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM checkpoints`);
    assert.equal(r.rows[0].n, 6);
  });

  test('creates no fabricated NFC serials, strong random QR tokens and Dawie legacy codes CP1..CP6', async () => {
    const r = await asSuperuser<{ nfc_uid: string | null; qr_code_hash: string; legacy_code: string }>(
      db,
      `SELECT nfc_uid, qr_code_hash, legacy_code FROM checkpoints ORDER BY order_index`
    );
    assert.deepEqual(
      r.rows.map((row) => row.legacy_code),
      ['CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6']
    );
    for (const row of r.rows) {
      assert.equal(row.nfc_uid, null);
      assert.match(row.qr_code_hash, /^EE-CP-[0-9A-F]{32}$/);
    }
    assert.equal(new Set(r.rows.map((row) => row.qr_code_hash)).size, 6);
  });

  test('creates no auth users, profiles or role grants', async () => {
    const r = await asSuperuser<{ users: number; profiles: number; roles: number }>(
      db,
      `SELECT (SELECT count(*)::int FROM auth.users) AS users,
              (SELECT count(*)::int FROM profiles) AS profiles,
              (SELECT count(*)::int FROM user_roles) AS roles`
    );
    assert.deepEqual(r.rows[0], { users: 0, profiles: 0, roles: 0 });
  });
});

describe('legacy demo data is repaired by the hardening migration', () => {
  let db: PGlite;

  before(async () => {
    db = await createTestDb({ upTo: '20260930000100_phase2_hardening.sql' });
  });
  after(async () => {
    await db.close();
  });

  test('fabricated demo NFC serials are cleared and public demo QR tokens rotated', async () => {
    const org = randomUUID();
    const site = randomUUID();
    await asSuperuser(db, `INSERT INTO organisations (id, name) VALUES ($1, 'Legacy')`, [org]);
    await asSuperuser(db, `INSERT INTO sites (id, organisation_id, name, code) VALUES ($1, $2, 'Legacy', 'L1')`, [site, org]);
    // Exactly what the original seed.sql inserted.
    await asSuperuser(
      db,
      `INSERT INTO checkpoints (site_id, name, qr_code_hash, nfc_uid, order_index)
       VALUES ($1, 'Hoofhek', 'EE-CP-MAIN-GATE-01', '04:7A:B2:C1', 1),
              ($1, 'Skaapkraal', 'EE-CP-SHEEP-KRAAL-02', '04:7A:B2:C2', 2)`,
      [site]
    );
    await runSqlFile(db, migrationPath(HARDENING));
    const r = await asSuperuser<{ nfc_uid: string | null; qr_code_hash: string; legacy_code: string; organisation_id: string }>(
      db,
      `SELECT nfc_uid, qr_code_hash, legacy_code, organisation_id FROM checkpoints ORDER BY order_index`
    );
    assert.deepEqual(
      r.rows.map((row) => [row.nfc_uid, row.legacy_code, row.organisation_id]),
      [
        [null, 'CP1', org],
        [null, 'CP2', org]
      ]
    );
    for (const row of r.rows) assert.match(row.qr_code_hash, /^EE-CP-[0-9A-F]{32}$/);
  });

  test("the old seed's invented coordinates and phone numbers are cleared, raw tokens leave the scan log, real values stay", async () => {
    const fresh = await createTestDb({ upTo: '20260930000100_phase2_hardening.sql' });
    try {
      const org = '11111111-1111-1111-1111-111111111111';
      const site = '22222222-2222-2222-2222-222222222222';
      const guard = randomUUID();
      const shift = randomUUID();
      // The original seed.sql's organisation, site and checkpoints, value for value.
      await asSuperuser(
        fresh,
        `INSERT INTO organisations (id, name, registration_number, contact_phone, contact_email)
         VALUES ($1, 'Aiguille Security & Farm Operations', '2026/089412/07', '+27 82 000 1234', 'ops@aiguillesecurity.co.za')`,
        [org]
      );
      await asSuperuser(
        fresh,
        `INSERT INTO sites (id, organisation_id, name, code, address, latitude, longitude, default_radius_meters,
                            emergency_phone, police_phone, whatsapp_dispatch_number)
         VALUES ($1, $2, 'Dawie Boerdery - Main Site', 'DW-01', 'R512 Farm Road, Brits / Hartbeespoort, North West',
                 -25.684120, 27.814520, 60, '+27 82 999 4321', '10111', '+27829994321')`,
        [site, org]
      );
      await asSuperuser(
        fresh,
        `INSERT INTO checkpoints (site_id, name, qr_code_hash, nfc_uid, latitude, longitude, permitted_radius_meters, order_index)
         VALUES ($1, 'Hoofhek', 'EE-CP-MAIN-GATE-01', '04:7A:B2:C1', -25.684120, 27.814520, 50, 1),
                ($1, 'Skaapkraal', 'EE-CP-SHEEP-KRAAL-02', '04:7A:B2:C2', -25.684890, 27.815210, 60, 2),
                ($1, 'Hoenderhok', 'EE-CP-POULTRY-SHED-03', '04:7A:B2:C3', -25.683500, 27.814010, 50, 3),
                ($1, 'Werkswinkel', 'EE-CP-WORKSHOP-04', '04:7A:B2:C4', -25.684300, 27.813800, 50, 4),
                ($1, 'Skadunet', 'EE-CP-SHADE-GARDEN-05', '04:7A:B2:C5', -25.685100, 27.814900, 50, 5),
                ($1, 'Grensdraad', 'EE-CP-NORTH-FENCE-06', '04:7A:B2:C6', -25.682900, 27.814300, 75, 6),
                ($1, 'Surveyed borehole', 'EE-CP-0123456789ABCDEF0123456789ABCDEF', NULL, -25.690001, 27.820002, 30, 7)`,
        [site]
      );
      // Scans stored by the old app kept the raw token / serial.
      await asSuperuser(fresh, `INSERT INTO auth.users (id) VALUES ($1)`, [guard]);
      await asSuperuser(fresh, `INSERT INTO profiles (id, organisation_id, first_name, last_name) VALUES ($1, $2, 'G', 'One')`, [guard, org]);
      await asSuperuser(
        fresh,
        `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start)
         VALUES ($1, $2, $3, 'night', now() - interval '2 hours', now() + interval '10 hours', now() - interval '2 hours')`,
        [shift, site, guard]
      );
      await asSuperuser(
        fresh,
        `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, raw_payload)
         SELECT gen_random_uuid(), $1, c.id, $2, now(), m.method::scan_method_enum, m.raw
         FROM checkpoints c,
              (VALUES ('qr', 'EE-CP-MAIN-GATE-01'), ('nfc', '04:7A:B2:C1'), ('qr', 'PLAAS-CP:CP1')) AS m(method, raw)
         WHERE c.order_index = 1`,
        [shift, guard]
      );

      await runSqlFile(fresh, migrationPath(HARDENING));

      const cps = await asSuperuser<{ order_index: number; latitude: number | null; longitude: number | null; radius: number; legacy_code: string | null }>(
        fresh,
        `SELECT order_index, latitude, longitude, permitted_radius_meters AS radius, legacy_code FROM checkpoints ORDER BY order_index`
      );
      assert.deepEqual(
        cps.rows.map((row) => [row.order_index, row.latitude, row.longitude, row.radius, row.legacy_code]),
        [
          [1, null, null, 50, 'CP1'],
          [2, null, null, 50, 'CP2'],
          [3, null, null, 50, 'CP3'],
          [4, null, null, 50, 'CP4'],
          [5, null, null, 50, 'CP5'],
          [6, null, null, 50, 'CP6'],
          [7, -25.690001, 27.820002, 30, null]
        ]
      );
      const s = await asSuperuser(
        fresh,
        `SELECT latitude, longitude, address, emergency_phone, whatsapp_dispatch_number, police_phone, allow_legacy_qr FROM sites WHERE id = $1`,
        [site]
      );
      assert.deepEqual(s.rows[0], {
        latitude: null,
        longitude: null,
        address: null,
        emergency_phone: null,
        whatsapp_dispatch_number: null,
        police_phone: '10111',
        allow_legacy_qr: true
      });
      const o = await asSuperuser(fresh, `SELECT name, registration_number, contact_phone, contact_email FROM organisations WHERE id = $1`, [org]);
      assert.deepEqual(o.rows[0], {
        name: 'Aiguille Security & Farm Operations',
        registration_number: null,
        contact_phone: null,
        contact_email: null
      });
      const scans = await asSuperuser<{ raw_payload: string }>(fresh, `SELECT raw_payload FROM patrol_scans ORDER BY raw_payload`);
      assert.deepEqual(
        scans.rows.map((row) => row.raw_payload).sort(),
        ['PLAAS-CP:CP1', `sha256:${await sha256('04:7a:b2:c1')}`, `sha256:${await sha256('EE-CP-MAIN-GATE-01')}`].sort()
      );

      // Values an operator entered later are never touched, and a re-run changes nothing.
      await asSuperuser(fresh, `UPDATE sites SET emergency_phone = '+27 11 555 0100' WHERE id = $1`, [site]);
      await runSqlFile(fresh, migrationPath(HARDENING));
      const kept = await asSuperuser<{ emergency_phone: string }>(fresh, `SELECT emergency_phone FROM sites WHERE id = $1`, [site]);
      assert.equal(kept.rows[0].emergency_phone, '+27 11 555 0100');
    } finally {
      await fresh.close();
    }
  });

  test('existing NFC serials are stored canonically and a tag linked twice keeps only its oldest link', async () => {
    const org = randomUUID();
    const site = randomUUID();
    const older = randomUUID();
    const newer = randomUUID();
    const fresh = await createTestDb({ upTo: '20260930000100_phase2_hardening.sql' });
    try {
      await asSuperuser(fresh, `INSERT INTO organisations (id, name) VALUES ($1, 'Legacy')`, [org]);
      await asSuperuser(fresh, `INSERT INTO sites (id, organisation_id, name, code) VALUES ($1, $2, 'Legacy', 'L1')`, [site, org]);
      await asSuperuser(
        fresh,
        `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, nfc_uid, created_at)
         VALUES ($1, $3, 'Pump', 'EE-CP-0123456789ABCDEF0123456789ABCDEF', '04A23B1C5D8000', now() - interval '2 days'),
                ($2, $3, 'Pump again', 'EE-CP-FEDCBA9876543210FEDCBA9876543210', '04:a2:3b:1c:5d:80:00', now() - interval '1 day')`,
        [older, newer, site]
      );
      await runSqlFile(fresh, migrationPath(HARDENING));
      const r = await asSuperuser<{ id: string; nfc_uid: string | null }>(fresh, `SELECT id, nfc_uid FROM checkpoints ORDER BY created_at`);
      assert.deepEqual(r.rows, [
        { id: older, nfc_uid: '04:a2:3b:1c:5d:80:00' },
        { id: newer, nfc_uid: null }
      ]);
    } finally {
      await fresh.close();
    }
  });
});

describe('hardening migration is self-contained', () => {
  test('applies on a database where phase 2 was never applied (rolled back by its old storage ALTER)', async () => {
    const db = await createTestDb({ upTo: '20260930000000_init_schema.sql' });
    try {
      await runSqlFile(db, migrationPath(HARDENING));
      const bucket = await asSuperuser<{ public: boolean }>(db, `SELECT public FROM storage.buckets WHERE id = 'evidence-media'`);
      assert.deepEqual(bucket.rows, [{ public: false }]);
      const policies = await asSuperuser<{ policyname: string }>(
        db,
        `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY 1`
      );
      assert.deepEqual(
        policies.rows.map((p) => p.policyname),
        ['ee_evidence_insert', 'ee_evidence_select']
      );
      const triggers = await asSuperuser<{ tgname: string }>(
        db,
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal ORDER BY 1`
      );
      assert.deepEqual(
        triggers.rows.map((t) => t.tgname),
        ['trg_audit_logs_immutable', 'trg_audit_logs_no_truncate']
      );
    } finally {
      await db.close();
    }
  });
});

describe('re-applying the hardening migration on a populated database', () => {
  test('changes no data and writes no audit rows', async () => {
    const db = await createTestDb();
    try {
      const fx = await seedTwoTenantFixture(db);
      await asSuperuser(db, `UPDATE checkpoints SET nfc_uid = '04:01:02:03:04:05:06' WHERE id = $1`, [fx.checkpoints.cpA1]);
      const snapshot = async () =>
        asSuperuser<{ t: string; rows: unknown }>(
          db,
          `SELECT 'checkpoints' AS t, jsonb_agg(to_jsonb(c) ORDER BY c.id) AS rows FROM checkpoints c
           UNION ALL SELECT 'patrol_scans', jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM patrol_scans s
           UNION ALL SELECT 'audit_logs', to_jsonb(count(*)) FROM audit_logs
           UNION ALL SELECT 'profiles', jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM profiles p`
        );
      const before = await snapshot();
      await runSqlFile(db, migrationPath(HARDENING));
      const after = await snapshot();
      assert.deepEqual(after.rows, before.rows);
    } finally {
      await db.close();
    }
  });
});
