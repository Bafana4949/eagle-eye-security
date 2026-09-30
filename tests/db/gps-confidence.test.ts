/**
 * GPS confidence is decided server-side by the patrol_scans trigger. These tests insert
 * real scans as the guard and read back what the trigger stored, then check the SQL rules
 * agree with the production TypeScript used for the on-device verdict
 * (src/lib/gps/haversine.ts).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createTestDb } from './harness';
import { pointNorthOf, seedTwoTenantFixture, type Fixture } from './fixtures';
import { startShiftAs } from './assertions';
import { calculateDistanceMetersPrecise, classifyGpsConfidence } from '@/lib/gps/haversine';

let db: PGlite;
let fx: Fixture;
let shiftId: string;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
  shiftId = await startShiftAs(db, fx.users.guardA, fx.siteA1);
});
after(async () => {
  await db.close();
});

interface StoredScan {
  gps_confidence: string;
  distance_to_checkpoint_meters: number | null;
  is_valid_proximity: boolean;
}

/** Scan `distance` metres north of cpA1 (radius 50 m) with the given accuracy; returns the stored verdict. */
async function scanAt(
  distance: number | null,
  accuracy: number | null,
  checkpointId: string = fx.checkpoints.cpA1
): Promise<StoredScan> {
  const g = fx.users.guardA;
  const point = distance === null ? null : pointNorthOf(fx.cpLat, fx.cpLng, distance);
  const id = randomUUID();
  await asUser(
    db,
    g,
    `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device,
                               latitude, longitude, accuracy_meters, method, payload_type, gps_error)
     VALUES ($1, $1, $2, $3, $4, now(), $5, $6, $7, 'qr', 'secure_token', $8)`,
    [id, shiftId, checkpointId, g, point?.latitude ?? null, point?.longitude ?? null, accuracy, point ? null : 'permission_denied']
  );
  const r = await asUser<StoredScan>(
    db,
    g,
    `SELECT gps_confidence, distance_to_checkpoint_meters, is_valid_proximity FROM patrol_scans WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

describe('server-computed GPS confidence (radius 50 m)', () => {
  test('5 m away at ±4 m -> verified', async () => {
    const s = await scanAt(5, 4);
    assert.equal(s.gps_confidence, 'verified');
    assert.equal(s.is_valid_proximity, true);
    assert.ok(Math.abs((s.distance_to_checkpoint_meters ?? NaN) - 5) < 0.001);
  });

  test('15 m away at ±100 m -> low_confidence', async () => {
    const s = await scanAt(15, 100);
    assert.equal(s.gps_confidence, 'low_confidence');
    assert.equal(s.is_valid_proximity, false);
  });

  test('40 m away at ±15 m -> likely (inside the radius, accuracy within radius, but d + a > r)', async () => {
    const s = await scanAt(40, 15);
    assert.equal(s.gps_confidence, 'likely');
    assert.equal(s.is_valid_proximity, true);
  });

  test('40 m away at ±5 m -> verified (40 + 5 <= 50)', async () => {
    const s = await scanAt(40, 5);
    assert.equal(s.gps_confidence, 'verified');
  });

  test('200 m away at ±20 m -> outside', async () => {
    const s = await scanAt(200, 20);
    assert.equal(s.gps_confidence, 'outside');
    assert.equal(s.is_valid_proximity, false);
  });

  test('no latitude / longitude -> no_fix', async () => {
    const s = await scanAt(null, null);
    assert.equal(s.gps_confidence, 'no_fix');
    assert.equal(s.distance_to_checkpoint_meters, null);
    assert.equal(s.is_valid_proximity, false);
  });

  test('checkpoint without coordinates -> no_reference', async () => {
    const s = await scanAt(5, 4, fx.checkpoints.cpA1NoCoords);
    assert.equal(s.gps_confidence, 'no_reference');
    assert.equal(s.distance_to_checkpoint_meters, null);
    assert.equal(s.is_valid_proximity, false);
  });

  test('unknown accuracy is never verified -> low_confidence', async () => {
    const s = await scanAt(5, null);
    assert.equal(s.gps_confidence, 'low_confidence');
  });
});

describe('SQL and production TypeScript agree', () => {
  test('classify_gps_confidence matches classifyGpsConfidence() over a grid of inputs', async () => {
    const distances = [0, 5, 15, 30, 40, 45, 49.9, 50, 50.1, 60, 100, 200, 1000];
    const accuracies: Array<number | null> = [null, 0, 4, 5, 10, 15, 20, 49, 50, 51, 100, 500];
    const radii = [10, 50, 75];
    const cases: Array<{ d: number; a: number | null; r: number }> = [];
    for (const d of distances) for (const a of accuracies) for (const r of radii) cases.push({ d, a, r });
    const sql = await asUser<{ c: string }>(
      db,
      fx.users.guardA,
      `SELECT public.classify_gps_confidence(x.d, x.a, x.r) AS c
       FROM jsonb_to_recordset($1::jsonb) AS x(i int, d float8, a float8, r float8)
       ORDER BY x.i`,
      [JSON.stringify(cases.map((c, i) => ({ i, ...c })))]
    );
    assert.equal(sql.rows.length, cases.length);
    cases.forEach((c, i) => {
      const ts = classifyGpsConfidence({ distanceMeters: c.d, accuracyMeters: c.a, radiusMeters: c.r });
      assert.equal(sql.rows[i].c, ts, `d=${c.d} a=${c.a} r=${c.r}: SQL ${sql.rows[i].c} vs TS ${ts}`);
    });
  });

  test('haversine_distance_meters matches calculateDistanceMetersPrecise() (same Earth radius)', async () => {
    const pairs = [
      [-25.68412, 27.81452, -25.68502, 27.81521],
      [-25.68412, 27.81452, -25.68412, 27.81452],
      [-33.9249, 18.4241, -26.2041, 28.0473],
      [0, 0, 0, 1],
      [-25.7, 27.8, -25.7001, 27.8001]
    ];
    for (const [lat1, lon1, lat2, lon2] of pairs) {
      const r = await asUser<{ d: number }>(db, fx.users.guardA, `SELECT public.haversine_distance_meters($1, $2, $3, $4) AS d`, [
        lat1,
        lon1,
        lat2,
        lon2
      ]);
      const ts = calculateDistanceMetersPrecise(lat1, lon1, lat2, lon2);
      assert.ok(Math.abs(r.rows[0].d - ts) < 1e-6, `(${lat1},${lon1})->(${lat2},${lon2}): SQL ${r.rows[0].d} vs TS ${ts}`);
    }
  });
});
