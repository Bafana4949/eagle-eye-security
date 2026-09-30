import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eventLocationFromFix } from './eventLocation';

describe('eventLocationFromFix', () => {
  it('uses a fresh fix with its own timestamp', () => {
    const at = Date.parse('2026-09-30T17:59:58.000Z');
    assert.deepEqual(eventLocationFromFix({ status: 'ok', latitude: -25.68, longitude: 27.81, accuracy: 6, timestamp: at, ageMs: 2000 }), {
      latitude: -25.68,
      longitude: 27.81,
      accuracyMeters: 6,
      locationTimestamp: '2026-09-30T17:59:58.000Z',
      gpsError: null
    });
  });

  it('never presents a stale fix as the current position', () => {
    const result = eventLocationFromFix({ status: 'stale', latitude: -25.68, longitude: 27.81, accuracy: 6, timestamp: 0, ageMs: 600_000 });
    assert.equal(result.latitude, null);
    assert.equal(result.longitude, null);
    assert.equal(result.gpsError, 'stale');
  });

  it('records why there is no fix', () => {
    for (const status of ['permission_denied', 'timeout', 'unavailable', 'unsupported', 'insecure'] as const) {
      assert.deepEqual(eventLocationFromFix({ status, message: 'x' }), {
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        locationTimestamp: null,
        gpsError: status
      });
    }
  });
});
