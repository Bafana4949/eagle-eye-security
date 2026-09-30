/**
 * The production project was built by pasting SQL into the Supabase SQL Editor: it has no
 * supabase_migrations history, no storage policies and nothing in the supabase_realtime
 * publication (checked on the live project on 2026-09-30), i.e. only the initial schema ran.
 * The hardening migration must therefore apply directly on top of 20260930000000_init_schema.sql
 * (skipping phase 2), with the live demo data present, and be safe to paste twice.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, createTestDb, listMigrationFiles, runSqlFile, tryAsUser } from './harness';

const HARDENING = listMigrationFiles().find((f) => path.basename(f) === '20261001000000_security_audit_hardening.sql');

const ORG = '11111111-1111-1111-1111-111111111111';
const SITE = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const GUARD = '55555555-5555-5555-5555-555555555555';

let db: PGlite;

before(async () => {
  assert.ok(HARDENING, 'hardening migration file not found');
  db = await createTestDb({ upTo: '20260930000000_init_schema.sql' });
  // Live-like data: the old seed (predictable QR tokens, fake NFC UIDs) plus test accounts.
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${ADMIN}', 'admin@aiguillesecurity.co.za'), ('${GUARD}', 'guard@aiguillesecurity.co.za');
    INSERT INTO organisations (id, name) VALUES ('${ORG}', 'Aiguille Security & Farm Operations');
    INSERT INTO sites (id, organisation_id, name, code, latitude, longitude) VALUES ('${SITE}', '${ORG}', 'Dawie Boerdery - Main Site', 'DW-01', -25.68412, 27.81452);
    INSERT INTO profiles (id, organisation_id, first_name, last_name, pin_hash) VALUES
      ('${ADMIN}', '${ORG}', 'Admin', 'Test', NULL),
      ('${GUARD}', '${ORG}', 'Guard', 'Test', crypt('1234', gen_salt('bf')));
    INSERT INTO user_roles (user_id, role) VALUES ('${ADMIN}', 'admin'), ('${GUARD}', 'guard');
    INSERT INTO site_assignments (site_id, user_id) VALUES ('${SITE}', '${GUARD}');
    INSERT INTO checkpoints (site_id, name, qr_code_hash, nfc_uid, latitude, longitude, order_index) VALUES
      ('${SITE}', 'Hoofhek / Main Gate', 'EE-CP-MAIN-GATE-01', '04:7A:B2:C1', -25.68412, 27.81452, 1),
      ('${SITE}', 'Skaapkraal / Sheep Kraal', 'EE-CP-SHEEP-KRAAL-02', '04:7A:B2:C2', -25.68489, 27.81521, 2);
  `);
  await runSqlFile(db, HARDENING!);
});

after(async () => {
  await db?.close();
});

describe('live upgrade: initial schema -> hardening (phase 2 never ran)', () => {
  test('the hardening migration can be pasted a second time without error', async () => {
    await runSqlFile(db, HARDENING!);
  });

  test('evidence bucket exists and is private', async () => {
    const r = await asSuperuser<{ public: boolean }>(db, `SELECT public FROM storage.buckets WHERE id = 'evidence-media'`);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].public, false);
  });

  test('storage policies for the evidence bucket are exactly the org/site/user-scoped pair', async () => {
    const r = await asSuperuser<{ policyname: string }>(
      db,
      `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`
    );
    assert.deepEqual(
      r.rows.map((x) => x.policyname),
      ['ee_evidence_insert', 'ee_evidence_select']
    );
  });

  test('realtime publication carries the five operational tables', async () => {
    const r = await asSuperuser<{ tablename: string }>(
      db,
      `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY tablename`
    );
    assert.deepEqual(
      r.rows.map((x) => x.tablename),
      ['gate_entries', 'incidents', 'panic_alerts', 'patrol_scans', 'shifts']
    );
  });

  test('PIN oracle and PIN hashes are gone', async () => {
    const f = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'verify_guard_pin'`);
    assert.equal(f.rows[0].n, 0);
    const c = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'pin_hash'`
    );
    assert.equal(c.rows[0].n, 0);
  });

  test('audit log is immutable', async () => {
    const r = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal`
    );
    assert.ok(r.rows[0].n >= 1);
  });

  test('old demo data is neutralised: predictable QR tokens rotated, fake NFC UIDs cleared', async () => {
    const r = await asSuperuser<{ qr_code_hash: string; nfc_uid: string | null }>(
      db,
      `SELECT qr_code_hash, nfc_uid FROM checkpoints ORDER BY order_index`
    );
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) {
      assert.match(row.qr_code_hash, /^EE-CP-[0-9A-F]{32}$/);
      assert.equal(row.nfc_uid, null);
    }
  });

  test('existing users keep working under the new policies (guard sees own site, not admin data)', async () => {
    const sites = await tryAsUser<{ id: string }>(db, GUARD, `SELECT id FROM sites`);
    assert.ok(sites.ok);
    assert.deepEqual(sites.ok ? sites.rows.map((s) => s.id) : [], [SITE]);
    const audit = await tryAsUser<{ id: string }>(db, GUARD, `SELECT id FROM audit_logs`);
    assert.ok(audit.ok && audit.rows.length === 0);
    const roles = await tryAsUser(db, GUARD, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [GUARD]);
    assert.equal(roles.ok, false);
  });

  test('anon can read nothing', async () => {
    const r = await tryAsUser(db, null, `SELECT id FROM sites`);
    assert.equal(r.ok, false);
  });
});
