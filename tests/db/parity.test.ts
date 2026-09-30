/**
 * The same rules exist twice: in SQL (the authority, run by triggers and storage policies)
 * and in the production TypeScript the phone uses for its immediate verdicts. This file runs
 * both over the same inputs and requires identical answers:
 *
 *   normalize_nfc_uid()          <-> normalizeNfcSerial()          src/lib/nfc/webNfc.ts
 *   classify_gps_confidence()    <-> classifyGpsConfidence()       src/lib/gps/haversine.ts
 *   haversine_distance_meters()  <-> calculateDistanceMetersPrecise()
 *   patrol_scans trigger verdict <-> assessCheckpointProximity()
 *   sha256_hex() / checkpoint fingerprints <-> sha256(), qrTokenFingerprint(), nfcSerialFingerprint()
 *   checkpoint token rule        <-> generateCheckpointToken() / parseCheckpointPayload()
 *   is_evidence_object_name()    <-> buildEvidencePath() / parseEvidencePath()  src/lib/storage/evidence.ts
 *
 * Inputs are deterministic (seeded PRNG) so a failure is reproducible.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, createTestDb } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { startShiftAs } from './assertions';
import { normalizeNfcSerial } from '@/lib/nfc/webNfc';
import {
  assessCheckpointProximity,
  calculateDistanceMetersPrecise,
  classifyGpsConfidence,
  isValidProximityConfidence
} from '@/lib/gps/haversine';
import { sha256 } from '@/lib/utils/hash';
import {
  generateCheckpointToken,
  nfcSerialFingerprint,
  parseCheckpointPayload,
  qrTokenFingerprint
} from '@/lib/data/checkpoints';
import { EVIDENCE_CATEGORIES, buildEvidencePath, parseEvidencePath } from '@/lib/storage/evidence';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

/** mulberry32: small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact text form of a float8 for Postgres (keeps -0, NaN and the infinities). */
function float8Text(value: number | null): string | null {
  if (value === null) return null;
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

describe('NFC serial normalisation: normalize_nfc_uid() == normalizeNfcSerial()', () => {
  function inputs(): Array<string | null> {
    const list: Array<string | null> = [
      null,
      '',
      ' ',
      '04:A2:3B:1C:5D:80:00',
      '04:a2:3b:1c:5d:80:00',
      '04A23B1C5D8000',
      '04-a2-3b-1c-5d-80-00',
      '04 A2 3B 1C 5D 80 00',
      ' 04:a2:3b:1c:5d:80:00\n',
      '0x04a23b1c',
      '04:a2:3b', // 3 bytes: too short
      '04:a2:3b:1c', // 4 bytes (Fudan / MIFARE Classic single-size UID)
      '04:a2:3b:1c:5d:80:00:11:22:33', // 10 bytes (triple size)
      '04:a2:3b:1c:5d:80:00:11:22:33:44', // 11 bytes: too long
      '4:a2:3b:1c', // odd number of hex digits
      'zz:yy:xx:ww',
      'EE-CP-3F2A9C0B7D5E41A8B6C9D0E1F2A3B4C5',
      'PLAAS-CP:CP1',
      '04:é2:3b:1c:5d',
      '０４:ａ２:３ｂ:１ｃ', // full-width characters are not hex digits
      '04​a2​3b​1c',
      '04:a2:3b:1c😀',
      'ＡＢ:cd:ef:01:23'
    ];
    const random = prng(0x5eed1);
    const hex = '0123456789abcdefABCDEF';
    const seps = ['', ':', '-', ' ', '.', ': '];
    for (let bytes = 0; bytes <= 12; bytes += 1) {
      for (const sep of seps) {
        const parts: string[] = [];
        for (let i = 0; i < bytes; i += 1) parts.push(hex[Math.floor(random() * 22)] + hex[Math.floor(random() * 22)]);
        const serial = parts.join(sep);
        list.push(serial, serial.slice(0, -1), serial.toUpperCase());
      }
    }
    const junk = Array.from('0123456789abcdefABCDEF:-_ .\t\ngxyzé😀');
    for (let n = 0; n < 1500; n += 1) {
      const length = Math.floor(random() * 32);
      let text = '';
      for (let i = 0; i < length; i += 1) text += junk[Math.floor(random() * junk.length)];
      list.push(text);
    }
    return list;
  }

  test('identical results over hand-picked and generated serials', async () => {
    const values = inputs();
    const result = await asSuperuser<{ i: number; v: string | null }>(
      db,
      `SELECT t.i::int AS i, public.normalize_nfc_uid(t.raw) AS v
       FROM unnest($1::text[]) WITH ORDINALITY AS t(raw, i) ORDER BY t.i`,
      [values]
    );
    assert.equal(result.rows.length, values.length);
    let valid = 0;
    values.forEach((raw, index) => {
      const ts = normalizeNfcSerial(raw);
      if (ts !== null) valid += 1;
      assert.equal(result.rows[index].v, ts, `input ${JSON.stringify(raw)}: SQL ${result.rows[index].v} vs TS ${ts}`);
    });
    assert.ok(valid > 50, 'the grid contains plenty of valid serials, not only rejects');
  });
});

describe('GPS confidence: classify_gps_confidence() == classifyGpsConfidence()', () => {
  async function compare(cases: Array<{ d: number | null; a: number | null; r: number }>): Promise<void> {
    const result = await asSuperuser<{ i: number; c: string }>(
      db,
      `SELECT t.i::int AS i, public.classify_gps_confidence(t.d::float8, t.a::float8, t.r::float8) AS c
       FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS t(d, a, r, i) ORDER BY t.i`,
      [cases.map((c) => float8Text(c.d)), cases.map((c) => float8Text(c.a)), cases.map((c) => float8Text(c.r))]
    );
    assert.equal(result.rows.length, cases.length);
    cases.forEach((c, index) => {
      const ts = classifyGpsConfidence({ distanceMeters: c.d, accuracyMeters: c.a, radiusMeters: c.r });
      assert.equal(result.rows[index].c, ts, `d=${c.d} a=${c.a} r=${c.r}: SQL ${result.rows[index].c} vs TS ${ts}`);
    });
  }

  test('edge values: boundaries, zero, negative, NaN, infinities, unknown accuracy', async () => {
    const D = [0, -0, 1e-9, 0.5, 5, 15, 39.999999, 40, 45, 49.9, 50, 50.0000001, 60, 99.5, 100, 150, 200, 1000, 20015114, -1, NaN, Infinity, -Infinity, null];
    const A = [null, 0, -0, 0.1, 4, 5, 10, 10.000001, 15, 49, 50, 51, 100, 500, 1e6, Number.MAX_VALUE, -3, NaN, Infinity, -Infinity];
    const R = [0, -5, 1, 10, 50, 75, 100, 2147483647, NaN, Infinity, -Infinity];
    const cases: Array<{ d: number | null; a: number | null; r: number }> = [];
    for (const d of D) for (const a of A) for (const r of R) cases.push({ d, a, r });
    await compare(cases);
  });

  test('exact boundaries (d + a == r, d == r, a == r, d - a == r)', async () => {
    const cases: Array<{ d: number | null; a: number | null; r: number }> = [];
    for (const r of [10, 25, 50, 75, 100]) {
      for (let d = 0; d <= 2 * r; d += 0.5) {
        cases.push({ d, a: r - d, r }, { d, a: r, r }, { d: r, a: d, r }, { d, a: d - r, r }, { d, a: Math.abs(d - r) + 0.25, r });
      }
    }
    await compare(cases);
  });

  test('3 000 random scans in the patrol range', async () => {
    const random = prng(0x6a5);
    const cases: Array<{ d: number | null; a: number | null; r: number }> = [];
    for (let n = 0; n < 3000; n += 1) {
      cases.push({
        d: random() * 300,
        a: random() < 0.1 ? null : random() * 150,
        r: 1 + Math.floor(random() * 150)
      });
    }
    await compare(cases);
  });

  test("the task's examples", () => {
    assert.equal(classifyGpsConfidence({ distanceMeters: 40, accuracyMeters: 5, radiusMeters: 50 }), 'verified', '40 + 5 <= 50');
    assert.equal(classifyGpsConfidence({ distanceMeters: 40, accuracyMeters: 15, radiusMeters: 50 }), 'likely');
    assert.equal(classifyGpsConfidence({ distanceMeters: 15, accuracyMeters: 100, radiusMeters: 50 }), 'low_confidence');
    assert.equal(classifyGpsConfidence({ distanceMeters: 200, accuracyMeters: 20, radiusMeters: 50 }), 'outside');
  });
});

describe('distance: haversine_distance_meters() == calculateDistanceMetersPrecise()', () => {
  test('agree to a micrometre over the patrol range and to 1e-12 relative beyond it', async () => {
    const random = prng(0xd15);
    const pairs: Array<[number, number, number, number]> = [];
    for (let n = 0; n < 600; n += 1) {
      const lat = -35 + random() * 13; // South Africa
      const lng = 16 + random() * 17;
      const spread = n < 500 ? 0.01 : 5; // ~1 km, then ~500 km
      pairs.push([lat, lng, lat + (random() - 0.5) * spread, lng + (random() - 0.5) * spread]);
    }
    pairs.push([fx.cpLat, fx.cpLng, fx.cpLat, fx.cpLng], [0, 0, 0, 1e-9], [-33.9249, 18.4241, -26.2041, 28.0473]);
    const result = await asSuperuser<{ i: number; d: number }>(
      db,
      `SELECT t.i::int AS i, public.haversine_distance_meters(t.a, t.b, t.c, t.e) AS d
       FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[]) WITH ORDINALITY AS t(a, b, c, e, i)
       ORDER BY t.i`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1]), pairs.map((p) => p[2]), pairs.map((p) => p[3])]
    );
    pairs.forEach(([lat1, lng1, lat2, lng2], index) => {
      const ts = calculateDistanceMetersPrecise(lat1, lng1, lat2, lng2);
      const sql = result.rows[index].d;
      const tolerance = Math.max(1e-6, ts * 1e-12);
      assert.ok(Math.abs(sql - ts) <= tolerance, `(${lat1},${lng1})->(${lat2},${lng2}): SQL ${sql} vs TS ${ts}`);
    });
  });
});

describe('scan verdict: patrol_scans trigger == assessCheckpointProximity()', () => {
  test('stored distance, confidence and validity match the phone-side assessment', async () => {
    const guard = fx.users.guardA;
    const shiftId = await startShiftAs(db, guard, fx.siteA1);
    const random = prng(0x5ca7);
    const R = 6371008.8;
    const checkpoint = { latitude: fx.cpLat, longitude: fx.cpLng, permittedRadiusMeters: 50 };
    let compared = 0;
    const seen = new Set<string>();
    for (let n = 0; n < 160; n += 1) {
      // Random bearing and distance (0-250 m) from checkpoint cpA1 (radius 50 m).
      const distance = random() * 250;
      const bearing = random() * 2 * Math.PI;
      const dLat = ((distance * Math.cos(bearing)) / R) * (180 / Math.PI);
      const dLng = ((distance * Math.sin(bearing)) / (R * Math.cos((fx.cpLat * Math.PI) / 180))) * (180 / Math.PI);
      const fix = { latitude: fx.cpLat + dLat, longitude: fx.cpLng + dLng, accuracy: random() < 0.1 ? null : random() * 120 };
      const expected = assessCheckpointProximity(fix, checkpoint);

      // Two different distance formulas (asin vs atan2) agree to ~1e-9 m; skip the few points
      // that sit within a micrometre of a decision boundary, where either answer is correct.
      const d = calculateDistanceMetersPrecise(fix.latitude, fix.longitude, fx.cpLat, fx.cpLng);
      const a = fix.accuracy ?? 0;
      if (fix.accuracy !== null && [d + a - 50, d - 50, a - 50, d - a - 50].some((m) => Math.abs(m) < 1e-6)) continue;

      const id = randomUUID();
      await asUser(
        db,
        guard,
        `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device,
                                   latitude, longitude, accuracy_meters, method, payload_type,
                                   distance_to_checkpoint_meters, gps_confidence, is_valid_proximity)
         VALUES ($1, $1, $2, $3, $4, now(), $5, $6, $7, 'qr', 'secure_token', 0, 'verified', true)`,
        [id, shiftId, fx.checkpoints.cpA1, guard, fix.latitude, fix.longitude, fix.accuracy]
      );
      const stored = await asUser<{ distance_to_checkpoint_meters: number; gps_confidence: string; is_valid_proximity: boolean }>(
        db,
        guard,
        `SELECT distance_to_checkpoint_meters, gps_confidence, is_valid_proximity FROM patrol_scans WHERE id = $1`,
        [id]
      );
      const row = stored.rows[0];
      assert.equal(row.gps_confidence, expected.confidence, `fix ${JSON.stringify(fix)}`);
      assert.equal(row.is_valid_proximity, expected.isValidProximity);
      assert.equal(row.is_valid_proximity, isValidProximityConfidence(row.gps_confidence as never));
      assert.ok(Math.abs(row.distance_to_checkpoint_meters - d) < 1e-6, `distance SQL ${row.distance_to_checkpoint_meters} vs TS ${d}`);
      seen.add(row.gps_confidence);
      compared += 1;
    }
    assert.ok(compared >= 150, `compared ${compared} scans`);
    for (const confidence of ['verified', 'likely', 'low_confidence', 'outside']) {
      assert.ok(seen.has(confidence), `the sample covers '${confidence}'`);
    }
  });

  test('no fix and no reference are decided the same way', async () => {
    const guard = fx.users.guardA;
    const shiftId = await startShiftAs(db, guard, fx.siteA1);
    const cases = [
      { checkpointId: fx.checkpoints.cpA1, fix: null, cp: { latitude: fx.cpLat, longitude: fx.cpLng, permittedRadiusMeters: 50 } },
      {
        checkpointId: fx.checkpoints.cpA1NoCoords,
        fix: { latitude: fx.cpLat, longitude: fx.cpLng, accuracy: 5 },
        cp: { latitude: null, longitude: null, permittedRadiusMeters: 50 }
      }
    ];
    for (const c of cases) {
      const id = randomUUID();
      await asUser(
        db,
        guard,
        `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device,
                                   latitude, longitude, accuracy_meters, method, payload_type)
         VALUES ($1, $1, $2, $3, $4, now(), $5, $6, $7, 'qr', 'secure_token')`,
        [id, shiftId, c.checkpointId, guard, c.fix?.latitude ?? null, c.fix?.longitude ?? null, c.fix?.accuracy ?? null]
      );
      const stored = await asUser<{ gps_confidence: string; distance_to_checkpoint_meters: number | null }>(
        db,
        guard,
        `SELECT gps_confidence, distance_to_checkpoint_meters FROM patrol_scans WHERE id = $1`,
        [id]
      );
      const expected = assessCheckpointProximity(c.fix, c.cp);
      assert.equal(stored.rows[0].gps_confidence, expected.confidence);
      assert.equal(stored.rows[0].distance_to_checkpoint_meters, expected.distanceMeters);
    }
  });
});

describe('fingerprints: sha256_hex() and the checkpoint trigger == production hashing', () => {
  test('sha256_hex() equals sha256() for ASCII, Afrikaans / isiZulu text and emoji', async () => {
    const texts = ['', 'EE-CP-00112233445566778899AABBCCDDEEFF', '04:a2:3b:1c', 'Skaapkraal – hek', 'Ngiyabonga', 'Beware 🐍', 'a'.repeat(1000)];
    for (const text of texts) {
      const sql = await asSuperuser<{ h: string }>(db, `SELECT public.sha256_hex($1) AS h`, [text]);
      assert.equal(sql.rows[0].h, await sha256(text), JSON.stringify(text));
    }
  });

  test('qr_token_sha256 / nfc_uid_sha256 written by the trigger match what the phone computes from a scan', async () => {
    const admin = fx.users.adminA;
    const token = generateCheckpointToken();
    const id = randomUUID();
    await asUser(
      db,
      admin,
      `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, nfc_uid, permitted_radius_meters)
       VALUES ($1, $2, 'Parity point', $3, $4, 50)`,
      [id, fx.siteA1, token, '04 7A B2 C1 5D 80 00']
    );
    const guardView = await asUser<{ qr_token_sha256: string; nfc_uid_sha256: string; qr_token_strong: boolean }>(
      db,
      fx.users.guardA,
      `SELECT qr_token_sha256, nfc_uid_sha256, qr_token_strong FROM checkpoints WHERE id = $1`,
      [id]
    );
    const row = guardView.rows[0];
    assert.equal(row.qr_token_strong, true);
    assert.equal(row.qr_token_sha256, await qrTokenFingerprint(token));
    // Whatever format the phone's reader reports the serial in.
    for (const scanned of ['04:7a:b2:c1:5d:80:00', '04:7A:B2:C1:5D:80:00', '047AB2C15D8000']) {
      assert.equal(row.nfc_uid_sha256, await nfcSerialFingerprint(scanned), scanned);
    }
  });
});

describe('checkpoint QR token rule: database == generateCheckpointToken() / parseCheckpointPayload()', () => {
  test('every generated token is accepted by the checkpoints trigger and parsed as a secure token', async () => {
    for (let n = 0; n < 25; n += 1) {
      const token = generateCheckpointToken();
      assert.equal(parseCheckpointPayload(token).kind, 'secure_token');
      await asUser(
        db,
        fx.users.adminA,
        `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, permitted_radius_meters) VALUES ($1, $2, $3, $4, 50)`,
        [randomUUID(), fx.siteA2, `Generated ${n}`, token]
      );
    }
    const strong = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM checkpoints WHERE site_id = $1 AND name LIKE 'Generated %' AND qr_token_strong`,
      [fx.siteA2]
    );
    assert.equal(strong.rows[0].n, 25);
  });
});

describe('evidence object names: is_evidence_object_name() == parseEvidencePath()', () => {
  test('every path buildEvidencePath() produces is canonical for the storage policy, and look-alikes agree', async () => {
    const random = prng(0xe71d);
    const names: string[] = [];
    const mimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const fields = ['selfie', 'photo', 'photo2', 'photo_10', 'a', 'x'.repeat(32)];
    for (const category of EVIDENCE_CATEGORIES) {
      for (const mimeType of mimeTypes) {
        for (const field of fields) {
          const path = buildEvidencePath({
            organisationId: fx.orgA,
            siteId: fx.siteA1,
            category,
            userId: fx.users.guardA,
            eventId: randomUUID(),
            field,
            mimeType
          });
          names.push(path);
          // Mutations the policy must treat exactly like the TypeScript parser does.
          const segments = path.split('/');
          names.push(
            path.toUpperCase(),
            `/${path}`,
            `${path}/`,
            path.replace('/', '//'),
            path.replace(/\.(jpg|png|webp)$/, '.jpeg'),
            path.replace(/\.(jpg|png|webp)$/, ''),
            path.replace(`-${field}.`, '-.'),
            path.replace(`-${field}.`, `-${field}x${'y'.repeat(32)}.`),
            path.replace(`-${field}.`, '-Photo.'),
            path.replace(`-${field}.`, '-../x.'),
            segments.slice(1).join('/'),
            [...segments.slice(0, 4), 'extra', segments[4]].join('/'),
            [segments[0], segments[1], 'video', segments[3], segments[4]].join('/'),
            [segments[0].replace(/-/g, ''), ...segments.slice(1)].join('/'),
            path.replace(/[0-9a-f]/, 'g'),
            `${path}\n`
          );
          if (random() < 0.2) names.push(path.replace(segments[3], segments[3].toUpperCase()));
        }
      }
    }
    const result = await asSuperuser<{ i: number; ok: boolean }>(
      db,
      `SELECT t.i::int AS i, public.is_evidence_object_name(t.name) AS ok
       FROM unnest($1::text[]) WITH ORDINALITY AS t(name, i) ORDER BY t.i`,
      [names]
    );
    let accepted = 0;
    names.forEach((name, index) => {
      const ts = parseEvidencePath(name) !== null;
      if (ts) accepted += 1;
      assert.equal(result.rows[index].ok, ts, `${JSON.stringify(name)}: SQL ${result.rows[index].ok} vs TS ${ts}`);
    });
    assert.equal(accepted, EVIDENCE_CATEGORIES.length * mimeTypes.length * fields.length, 'exactly the built paths are canonical');
  });
});
