/**
 * Translated wording for patrol states. Kept in one place so every screen uses the same honest
 * words: only 'verified'/'likely' GPS verdicts sound positive, and only a synced item is
 * "uploaded".
 */
import type { TranslationKey } from '@/lib/i18n/translations';
import { formatDistance } from '@/lib/gps/haversine';
import type { CheckpointPayloadType, GpsConfidence, GpsErrorKind, ScanMethod } from '@/types/models';
import type { SyncState } from '@/types/offline';
import { ageParts, durationParts } from './patrolLogic';

export type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;

const GPS_ERROR_KEYS: Record<GpsErrorKind, TranslationKey> = {
  permission_denied: 'patrolGpsErrDenied',
  timeout: 'patrolGpsErrTimeout',
  unavailable: 'patrolGpsErrUnavailable',
  unsupported: 'patrolGpsErrUnsupported',
  insecure: 'patrolGpsErrInsecure',
  stale: 'patrolGpsErrStale'
};

export function gpsErrorText(t: Translate, kind: GpsErrorKind | null | undefined): string {
  return kind ? t(GPS_ERROR_KEYS[kind]) : t('patrolGpsErrUnavailable');
}

export function accuracyText(t: Translate, accuracyMeters: number | null | undefined): string {
  return typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
    ? `${Math.round(accuracyMeters)} m`
    : t('patrolAccuracyUnknown');
}

/** Full sentence for a scan's GPS verdict (phone estimate). */
export function confidenceText(
  t: Translate,
  confidence: GpsConfidence | null,
  distanceMeters: number | null,
  accuracyMeters: number | null,
  gpsError: GpsErrorKind | null
): string {
  const distance = typeof distanceMeters === 'number' ? formatDistance(distanceMeters) : '?';
  const accuracy = accuracyText(t, accuracyMeters);
  switch (confidence) {
    case 'verified':
      return t('patrolGpsVerified', distance, accuracy);
    case 'likely':
      return t('patrolGpsLikely', distance, accuracy);
    case 'low_confidence':
      return t('patrolGpsLow', distance, accuracy);
    case 'outside':
      return t('patrolGpsOutside', distance, accuracy);
    case 'no_reference':
      return t('patrolGpsNoRef');
    default:
      return t('patrolGpsNoFix', gpsErrorText(t, gpsError));
  }
}

const SHORT_CONFIDENCE_KEYS: Record<GpsConfidence, TranslationKey> = {
  verified: 'patrolGpsShortVerified',
  likely: 'patrolGpsShortLikely',
  low_confidence: 'patrolGpsShortLow',
  outside: 'patrolGpsShortOutside',
  no_fix: 'patrolGpsShortNoFix',
  no_reference: 'patrolGpsShortNoRef'
};

export function shortConfidenceText(t: Translate, confidence: GpsConfidence | null): string {
  return t(SHORT_CONFIDENCE_KEYS[confidence ?? 'no_fix']);
}

/** Full sentence for an upload state. "Uploaded" only when the sync engine marked it synced. */
export function syncText(t: Translate, state: SyncState | 'unknown', lastError: string | null): string {
  switch (state) {
    case 'synced':
      return t('patrolSyncSynced');
    case 'syncing':
      return t('patrolSyncSyncing');
    case 'failed':
      return t('patrolSyncFailed', lastError ?? '?');
    case 'pending':
      return lastError ? t('patrolSyncRetrying', lastError) : t('patrolSyncPending');
    default:
      return t('patrolSyncUnknown');
  }
}

export function shortSyncText(t: Translate, state: SyncState | 'unknown'): string {
  switch (state) {
    case 'synced':
      return t('patrolSyncShortSynced');
    case 'syncing':
      return t('patrolSyncShortSyncing');
    case 'failed':
      return t('patrolSyncShortFailed');
    case 'pending':
      return t('patrolSyncShortPending');
    default:
      return t('patrolSyncUnknown');
  }
}

export function ageText(t: Translate, ageMs: number): string {
  const { unit, value } = ageParts(ageMs);
  if (unit === 'now') return t('patrolAgeJustNow');
  if (unit === 'min') return t('patrolAgeMinutes', value);
  if (unit === 'h') return t('patrolAgeHours', value);
  return t('patrolAgeDays', value);
}

export function durationText(t: Translate, durationMs: number): string {
  const { hours, minutes } = durationParts(durationMs);
  return hours > 0 ? t('patrolDurationHM', hours, minutes) : t('patrolDurationM', minutes);
}

/** How the checkpoint was identified. Legacy PLAAS-CP cards are always labelled as such. */
export function methodText(t: Translate, method: ScanMethod, payloadType: CheckpointPayloadType | null): string {
  if (payloadType === 'legacy_qr') return t('patrolViaLegacy');
  return method === 'nfc' ? t('patrolViaNfc') : t('patrolViaQr');
}
