/**
 * Geolocation and Haversine Distance Utilities for Checkpoint Proximity Validation.
 *
 * The confidence rules below are duplicated in the patrol_scans SQL trigger, which is the
 * authority (client values are recomputed server-side). Keep both in sync:
 *   no guard fix                         → no_fix
 *   checkpoint has no coordinates        → no_reference
 *   d + a <= r                           → verified
 *   d <= r AND a <= r                    → likely
 *   d - a > r                            → outside
 *   otherwise                            → low_confidence
 * d = unrounded haversine distance (R = 6 371 008.8 m), a = reported accuracy, r = radius.
 * A missing / negative / non-finite accuracy is treated as unknown (infinitely poor), so it
 * can never be 'verified' or 'likely' and never provably 'outside' → low_confidence.
 */

import type { GpsConfidence } from '@/types/models';

/** IUGG mean Earth radius in metres (same constant as the SQL trigger). */
export const EARTH_RADIUS_METERS = 6371008.8;

export interface ProximityResult {
  distanceMeters: number;
  permittedRadiusMeters: number;
  accuracyMeters: number;
  /** true only for 'verified' or 'likely' confidence. */
  isValid: boolean;
  /** Metres beyond the permitted radius (0 when inside). */
  excessMeters: number;
  confidence: GpsConfidence;
}

/** Unrounded great-circle distance in metres (used for classification). */
export function calculateDistanceMetersPrecise(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates the great-circle distance between two geographic coordinates using Haversine formula.
 * Returns distance in meters rounded to the nearest integer.
 */
export function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return Math.round(calculateDistanceMetersPrecise(lat1, lon1, lat2, lon2));
}

export interface GpsConfidenceInput {
  /** Distance guard → checkpoint in metres; null/undefined when it cannot be computed. */
  distanceMeters: number | null | undefined;
  accuracyMeters: number | null | undefined;
  radiusMeters: number;
  /** false when the guard had no location fix. */
  hasFix?: boolean;
  /** false when the checkpoint has no stored coordinates. */
  hasReference?: boolean;
}

function isUsableNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Classifies scan location evidence (see rules in the file header). */
export function classifyGpsConfidence(input: GpsConfidenceInput): GpsConfidence {
  if (input.hasFix === false) return 'no_fix';
  if (input.hasReference === false) return 'no_reference';
  if (!isUsableNumber(input.radiusMeters) || input.radiusMeters <= 0) return 'no_reference';
  if (!isUsableNumber(input.distanceMeters) || input.distanceMeters < 0) return 'no_fix';

  const d = input.distanceMeters;
  const r = input.radiusMeters;
  const a = isUsableNumber(input.accuracyMeters) && input.accuracyMeters >= 0 ? input.accuracyMeters : Infinity;

  if (d + a <= r) return 'verified';
  if (d <= r && a <= r) return 'likely';
  if (d - a > r) return 'outside';
  return 'low_confidence';
}

/** Scans with these confidences count as proximity-valid (matches is_valid_proximity in SQL). */
export function isValidProximityConfidence(confidence: GpsConfidence): boolean {
  return confidence === 'verified' || confidence === 'likely';
}

export interface GuardFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export interface CheckpointLocation {
  latitude?: number | null;
  longitude?: number | null;
  permittedRadiusMeters: number;
}

export interface CheckpointProximityAssessment {
  confidence: GpsConfidence;
  isValidProximity: boolean;
  /** Rounded metres, or null when there is no fix or no checkpoint reference. */
  distanceMeters: number | null;
  accuracyMeters: number | null;
  radiusMeters: number;
}

/** Full proximity assessment for a scan from an optional fix and a checkpoint. */
export function assessCheckpointProximity(
  fix: GuardFix | null | undefined,
  checkpoint: CheckpointLocation
): CheckpointProximityAssessment {
  const radiusMeters = checkpoint.permittedRadiusMeters;
  const guard = fix && isUsableNumber(fix.latitude) && isUsableNumber(fix.longitude) ? fix : null;
  const refLat = checkpoint.latitude;
  const refLon = checkpoint.longitude;
  const hasReference = isUsableNumber(refLat) && isUsableNumber(refLon);
  const accuracyMeters = guard && isUsableNumber(guard.accuracy) ? guard.accuracy : null;

  const precise =
    guard && isUsableNumber(refLat) && isUsableNumber(refLon)
      ? calculateDistanceMetersPrecise(guard.latitude, guard.longitude, refLat, refLon)
      : null;

  const confidence = classifyGpsConfidence({
    distanceMeters: precise,
    accuracyMeters,
    radiusMeters,
    hasFix: guard !== null,
    hasReference
  });

  return {
    confidence,
    isValidProximity: isValidProximityConfidence(confidence),
    distanceMeters: precise === null ? null : Math.round(precise),
    accuracyMeters,
    radiusMeters
  };
}

/**
 * Validates whether the guard is within acceptable proximity of a checkpoint.
 * Kept for existing callers; validity now follows the confidence rules above instead of
 * widening the radius by the (capped) accuracy.
 */
export function validateProximity(
  guardLat: number,
  guardLon: number,
  accuracyMeters: number = 0,
  checkpointLat: number,
  checkpointLon: number,
  permittedRadiusMeters: number = 50
): ProximityResult {
  const precise = calculateDistanceMetersPrecise(guardLat, guardLon, checkpointLat, checkpointLon);
  const confidence = classifyGpsConfidence({
    distanceMeters: precise,
    accuracyMeters,
    radiusMeters: permittedRadiusMeters
  });
  return {
    distanceMeters: Math.round(precise),
    permittedRadiusMeters,
    accuracyMeters: Math.round(accuracyMeters),
    isValid: isValidProximityConfidence(confidence),
    excessMeters: Math.max(0, Math.round(precise - permittedRadiusMeters)),
    confidence
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
