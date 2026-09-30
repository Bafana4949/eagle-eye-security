import type { LocationFixResult } from '@/lib/gps/location';
import type { EventLocation } from '@/types/offline';

/**
 * Converts a getLocationFix() result into the location fields of a queued event.
 * Only a fresh fix contributes coordinates. A stale fix is NOT the guard's current position, so
 * it is recorded as gpsError 'stale' without coordinates (the server then classifies 'no_fix'
 * instead of verifying a scan against an old position).
 */
export function eventLocationFromFix(fix: LocationFixResult): EventLocation {
  if (fix.status === 'ok') {
    return {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracyMeters: fix.accuracy,
      locationTimestamp: new Date(fix.timestamp).toISOString(),
      gpsError: null
    };
  }
  return {
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    locationTimestamp: null,
    gpsError: fix.status
  };
}
