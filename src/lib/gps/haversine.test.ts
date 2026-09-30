import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateDistanceMeters, validateProximity, formatDistance, formatCoordinates } from './haversine';

describe('GPS and Haversine Distance', () => {
  it('calculates zero distance for identical coordinates', () => {
    const dist = calculateDistanceMeters(-25.684120, 27.814520, -25.684120, 27.814520);
    assert.strictEqual(dist, 0);
  });

  it('calculates accurate distance between known points', () => {
    // Distance between Main Gate (-25.684120, 27.814520) and Sheep Kraal (-25.684890, 27.815210) is ~110m
    const dist = calculateDistanceMeters(-25.684120, 27.814520, -25.684890, 27.815210);
    assert.ok(dist >= 100 && dist <= 125, `Expected ~110m, got ${dist}`);
  });

  it('validates guard within allowed radius', () => {
    const result = validateProximity(-25.684120, 27.814520, 5, -25.684140, 27.814530, 50);
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.excessMeters, 0);
    assert.ok(result.distanceMeters < 10);
  });

  it('flags guard as invalid when outside radius', () => {
    // 200m away with 50m radius
    const result = validateProximity(-25.684120, 27.814520, 5, -25.686000, 27.814520, 50);
    assert.strictEqual(result.isValid, false);
    assert.ok(result.excessMeters > 100);
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
