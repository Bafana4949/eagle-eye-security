import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  EARTH_RADIUS_METERS,
  assessCheckpointProximity,
  calculateDistanceMeters,
  calculateDistanceMetersPrecise,
  classifyGpsConfidence,
  formatCoordinates,
  formatDistance,
  isValidProximityConfidence,
  validateProximity
} from './haversine';

describe('GPS and Haversine Distance', () => {
  it('uses the IUGG mean Earth radius shared with the SQL trigger', () => {
    assert.strictEqual(EARTH_RADIUS_METERS, 6371008.8);
    // One degree of latitude = R·π/180
    const oneDegree = calculateDistanceMetersPrecise(0, 0, 1, 0);
    assert.ok(Math.abs(oneDegree - (6371008.8 * Math.PI) / 180) < 1e-6);
  });

  it('calculates zero distance for identical coordinates', () => {
    const dist = calculateDistanceMeters(-25.684120, 27.814520, -25.684120, 27.814520);
    assert.strictEqual(dist, 0);
  });

  it('calculates accurate distance between known points', () => {
    // Main Gate → Sheep Kraal: Vincenty (WGS-84) gives 109.9 m
    const dist = calculateDistanceMeters(-25.684120, 27.814520, -25.684890, 27.815210);
    assert.ok(dist >= 108 && dist <= 112, `Expected ~110m, got ${dist}`);
  });

  it('validates guard within allowed radius', () => {
    const result = validateProximity(-25.684120, 27.814520, 5, -25.684140, 27.814530, 50);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.confidence, 'verified');
    assert.strictEqual(result.excessMeters, 0);
    assert.ok(result.distanceMeters < 10);
  });

  it('flags guard as invalid when outside radius', () => {
    // ~209 m away with 50 m radius
    const result = validateProximity(-25.684120, 27.814520, 5, -25.686000, 27.814520, 50);
    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.confidence, 'outside');
    assert.ok(result.excessMeters > 100);
  });

  it('no longer treats a ±100 m fix 15 m away as valid (audit case)', () => {
    // 15 m north of the checkpoint (1 m of latitude ≈ 1/111195 degrees)
    const result = validateProximity(-25.684120 + 15 / 111195, 27.81452, 100, -25.684120, 27.81452, 50);
    assert.strictEqual(result.confidence, 'low_confidence');
    assert.strictEqual(result.isValid, false);
  });

  it('formats distance in meters and kilometers correctly', () => {
    assert.strictEqual(formatDistance(45), '45 m');
    assert.strictEqual(formatDistance(1500), '1.50 km');
  });

  it('formats coordinates safely', () => {
    assert.strictEqual(formatCoordinates(-25.6841234, 27.8145234), '-25.68412, 27.81452');
    assert.strictEqual(formatCoordinates(undefined, undefined), 'No GPS');
  });
});

describe('classifyGpsConfidence (contract cases)', () => {
  const r = 50;
  it('no fix → no_fix', () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: null, accuracyMeters: null, radiusMeters: r, hasFix: false }), 'no_fix');
  });
  it('checkpoint without coordinates → no_reference', () => {
    assert.strictEqual(
      classifyGpsConfidence({ distanceMeters: null, accuracyMeters: 5, radiusMeters: r, hasFix: true, hasReference: false }),
      'no_reference'
    );
  });
  it('5 m @ ±4 m → verified', () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 5, accuracyMeters: 4, radiusMeters: r }), 'verified');
  });
  it('40 m @ ±30 m → likely', () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 40, accuracyMeters: 30, radiusMeters: r }), 'likely');
  });
  it('15 m @ ±100 m → low_confidence', () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 15, accuracyMeters: 100, radiusMeters: r }), 'low_confidence');
  });
  it("Dawie's 'far' (d > 50 + acc) → outside", () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 5004, accuracyMeters: 3, radiusMeters: r }), 'outside');
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 60.5, accuracyMeters: 10, radiusMeters: r }), 'outside');
  });
});

describe('classifyGpsConfidence boundaries', () => {
  const r = 50;
  const c = (d: number, a: number | null) => classifyGpsConfidence({ distanceMeters: d, accuracyMeters: a, radiusMeters: r });
  it('d + a == r is verified; just over is likely', () => {
    assert.strictEqual(c(30, 20), 'verified');
    assert.strictEqual(c(30, 20.001), 'likely');
  });
  it('d == r and a == r is likely; a just over r is low_confidence', () => {
    assert.strictEqual(c(50, 50), 'likely');
    assert.strictEqual(c(50, 50.001), 'low_confidence');
  });
  it('d - a == r is low_confidence (not provably outside); just over is outside', () => {
    assert.strictEqual(c(70, 20), 'low_confidence');
    assert.strictEqual(c(70.001, 20), 'outside');
  });
  it('d just over r with a small accuracy is outside', () => {
    assert.strictEqual(c(50.5, 0), 'outside');
    assert.strictEqual(c(50, 0), 'verified');
  });
  it('unknown / invalid accuracy can never be verified, likely or outside', () => {
    assert.strictEqual(c(0, null), 'low_confidence');
    assert.strictEqual(c(0, Number.NaN), 'low_confidence');
    assert.strictEqual(c(0, -1), 'low_confidence');
    assert.strictEqual(c(5000, null), 'low_confidence');
  });
  it('invalid radius or distance are not treated as valid', () => {
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: 1, accuracyMeters: 1, radiusMeters: 0 }), 'no_reference');
    assert.strictEqual(classifyGpsConfidence({ distanceMeters: Number.NaN, accuracyMeters: 1, radiusMeters: 50 }), 'no_fix');
  });
  it('only verified and likely are proximity-valid', () => {
    assert.deepStrictEqual(
      (['verified', 'likely', 'low_confidence', 'outside', 'no_fix', 'no_reference'] as const).map(isValidProximityConfidence),
      [true, true, false, false, false, false]
    );
  });
});

describe('assessCheckpointProximity', () => {
  const checkpoint = { latitude: -25.68412, longitude: 27.81452, permittedRadiusMeters: 50 };
  it('computes distance and confidence for a good fix', () => {
    const a = assessCheckpointProximity({ latitude: -25.68412, longitude: 27.81452, accuracy: 4 }, checkpoint);
    assert.deepStrictEqual(a, { confidence: 'verified', isValidProximity: true, distanceMeters: 0, accuracyMeters: 4, radiusMeters: 50 });
  });
  it('no fix → no_fix, never valid (fail closed)', () => {
    const a = assessCheckpointProximity(null, checkpoint);
    assert.strictEqual(a.confidence, 'no_fix');
    assert.strictEqual(a.isValidProximity, false);
    assert.strictEqual(a.distanceMeters, null);
  });
  it('checkpoint without coordinates → no_reference, never valid', () => {
    const a = assessCheckpointProximity({ latitude: -25.7, longitude: 27.8, accuracy: 5 }, { permittedRadiusMeters: 50 });
    assert.strictEqual(a.confidence, 'no_reference');
    assert.strictEqual(a.isValidProximity, false);
    assert.strictEqual(a.distanceMeters, null);
  });
});
