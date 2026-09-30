/**
 * Geolocation and Haversine Distance Utilities for Checkpoint Proximity Validation
 */

export interface ProximityResult {
  distanceMeters: number;
  permittedRadiusMeters: number;
  accuracyMeters: number;
  isValid: boolean;
  excessMeters: number;
}

/**
 * Calculates the great-circle distance between two geographic coordinates using Haversine formula.
 * Returns distance in meters rounded to the nearest integer.
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000; // Earth's mean radius in meters

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Validates whether the guard is within acceptable proximity of a checkpoint.
 * Takes device GPS accuracy into account so guards are not unfairly penalized under dense foliage or roof structures.
 */
export function validateProximity(
  guardLat: number,
  guardLon: number,
  accuracyMeters: number = 0,
  checkpointLat: number,
  checkpointLon: number,
  permittedRadiusMeters: number = 50
): ProximityResult {
  const distance = calculateDistanceMeters(guardLat, guardLon, checkpointLat, checkpointLon);
  // Allowed threshold is permitted radius + GPS accuracy tolerance (capped at +50m)
  const accuracyTolerance = Math.min(Math.max(0, accuracyMeters), 50);
  const allowedThreshold = permittedRadiusMeters + accuracyTolerance;

  const isValid = distance <= allowedThreshold;
  const excess = isValid ? 0 : distance - allowedThreshold;

  return {
    distanceMeters: distance,
    permittedRadiusMeters,
    accuracyMeters: Math.round(accuracyMeters),
    isValid,
    excessMeters: Math.round(excess)
  };
}

/**
 * Formats distance for clean display in mobile UI
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

/**
 * Formats GPS coordinates to standard 5-decimal places (~1m precision)
 */
export function formatCoordinates(lat?: number, lon?: number): string {
  if (lat == null || lon == null) return 'No GPS';
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
