/**
 * Checkpoint secrets. The printed QR token (checkpoints.qr_code_hash) and the enrolled NFC
 * serial (checkpoints.nfc_uid) are bearer secrets: whoever can read them can submit a
 * "verified" scan without standing at the checkpoint. No signed-in role can SELECT them;
 * guards match scans against SHA-256 fingerprints computed exactly like the production
 * helpers (sha256() of the token / of normalizeNfcSerial(serial)); org admins read the raw
 * values through the audited get_checkpoint_secrets() RPC (printing cards, enrolment).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, cloneTestDb, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertRefused, startShiftAs } from './assertions';
import { sha256 } from '@/lib/utils/hash';
import { normalizeNfcSerial } from '@/lib/nfc/webNfc';
import { generateCheckpointToken } from '@/lib/data/checkpoints';

let base: PGlite;
let fx: Fixture;
const SERIAL = '04:A2:3B:1C:5D:80:00';

before(async () => {
  base = await createTestDb();
  fx = await seedTwoTenantFixture(base);
  await asSuperuser(base, `UPDATE checkpoints SET nfc_uid = $2 WHERE id = $1`, [fx.checkpoints.cpA1, SERIAL]);
});
after(async () => {
  await base.close();
});

async function withCopy(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await cloneTestDb(base);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

async function rawSecrets(db: PGlite, checkpointId: string) {
  const r = await asSuperuser<{ qr_code_hash: string; nfc_uid: string | null }>(
    db,
    `SELECT qr_code_hash, nfc_uid FROM checkpoints WHERE id = $1`,
    [checkpointId]
  );
  return r.rows[0];
}

describe('nobody signed in can read the raw secrets', () => {
  test('guard, supervisor, client viewer and admin: SELECT of qr_code_hash / nfc_uid (or *) is refused', () =>
    withCopy(async (db) => {
      const u = fx.users;
      for (const who of [u.guardA, u.supA, u.viewerA, u.adminA, u.superA]) {
        for (const sql of [
          `SELECT qr_code_hash FROM checkpoints`,
          `SELECT nfc_uid FROM checkpoints`,
          `SELECT * FROM checkpoints`,
          `SELECT c.name FROM checkpoints c WHERE c.qr_code_hash LIKE 'EE-CP-%'`
        ]) {
          assertRefused(await tryAsUser(db, who, sql), '42501', `${who}: ${sql}`);
        }
      }
    }));

  test("the reviewer's remote forgery no longer works: a guard only has the fingerprint, and submitting it is not a verified scan", () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const cp = await asUser<{ qr_token_sha256: string; latitude: number; longitude: number }>(
        db,
        g,
        `SELECT qr_token_sha256, latitude, longitude FROM checkpoints WHERE id = $1`,
        [fx.checkpoints.cpA1]
      );
      const shift = await startShiftAs(db, g, fx.siteA1);
      const id = randomUUID();
      await asUser(
        db,
        g,
        `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, latitude, longitude,
                                   accuracy_meters, method, payload_type, raw_payload)
         VALUES ($1, $1, $2, $3, $4, now(), $5, $6, 1, 'qr', 'secure_token', $7)`,
        [id, shift, fx.checkpoints.cpA1, g, cp.rows[0].latitude, cp.rows[0].longitude, cp.rows[0].qr_token_sha256]
      );
      const r = await asSuperuser<{ payload_verified: boolean; gps_confidence: string }>(
        db,
        `SELECT payload_verified, gps_confidence FROM patrol_scans WHERE id = $1`,
        [id]
      );
      // GPS is what the phone reported (documented as device-attested); the payload is not proof.
      assert.deepEqual(r.rows[0], { payload_verified: false, gps_confidence: 'verified' });
    }));
});

describe('fingerprints for offline matching', () => {
  test('qr_token_sha256 / nfc_uid_sha256 equal the production sha256() of the token and of normalizeNfcSerial(serial)', () =>
    withCopy(async (db) => {
      const raw = await rawSecrets(db, fx.checkpoints.cpA1);
      const r = await asUser<{ qr_token_sha256: string; nfc_uid_sha256: string; qr_token_strong: boolean }>(
        db,
        fx.users.guardA,
        `SELECT qr_token_sha256, nfc_uid_sha256, qr_token_strong FROM checkpoints WHERE id = $1`,
        [fx.checkpoints.cpA1]
      );
      const normalised = normalizeNfcSerial(SERIAL);
      assert.ok(normalised);
      assert.deepEqual(r.rows[0], {
        qr_token_sha256: await sha256(raw.qr_code_hash),
        nfc_uid_sha256: await sha256(normalised),
        qr_token_strong: true
      });
      const noTag = await asUser<{ nfc_uid_sha256: string | null }>(db, fx.users.guardA, `SELECT nfc_uid_sha256 FROM checkpoints WHERE id = $1`, [
        fx.checkpoints.cpA1NoCoords
      ]);
      assert.equal(noTag.rows[0].nfc_uid_sha256, null);
    }));

  test('fingerprints follow rotation / enrolment and cannot be written by the client', () =>
    withCopy(async (db) => {
      const a = fx.users.adminA;
      const token = generateCheckpointToken();
      await asUser(db, a, `UPDATE checkpoints SET qr_code_hash = $2, nfc_uid = '04112233445566' WHERE id = $1`, [fx.checkpoints.cpA1, token]);
      await asUser(db, a, `UPDATE checkpoints SET qr_token_sha256 = 'forged', nfc_uid_sha256 = 'forged' WHERE id = $1`, [
        fx.checkpoints.cpA1
      ]);
      const r = await asUser<{ qr_token_sha256: string; nfc_uid_sha256: string }>(
        db,
        a,
        `SELECT qr_token_sha256, nfc_uid_sha256 FROM checkpoints WHERE id = $1`,
        [fx.checkpoints.cpA1]
      );
      assert.deepEqual(r.rows[0], {
        qr_token_sha256: await sha256(token),
        nfc_uid_sha256: await sha256('04:11:22:33:44:55:66')
      });
    }));
});

describe('get_checkpoint_secrets() (org admins only, audited)', () => {
  test('an org admin reads the raw token and serial of their sites; the read is audited', () =>
    withCopy(async (db) => {
      const a = fx.users.adminA;
      const raw = await rawSecrets(db, fx.checkpoints.cpA1);
      const r = await asUser<{ checkpoint_id: string; site_id: string; qr_token: string; nfc_uid: string | null }>(
        db,
        a,
        `SELECT * FROM public.get_checkpoint_secrets($1)`,
        [fx.siteA1]
      );
      const cpA1 = r.rows.find((row) => row.checkpoint_id === fx.checkpoints.cpA1);
      assert.deepEqual(cpA1, { checkpoint_id: fx.checkpoints.cpA1, site_id: fx.siteA1, qr_token: raw.qr_code_hash, nfc_uid: '04:a2:3b:1c:5d:80:00' });
      assert.ok(r.rows.every((row) => row.site_id === fx.siteA1));

      const all = await asUser<{ site_id: string }>(db, a, `SELECT site_id FROM public.get_checkpoint_secrets()`);
      assert.deepEqual([...new Set(all.rows.map((row) => row.site_id))].sort(), [fx.siteA1, fx.siteA2].sort(), 'whole organisation, no org B');

      const audit = await asUser<{ action: string; actor_id: string }>(
        db,
        a,
        `SELECT action, actor_id FROM audit_logs WHERE action = 'checkpoint.secrets_viewed' ORDER BY created_at`
      );
      assert.deepEqual(audit.rows, [
        { action: 'checkpoint.secrets_viewed', actor_id: a },
        { action: 'checkpoint.secrets_viewed', actor_id: a }
      ]);
    }));

  test('guards, supervisors, client viewers, disabled users, anon and other organisations are refused', () =>
    withCopy(async (db) => {
      const u = fx.users;
      for (const who of [u.guardA, u.supA, u.viewerA, u.disabledGuardA]) {
        assertRefused(await tryAsUser(db, who, `SELECT * FROM public.get_checkpoint_secrets($1)`, [fx.siteA1]), '42501', who);
      }
      assertRefused(await tryAsUser(db, null, `SELECT * FROM public.get_checkpoint_secrets($1)`, [fx.siteA1]), '42501', 'anon');
      assertRefused(await tryAsUser(db, u.adminB, `SELECT * FROM public.get_checkpoint_secrets($1)`, [fx.siteA1]), '42501', 'org B admin');
      assertRefused(await tryAsUser(db, u.adminA, `SELECT * FROM public.get_checkpoint_secrets($1)`, [randomUUID()]), '42501', 'unknown site');
    }));
});

describe('scan rows never carry a secret', () => {
  test('QR and NFC payloads are verified against the secret, then stored only as their SHA-256', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1);
      const raw = await rawSecrets(db, fx.checkpoints.cpA1);
      const scan = async (method: string, payloadType: string, payload: string) => {
        const id = randomUUID();
        await asUser(
          db,
          g,
          `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type, raw_payload)
           VALUES ($1, $1, $2, $3, $4, now(), $5::scan_method_enum, $6, $7)`,
          [id, shift, fx.checkpoints.cpA1, g, method, payloadType, payload]
        );
        const r = await asUser<{ payload_verified: boolean; raw_payload: string }>(
          db,
          fx.users.viewerA,
          `SELECT payload_verified, raw_payload FROM patrol_scans WHERE id = $1`,
          [id]
        );
        return r.rows[0];
      };
      assert.deepEqual(await scan('qr', 'secure_token', ` ${raw.qr_code_hash} `), {
        payload_verified: true,
        raw_payload: `sha256:${await sha256(raw.qr_code_hash)}`
      });
      assert.deepEqual(await scan('nfc', 'nfc_uid', '04a23b1c5d8000'), {
        payload_verified: true,
        raw_payload: `sha256:${await sha256('04:a2:3b:1c:5d:80:00')}`
      });
      const wrongTag = await scan('nfc', 'nfc_uid', '04:de:ad:be:ef:00:01');
      assert.equal(wrongTag.payload_verified, false);
      assert.equal(wrongTag.raw_payload, `sha256:${await sha256('04:de:ad:be:ef:00:01')}`);
    }));

  test('a checkpoint still carrying a weak / demo-format token is flagged and never verifies', () =>
    withCopy(async (db) => {
      // A card printed by the old admin page ('EE-CP-' + 8 hex) that survived the migration:
      // new weak tokens are refused by the trigger, so write it with triggers off.
      const weakId = randomUUID();
      await asSuperuser(db, `INSERT INTO checkpoints (id, site_id, name, qr_code_hash) VALUES ($1, $2, 'Old card', $3)`, [
        weakId,
        fx.siteA1,
        generateCheckpointToken()
      ]);
      await db.exec(
        `BEGIN; SET LOCAL session_replication_role = replica;
         UPDATE checkpoints SET qr_code_hash = 'EE-CP-A1B2C3D4' WHERE id = '${weakId}'; COMMIT;`
      );
      const g = fx.users.guardA;
      const flag = await asUser<{ qr_token_strong: boolean }>(db, fx.users.adminA, `SELECT qr_token_strong FROM checkpoints WHERE id = $1`, [weakId]);
      assert.equal(flag.rows[0].qr_token_strong, false);
      const shift = await startShiftAs(db, g, fx.siteA1);
      const id = randomUUID();
      await asUser(
        db,
        g,
        `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type, raw_payload)
         VALUES ($1, $1, $2, $3, $4, now(), 'qr', 'secure_token', 'EE-CP-A1B2C3D4')`,
        [id, shift, weakId, g]
      );
      const r = await asSuperuser<{ payload_verified: boolean }>(db, `SELECT payload_verified FROM patrol_scans WHERE id = $1`, [id]);
      assert.equal(r.rows[0].payload_verified, false);
    }));
});
