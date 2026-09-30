/**
 * Translated labels for database codes, and the theme-token classes for each tone.
 * Unknown codes are shown as stored (never guessed).
 */
import type { TranslationKey } from '@/lib/i18n/translations';
import type {
  AlertStatus,
  CheckpointPayloadType,
  GpsConfidence,
  IncidentSeverity,
  IncidentStatus,
  ShiftStatus,
  ShiftType
} from '@/types/models';
import type { Tone } from '../data/derive';

export type TFn = (key: TranslationKey, ...args: (string | number)[]) => string;

export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger-text',
  muted: 'text-ee-muted'
};

export const TONE_CHIP: Record<Tone, string> = {
  success: 'bg-ee-success/15 text-ee-success border-ee-success/40',
  warning: 'bg-ee-warning/15 text-ee-warning border-ee-warning/40',
  danger: 'bg-ee-danger/15 text-ee-danger-text border-ee-danger/40',
  muted: 'bg-ee-bg text-ee-muted border-ee-border'
};

const INCIDENT_TYPES: Record<string, TranslationKey> = {
  fence: 'supIncFence',
  gate: 'supIncGate',
  person: 'supIncPerson',
  fire: 'supIncFire',
  stock: 'supIncStock',
  theft: 'supIncTheft',
  medical: 'supIncMedical',
  other: 'supIncOther'
};

export function incidentTypeLabel(t: TFn, type: string): string {
  const key = INCIDENT_TYPES[type];
  return key ? t(key) : type;
}

const SEVERITY: Record<IncidentSeverity, TranslationKey> = {
  low: 'supSevLow',
  medium: 'supSevMedium',
  high: 'supSevHigh',
  critical: 'supSevCritical'
};

export function severityLabel(t: TFn, severity: IncidentSeverity): string {
  return SEVERITY[severity] ? t(SEVERITY[severity]) : severity;
}

export function severityTone(severity: IncidentSeverity): Tone {
  return severity === 'critical' || severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'muted';
}

const INCIDENT_STATUS: Record<IncidentStatus, TranslationKey> = {
  reported: 'supStatusReported',
  acknowledged: 'supStatusAcknowledged',
  investigating: 'supStatusInvestigating',
  resolved: 'supStatusResolved'
};

export function incidentStatusLabel(t: TFn, status: IncidentStatus): string {
  return INCIDENT_STATUS[status] ? t(INCIDENT_STATUS[status]) : status;
}

export function incidentStatusTone(status: IncidentStatus): Tone {
  return status === 'reported' ? 'danger' : status === 'resolved' ? 'success' : 'warning';
}

const PANIC_STATUS: Record<AlertStatus, TranslationKey> = {
  active: 'supSosActive',
  acknowledged: 'supStatusAcknowledged',
  resolved: 'supStatusResolved'
};

export function panicStatusLabel(t: TFn, status: AlertStatus): string {
  return PANIC_STATUS[status] ? t(PANIC_STATUS[status]) : status;
}

const CONFIDENCE: Record<GpsConfidence, TranslationKey> = {
  verified: 'supGpsVerified',
  likely: 'supGpsLikely',
  low_confidence: 'supGpsLow',
  outside: 'supGpsOutside',
  no_fix: 'supGpsNoFix',
  no_reference: 'supGpsNoReference'
};

export function confidenceLabel(t: TFn, confidence: GpsConfidence | null): string {
  if (!confidence) return t('supGpsUnknown');
  return CONFIDENCE[confidence] ? t(CONFIDENCE[confidence]) : confidence;
}

export function payloadLabel(t: TFn, payloadType: CheckpointPayloadType | null, verified: boolean | null): string {
  switch (payloadType) {
    case 'secure_token':
      return verified ? t('supPayloadQrVerified') : t('supPayloadQrUnverified');
    case 'nfc_uid':
      return verified ? t('supPayloadNfcVerified') : t('supPayloadNfcUnverified');
    case 'legacy_qr':
      return t('supPayloadLegacy');
    case 'manual':
      return t('supPayloadManual');
    default:
      return t('supPayloadUnknown');
  }
}

export function payloadTone(payloadType: CheckpointPayloadType | null, verified: boolean | null): Tone {
  if ((payloadType === 'secure_token' || payloadType === 'nfc_uid') && verified) return 'success';
  return 'warning';
}

export function shiftTypeLabel(t: TFn, type: ShiftType): string {
  return type === 'day' ? t('supShiftDay') : type === 'night' ? t('supShiftNight') : t('supShiftCustom');
}

export function shiftStatusLabel(t: TFn, status: ShiftStatus): string {
  return status === 'active' ? t('supShiftOpen') : status === 'completed' ? t('supShiftCompleted') : t('supShiftAbandoned');
}

export function shiftStatusTone(status: ShiftStatus): Tone {
  return status === 'active' ? 'success' : status === 'completed' ? 'muted' : 'warning';
}

/** Google Maps link for a phone-reported position. */
export function mapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

/** Digits and a leading + only, for a tel: link. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Message for a failed supervisor write (nothing was saved in any of these cases). */
export function writeProblemMessage(t: TFn, problem: 'network' | 'not_allowed' | 'no_rows' | 'error', detail?: string): string {
  switch (problem) {
    case 'network':
      return t('supWriteNetwork');
    case 'not_allowed':
      return t('supWriteNotAllowed');
    case 'no_rows':
      return t('supWriteNoRows');
    default:
      return detail ? `${t('supWriteFailed')} (${detail})` : t('supWriteFailed');
  }
}

/** Message for a failed read. */
export function loadProblemMessage(t: TFn, error: unknown): string {
  const kind = error && typeof error === 'object' && 'kind' in error ? (error as { kind: unknown }).kind : null;
  if (kind === 'network') return t('supLoadNetwork');
  if (kind === 'not_allowed') return t('supLoadNotAllowed');
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message ? `${t('supLoadFailed')} (${message})` : t('supLoadFailed');
}
