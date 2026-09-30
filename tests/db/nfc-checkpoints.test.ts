/**
 * Checkpoint administration: NFC enrolment (canonical serials, per-org uniqueness,
 * server-side enrolment stamps and audit trail) and QR token strength, checked against the
 * production TypeScript helpers (normalizeNfcSerial, generateCheckpointToken).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertRefused, startShiftAs } from './assertions';
import { normalizeNfcSerial } from '@/lib/nfc/webNfc';
import { generateCheckpointToken } from '@/lib/data/checkpoints';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

/** Admin creates a checkpoint on `siteId` with a production-generated token. */
async function createCheckpointAs(userId: string, siteId: string, nfcUid: string | null = null) {
  const id = randomUUID();
  const outcome = await tryAsUser(
    db,
    userId,
    `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, nfc_uid, permitted_radius_meters)
     VALUES ($1, $2, 'Borehole', $3, $4, 50)`,
    [id, siteId, generateCheckpointToken(), nfcUid]
  );
  return { id, outcome };
}

async function storedCheckpoint(id: string) {
  const r = await asSuperuser<{
    nfc_uid: string | null;
    nfc_enrolled_at: Date | null;
    nfc_enrolled_by: string | null;
    organisation_id: string;
  }>(db, `SELECT nfc_uid, nfc_enrolled_at, nfc_enrolled_by, organisation_id FROM checkpoints WHERE id = $1`, [id]);
  return r.rows[0];
}

describe('NFC enrolment', () => {
  const CANONICAL = '04:a2:3b:1c:5d:80:00';

  test("admin creates a checkpoint and enrols a tag; '04:A2:3B:1C:5D:80:00', '04a23b1c5d8000' and '04-A2-3B-1C-5D-80-00' normalise to one value", async () => {
    const a = fx.users.adminA;
    const { id, outcome } = await createCheckpointAs(a, fx.siteA1);
    assertAllowed(outcome, 'create checkpoint');
    const created = await storedCheckpoint(id);
    assert.equal(created.organisation_id, fx.orgA, 'organisation_id is set from the site');
    assert.equal(created.nfc_uid, null);
    assert.equal(created.nfc_enrolled_at, null);

    const enrol = await tryAsUser(db, a, `UPDATE checkpoints SET nfc_uid = $2 WHERE id = $1`, [id, '04:A2:3B:1C:5D:80:00']);
    assertAllowed(enrol, 'enrol');
    const enrolled = await storedCheckpoint(id);
    assert.equal(enrolled.nfc_uid, CANONICAL);
    assert.equal(enrolled.nfc_enrolled_by, a);
    assert.ok(enrolled.nfc_enrolled_at instanceof Date);

    for (const format of ['04a23b1c5d8000', '04-A2-3B-1C-5D-80-00', ' 04 a2 3b 1c 5d 80 00 ']) {
      assertAllowed(await tryAsUser(db, a, `UPDATE checkpoints SET nfc_uid = $2 WHERE id = $1`, [id, format]), `re-save as ${format}`);
      const again = await storedCheckpoint(id);
      assert.equal(again.nfc_uid, CANONICAL, `${format} stored as ${again.nfc_uid}`);
      assert.equal(
        again.nfc_enrolled_at?.getTime(),
        enrolled.nfc_enrolled_at?.getTime(),
        'same tag in another notation is not a new enrolment'
      );
    }
    await asSuperuser(db, `UPDATE checkpoints SET nfc_uid = NULL WHERE id = $1`, [id]);
  });

  test('duplicate NFC uid in the same organisation is rejected (any notation)', async () => {
    const a = fx.users.adminA;
    const first = await createCheckpointAs(a, fx.siteA1, '04:11:22:33:44:55:66');
    assertAllowed(first.outcome);
    const sameSite = await createCheckpointAs(a, fx.siteA1, '04-11-22-33-44-55-66');
    assertRefused(sameSite.outcome, '23505');
    const otherSite = await createCheckpointAs(a, fx.siteA2, '04112233445566');
    assertRefused(otherSite.outcome, '23505', 'same tag on another site of the same organisation');
  });

  test('the same NFC uid in a different organisation is allowed', async () => {
    const shared = '04:99:88:77:66:55:44';
    const a = await createCheckpointAs(fx.users.adminA, fx.siteA1, shared);
    assertAllowed(a.outcome);
    const b = await createCheckpointAs(fx.users.adminB, fx.siteB1, shared.toUpperCase());
    assertAllowed(b.outcome);
    assert.equal((await storedCheckpoint(b.id)).nfc_uid, shared);
  });

  test('implausible serials are rejected instead of stored (too short, too long, odd length, no hex)', async () => {
    const a = fx.users.adminA;
    for (const bad of ['04:a2:3b', '04a23b1c5d80001122aabb', '04a23b1c5d800', 'not-a-tag', ':::']) {
      const { outcome } = await createCheckpointAs(a, fx.siteA1, bad);
      assertRefused(outcome, '22023', `serial ${JSON.stringify(bad)}`);
    }
    // An empty value means "no tag", never a fabricated one.
    const blank = await createCheckpointAs(a, fx.siteA1, '   ');
    assertAllowed(blank.outcome);
    assert.equal((await storedCheckpoint(blank.id)).nfc_uid, null);
  });

  test('enrolment stamps are set by the server and cannot be forged by the client', async () => {
    const a = fx.users.adminA;
    const { id, outcome } = await createCheckpointAs(a, fx.siteA1);
    assertAllowed(outcome);
    await asUser(
      db,
      a,
      `UPDATE checkpoints SET nfc_enrolled_at = '2001-01-01T00:00:00Z', nfc_enrolled_by = $2, name = 'Renamed' WHERE id = $1`,
      [id, fx.users.guardA]
    );
    const row = await storedCheckpoint(id);
    assert.equal(row.nfc_enrolled_at, null);
    assert.equal(row.nfc_enrolled_by, null);
  });

  test('audit_logs row written on NFC enrolment (old and new serial recorded)', async () => {
    const a = fx.users.adminA;
    const { id, outcome } = await createCheckpointAs(a, fx.siteA1);
    assertAllowed(outcome);
    await asUser(db, a, `UPDATE checkpoints SET nfc_uid = '04AABBCCDDEEFF' WHERE id = $1`, [id]);
    await asUser(db, a, `UPDATE checkpoints SET nfc_uid = NULL WHERE id = $1`, [id]);
    const r = await asUser<{ action: string; actor_id: string; old: string | null; new: string | null }>(
      db,
      a,
      `SELECT action, actor_id, details ->> 'nfc_uid_old' AS old, details ->> 'nfc_uid_new' AS new
       FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action`,
      [id]
    );
    assert.deepEqual(
      r.rows.map((row) => [row.action, row.actor_id, row.old, row.new]),
      [
        ['checkpoint.created', a, null, null],
        ['checkpoint.nfc_enrolled', a, null, '04:aa:bb:cc:dd:ee:ff'],
        ['checkpoint.nfc_removed', a, '04:aa:bb:cc:dd:ee:ff', null]
      ]
    );
  });

  test('an NFC scan is verified against the enrolled serial; an unknown serial is stored unverified', async () => {
    const a = fx.users.adminA;
    const g = fx.users.guardA;
    const { id } = await createCheckpointAs(a, fx.siteA1, '04:de:ad:be:ef:00:01');
    const shiftId = await startShiftAs(db, g, fx.siteA1);
    const scan = async (raw: string) => {
      const scanId = randomUUID();
      await asUser(
        db,
        g,
        `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type, raw_payload)
         VALUES ($1, $1, $2, $3, $4, now(), 'nfc', 'nfc_uid', $5)`,
        [scanId, shiftId, id, g, raw]
      );
      const r = await asSuperuser<{ payload_verified: boolean }>(db, `SELECT payload_verified FROM patrol_scans WHERE id = $1`, [scanId]);
      return r.rows[0].payload_verified;
    };
    assert.equal(await scan('04:DE:AD:BE:EF:00:01'), true);
    assert.equal(await scan('04:de:ad:be:ef:00:02'), false);
  });

  test('SQL normalize_nfc_uid() matches normalizeNfcSerial() from src/lib/nfc/webNfc.ts', async () => {
    const inputs = [
      '04:A2:3B:1C:5D:80:00',
      '04a23b1c5d8000',
      '04-A2-3B-1C-5D-80-00',
      ' 04 a2 3b 1c ',
      '04:a2:3b',
      '04a23b1c5d80001122aa',
      '04a23b1c5d80001122aabb',
      '04a23b1c5d800',
      'not-a-tag',
      '',
      'zz04zz11zz22zz33',
      '0x04a23b1c'
    ];
    const r = await asUser<{ v: string | null }>(
      db,
      fx.users.guardA,
      `SELECT public.normalize_nfc_uid(x.s) AS v FROM unnest($1::text[]) WITH ORDINALITY AS x(s, i) ORDER BY x.i`,
      [inputs]
    );
    inputs.forEach((input, i) => {
      assert.equal(r.rows[i].v, normalizeNfcSerial(input), `input ${JSON.stringify(input)}`);
    });
  });
});

describe('QR checkpoint tokens', () => {
  test('tokens from generateCheckpointToken() are accepted; weak or malformed tokens are rejected', async () => {
    const a = fx.users.adminA;
    const good = await createCheckpointAs(a, fx.siteA1);
    assertAllowed(good.outcome);
    for (const weak of ['EE-CP-A1B2C3D4', 'EE-CP-MAIN-GATE-01', 'ee-cp-0123456789abcdef0123456789abcdef', '0123456789ABCDEF0123456789ABCDEF']) {
      const r = await tryAsUser(
        db,
        a,
        `INSERT INTO checkpoints (site_id, name, qr_code_hash) VALUES ($1, 'Weak', $2)`,
        [fx.siteA1, weak]
      );
      assertRefused(r, '22023', `token ${weak}`);
    }
    assertRefused(
      await tryAsUser(db, a, `UPDATE checkpoints SET qr_code_hash = 'EE-CP-1234' WHERE id = $1`, [good.id]),
      '22023',
      'rotating to a weak token'
    );
    const rotate = await tryAsUser(db, a, `UPDATE checkpoints SET qr_code_hash = $2 WHERE id = $1`, [good.id, generateCheckpointToken()]);
    assertAllowed(rotate, 'rotating to a new strong token');
  });
});
