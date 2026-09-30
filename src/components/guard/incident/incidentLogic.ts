/**
 * Pure helpers for the incident report page and the SOS panic flow (no React, no browser APIs),
 * so they can be unit-tested with node:test.
 *
 * Truthfulness rules implemented here:
 * - A record is "received" only when the sync engine's queue item is 'synced'.
 * - An SOS is "acknowledged" only when the panic_alerts row says so.
 * - WhatsApp messages are built from real values only; missing GPS is stated, never invented.
 * - Record ids shown to guards are the real event id (short form), never a made-up reference.
 */
import type { TranslationKey } from '@/lib/i18n/translations';
import type { GpsErrorKind, IncidentSeverity } from '@/types/models';
import type { SyncState } from '@/types/offline';
import type { LocationFixResult } from '@/lib/gps/location';
import { normalizeSouthAfricanMobile, type MobileNumberRejection } from '@/lib/whatsapp/summary';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';

export type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;

// ---------------------------------------------------------------------------
// Incident types and severities (reference app types: fence, gate, stock, person, fire, other)
// ---------------------------------------------------------------------------

export const INCIDENT_TYPES = ['fence', 'gate', 'stock', 'person', 'fire', 'other'] as const;
export type IncidentTypeId = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];

/** Longest description the form accepts (the column is TEXT; this keeps WhatsApp links short). */
export const DESCRIPTION_MAX_LENGTH = 1000;

const TYPE_KEYS: Record<IncidentTypeId, TranslationKey> = {
  fence: 'incident.type.fence',
  gate: 'incident.type.gate',
  stock: 'incident.type.stock',
  person: 'incident.type.person',
  fire: 'incident.type.fire',
  other: 'incident.type.other'
};

const SEVERITY_KEYS: Record<IncidentSeverity, TranslationKey> = {
  low: 'incident.severity.low',
  medium: 'incident.severity.medium',
  high: 'incident.severity.high',
  critical: 'incident.severity.critical'
};

const GPS_ERROR_KEYS: Record<GpsErrorKind, TranslationKey> = {
  permission_denied: 'incident.gpsError.permission_denied',
  timeout: 'incident.gpsError.timeout',
  unavailable: 'incident.gpsError.unavailable',
  unsupported: 'incident.gpsError.unsupported',
  insecure: 'incident.gpsError.insecure',
  stale: 'incident.gpsError.stale'
};

export function isIncidentTypeId(value: string): value is IncidentTypeId {
  return (INCIDENT_TYPES as readonly string[]).includes(value);
}

/** Label of a stored incident type. Unknown (older) types are shown as stored, not relabelled. */
export function incidentTypeLabel(type: string, t: Translate): string {
  return isIncidentTypeId(type) ? t(TYPE_KEYS[type]) : type;
}

export function severityLabel(severity: IncidentSeverity, t: Translate): string {
  return t(SEVERITY_KEYS[severity] ?? SEVERITY_KEYS.medium);
}

export function gpsErrorLabel(kind: GpsErrorKind | null | undefined, t: Translate): string {
  return t(GPS_ERROR_KEYS[kind ?? 'unavailable'] ?? GPS_ERROR_KEYS.unavailable);
}

// ---------------------------------------------------------------------------
// Ids, links, numbers
// ---------------------------------------------------------------------------

/** First 8 hex digits of the real event id (also the server row id), upper-case. */
export function shortEventId(id: string): string {
  return id.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toUpperCase();
}

export function mapsLink(latitude: number, longitude: number): string {
  return `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

/** Rounded accuracy in metres, or null when the browser gave no usable accuracy. */
export function roundedAccuracy(accuracy: number | null | undefined): number | null {
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;
}

/** GPS fixes worse than this are shown as "weak" (the reference app's 100 m rule of thumb). */
export const WEAK_ACCURACY_METERS = 100;

/**
 * tel: link for a configured phone number, or null when nothing dialable is configured.
 * Keeps a leading '+' and the digits; spaces, brackets and dashes are dropped.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/** SAPS national emergency number, used only when the site has no police number configured. */
export const NATIONAL_POLICE_NUMBER = '10111';

export function policeNumber(sitePolicePhone: string | null | undefined): { number: string; isNationalFallback: boolean } {
  const configured = typeof sitePolicePhone === 'string' ? sitePolicePhone.trim() : '';
  if (configured && telHref(configured)) return { number: configured, isNationalFallback: false };
  return { number: NATIONAL_POLICE_NUMBER, isNationalFallback: true };
}

export type WhatsAppRecipient =
  | { kind: 'ok'; digits: string; display: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: MobileNumberRejection };

/** The site's WhatsApp dispatch number, validated (never guessed). */
export function whatsAppRecipient(dispatchNumber: string | null | undefined): WhatsAppRecipient {
  if (typeof dispatchNumber !== 'string' || dispatchNumber.trim() === '') return { kind: 'missing' };
  const normalized = normalizeSouthAfricanMobile(dispatchNumber);
  return normalized.ok
    ? { kind: 'ok', digits: normalized.digits, display: normalized.display }
    : { kind: 'invalid', reason: normalized.reason };
}

// ---------------------------------------------------------------------------
// Locations used in WhatsApp messages
// ---------------------------------------------------------------------------

export interface MessageLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Device-clock epoch ms at which the position was observed (receipt time minus its age). */
  observedAt: number;
}

/**
 * A fix (fresh or stale) as a message location, or null when there is no position.
 * `nowMs` is when the result was received by the caller.
 */
export function messageLocationFromFix(fix: LocationFixResult | null, nowMs: number): MessageLocation | null {
  if (!fix || (fix.status !== 'ok' && fix.status !== 'stale')) return null;
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyMeters: roundedAccuracy(fix.accuracy),
    observedAt: nowMs - Math.max(0, fix.ageMs)
  };
}

/** Prefers the newer of two message locations (either may be missing). */
export function newestLocation(a: MessageLocation | null, b: MessageLocation | null): MessageLocation | null {
  if (!a) return b;
  if (!b) return a;
  return b.observedAt > a.observedAt ? b : a;
}

/** Positions older than this are labelled "last known position (N min ago)" (reference app: 5 min). */
export const LAST_KNOWN_AFTER_MS = 5 * 60_000;

export function locationLine(location: MessageLocation | null, t: Translate, nowMs: number): string {
  if (!location) return t('incident.msg.noGps');
  const accuracy = roundedAccuracy(location.accuracyMeters);
  const link = `${mapsLink(location.latitude, location.longitude)}${accuracy !== null ? ` (±${accuracy} m)` : ''}`;
  const ageMs = nowMs - location.observedAt;
  if (ageMs >= LAST_KNOWN_AFTER_MS) {
    return `${t('incident.sos.msg.lastKnown', Math.floor(ageMs / 60_000))} ${link}`;
  }
  return link;
}

function stamp(ms: number): string {
  return `${sastDateString(ms)} ${sastTimeHM(ms)}`;
}

export interface PanicMessageInput {
  guardName: string | null;
  siteName: string | null;
  triggeredAt: number;
  location: MessageLocation | null;
  /** Real event id of the queued panic alert, when it was saved. */
  alertId: string | null;
  nowMs: number;
}

/** WhatsApp SOS text (like the reference app's panicText): who, where, when, map link ± accuracy. */
export function buildPanicMessage(input: PanicMessageInput, t: Translate): string {
  const lines = [
    t('incident.sos.msg.title', input.guardName?.trim() || t('incident.msg.unknownGuard')),
    input.siteName ? t('incident.siteLine', input.siteName) : null,
    stamp(input.triggeredAt),
    locationLine(input.location, t, input.nowMs),
    input.alertId ? t('incident.sos.alertId', shortEventId(input.alertId)) : null
  ];
  return lines.filter((line): line is string => !!line).join('\n');
}

export interface IncidentMessageInput {
  incidentType: string;
  severity: IncidentSeverity;
  description: string;
  guardName: string | null;
  siteName: string | null;
  reportedAt: number;
  location: MessageLocation | null;
  recordId: string;
  nowMs: number;
}

/** WhatsApp incident text (reference app's incident message plus severity and record id). */
export function buildIncidentMessage(input: IncidentMessageInput, t: Translate): string {
  const lines = [
    t('incident.msg.title', incidentTypeLabel(input.incidentType, t)),
    t('incident.msg.severity', severityLabel(input.severity, t)),
    `${input.guardName?.trim() || t('incident.msg.unknownGuard')} – ${stamp(input.reportedAt)}`,
    input.siteName ? t('incident.siteLine', input.siteName) : null,
    input.description.trim() || null,
    locationLine(input.location, t, input.nowMs),
    t('incident.recordId', shortEventId(input.recordId))
  ];
  return lines.filter((line): line is string => !!line).join('\n');
}

// ---------------------------------------------------------------------------
// Truthful status of a record saved on this phone
// ---------------------------------------------------------------------------

export type RecordStatus =
  | 'loading'
  | 'queued_offline'
  | 'waiting'
  | 'uploading'
  | 'retrying'
  | 'received'
  | 'failed'
  | 'unknown';

export interface RecordStatusInput {
  loaded: boolean;
  /** Queue item state as reported by the sync engine; undefined when this phone has no such item. */
  syncState: SyncState | undefined;
  lastError?: string;
  isOnline: boolean;
}

export function deriveRecordStatus(input: RecordStatusInput): RecordStatus {
  if (!input.loaded) return 'loading';
  switch (input.syncState) {
    case 'synced':
      return 'received';
    case 'failed':
      return 'failed';
    case 'syncing':
      return 'uploading';
    case 'pending':
      if (!input.isOnline) return 'queued_offline';
      return input.lastError ? 'retrying' : 'waiting';
    default:
      return 'unknown';
  }
}

export const RECORD_STATUS_KEYS: Record<RecordStatus, TranslationKey> = {
  loading: 'incident.status.loading',
  queued_offline: 'incident.status.queuedOffline',
  waiting: 'incident.status.waiting',
  uploading: 'incident.status.uploading',
  retrying: 'incident.status.retrying',
  received: 'incident.status.received',
  failed: 'incident.status.failed',
  unknown: 'incident.status.unknown'
};

export const RECORD_STATUS_SHORT_KEYS: Record<RecordStatus, TranslationKey> = {
  loading: 'incident.status.loading',
  queued_offline: 'incident.short.queued',
  waiting: 'incident.short.queued',
  uploading: 'incident.short.uploading',
  retrying: 'incident.short.queued',
  received: 'incident.short.received',
  failed: 'incident.short.failed',
  unknown: 'incident.status.unknown'
};

/** Theme text colour for a record status. */
export function recordStatusTone(status: RecordStatus): 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'received') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'loading' || status === 'unknown') return 'muted';
  return 'warning';
}

// ---------------------------------------------------------------------------
// SOS stages
// ---------------------------------------------------------------------------

export type SosStage = 'saving' | 'save_failed' | 'queued' | 'submitted' | 'acknowledged' | 'failed';

export interface PanicAcknowledgement {
  status: 'active' | 'acknowledged' | 'resolved';
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
}

/** True when the panic_alerts row shows that somebody handled the alert. */
export function isAcknowledged(row: Pick<PanicAcknowledgement, 'status' | 'acknowledgedAt'> | null): boolean {
  return !!row && (row.acknowledgedAt !== null || row.status !== 'active');
}

export interface SosStageInput {
  eventId: string | null;
  saveError: string | null;
  syncState: SyncState | undefined;
  acknowledgement: PanicAcknowledgement | null;
}

export function deriveSosStage(input: SosStageInput): SosStage {
  if (input.saveError) return 'save_failed';
  if (!input.eventId) return 'saving';
  if (isAcknowledged(input.acknowledgement)) return 'acknowledged';
  if (input.syncState === 'synced') return 'submitted';
  if (input.syncState === 'failed') return 'failed';
  return 'queued';
}

// ---------------------------------------------------------------------------
// Press-and-hold
// ---------------------------------------------------------------------------

/** How long SOS must be held (reference app: 2 s). */
export const SOS_HOLD_MS = 2000;

/** 0…1 progress of a hold that has lasted `elapsedMs`. */
export function holdProgress(elapsedMs: number, durationMs: number = SOS_HOLD_MS): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / durationMs);
}

/** Seconds left, rounded UP to one decimal ("1.4"), for the text countdown. */
export function holdSecondsLeft(elapsedMs: number, durationMs: number = SOS_HOLD_MS): string {
  const leftMs = Math.max(0, durationMs - Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  return (Math.ceil(leftMs / 100) / 10).toFixed(1);
}
