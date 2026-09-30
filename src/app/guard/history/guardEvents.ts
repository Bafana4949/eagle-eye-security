/**
 * The guard's own records on this phone (Dexie localEvents) with their upload state (syncQueue),
 * formatted for the History page and the CSV export. Pure functions + Dexie reads only: nothing
 * here invents a value — a field the event does not have stays empty.
 */
import Dexie from 'dexie';
import type { EagleEyeOfflineDB, LocalEventRecord } from '@/lib/offline/db';
import { activeShiftKey } from '@/lib/offline/db';
import type {
  CheckpointScanPayload,
  DroppableLink,
  EventLocation,
  GateEntryPayload,
  IncidentPayload,
  OfflineEventType,
  ShiftStartPayload,
  SyncState
} from '@/types/offline';
import type { GpsConfidence, GpsErrorKind, ScanMethod, ShiftType } from '@/types/models';
import type { TranslationKey } from '@/lib/i18n/translations';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import { formatDistance } from '@/lib/gps/haversine';

export type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;
export type Tone = 'success' | 'warning' | 'danger' | 'muted';

export type GuardEventsDb = Pick<EagleEyeOfflineDB, 'localEvents' | 'syncQueue' | 'guardState'>;

export type HistoryFilter = { kind: 'all' } | { kind: 'shift'; shiftId: string };

export interface GuardEventRow {
  event: LocalEventRecord;
  /** 'unknown' when this phone no longer has the queue item. */
  syncState: SyncState | 'unknown';
  lastError: string | null;
  droppedLinks: DroppableLink[];
}

export interface ShiftOption {
  shiftId: string;
  shiftType: ShiftType;
  startedAt: string;
  siteId: string;
  /** This is the shift currently open on this phone. */
  isOpen: boolean;
}

/** Records shown on the History page (newest first). */
export const HISTORY_LIMIT = 300;

export const EVENT_TYPE_KEYS: Record<OfflineEventType, TranslationKey> = {
  shift_start: 'authEventShiftStart',
  shift_end: 'authEventShiftEnd',
  checkpoint_scan: 'authEventCheckpointScan',
  incident: 'authEventIncident',
  gate_entry: 'authEventGateEntry',
  panic: 'authEventPanic'
};

const SHIFT_TYPE_KEYS: Record<ShiftType, TranslationKey> = {
  day: 'authShiftDay',
  night: 'authShiftNight',
  custom: 'authShiftCustom'
};

const METHOD_KEYS: Record<ScanMethod, TranslationKey> = {
  qr: 'authMethodQr',
  nfc: 'authMethodNfc',
  manual: 'authMethodManual'
};

const GPS_CONFIDENCE_KEYS: Record<GpsConfidence, TranslationKey> = {
  verified: 'authGpsVerified',
  likely: 'authGpsLikely',
  low_confidence: 'authGpsLowConfidence',
  outside: 'authGpsOutside',
  no_fix: 'authGpsNoFix',
  no_reference: 'authGpsNoReference'
};

const GPS_CONFIDENCE_TONES: Record<GpsConfidence, Tone> = {
  verified: 'success',
  likely: 'success',
  low_confidence: 'warning',
  outside: 'danger',
  no_fix: 'warning',
  no_reference: 'muted'
};

const GPS_ERROR_KEYS: Record<GpsErrorKind, TranslationKey> = {
  permission_denied: 'authGpsErrPermission',
  timeout: 'authGpsErrTimeout',
  unavailable: 'authGpsErrUnavailable',
  unsupported: 'authGpsErrUnsupported',
  insecure: 'authGpsErrInsecure',
  stale: 'authGpsErrStale'
};

/** Incident type codes used by the incident screen → existing labels. Unknown codes are shown as recorded. */
const INCIDENT_TYPE_KEYS: Record<string, TranslationKey> = {
  fence: 'incFence',
  gate: 'incGate',
  stock: 'incStock',
  person: 'incPerson',
  fire: 'incFire',
  theft: 'incTheft',
  medical: 'incMedical',
  other: 'incOther'
};

const SEVERITY_KEYS: Record<string, TranslationKey> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical'
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The user's clock-ins recorded on this phone, newest first. */
export async function loadGuardShifts(db: GuardEventsDb, userId: string, limit = 60): Promise<ShiftOption[]> {
  if (!userId) return [];
  const [starts, active] = await Promise.all([
    db.localEvents
      .where('[userId+type+sequenceNumber]')
      .between([userId, 'shift_start', Dexie.minKey], [userId, 'shift_start', Dexie.maxKey])
      .reverse()
      .limit(limit)
      .toArray(),
    db.guardState.get(activeShiftKey(userId))
  ]);
  const openShiftId = active && active.kind === 'activeShift' && active.userId === userId ? active.shiftId : null;
  return starts
    .filter((event) => event.userId === userId && event.type === 'shift_start')
    .map((event) => {
      const payload = event.payload as ShiftStartPayload;
      return {
        shiftId: payload.shiftId,
        shiftType: payload.shiftType,
        startedAt: event.createdAt,
        siteId: event.siteId,
        isOpen: payload.shiftId === openShiftId
      };
    });
}

/** Largest count IndexedDB accepts (getAll takes an unsigned long). */
const MAX_IDB_COUNT = 0xffffffff;

/**
 * This user's records on this phone (never another account's), newest first, with upload state.
 * `limit` Infinity (or any value IndexedDB cannot take) reads every record.
 */
export async function loadGuardEvents(
  db: GuardEventsDb,
  userId: string,
  filter: HistoryFilter,
  limit: number = HISTORY_LIMIT
): Promise<GuardEventRow[]> {
  if (!userId) return [];
  const bounded = Number.isInteger(limit) && limit >= 0 && limit <= MAX_IDB_COUNT;
  let events: LocalEventRecord[];
  if (filter.kind === 'shift') {
    const all = (await db.localEvents.where('shiftId').equals(filter.shiftId).toArray())
      .filter((event) => event.userId === userId)
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber);
    events = bounded ? all.slice(0, limit) : all;
  } else {
    const newestFirst = db.localEvents
      .where('[userId+sequenceNumber]')
      .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
      .reverse();
    events = await (bounded ? newestFirst.limit(limit) : newestFirst).toArray();
  }
  const items = await db.syncQueue.bulkGet(events.map((event) => event.id));
  return events.map((event, index) => {
    const item = items[index];
    const owned = item && item.userId === userId ? item : undefined;
    return {
      event,
      syncState: owned?.syncState ?? 'unknown',
      lastError: owned?.lastError ?? null,
      droppedLinks: owned?.droppedLinks ?? []
    };
  });
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function shiftTypeLabel(shiftType: ShiftType, t: Translate): string {
  return t(SHIFT_TYPE_KEYS[shiftType] ?? 'authShiftCustom');
}

export function shiftOptionLabel(option: ShiftOption, t: Translate): string {
  const base = `${shiftTypeLabel(option.shiftType, t)} · ${sastDateString(option.startedAt)} ${sastTimeHM(option.startedAt)}`;
  return option.isOpen ? t('authHistShiftOpen', base) : base;
}

export function syncStateView(state: GuardEventRow['syncState'], t: Translate): { tone: Tone; text: string } {
  switch (state) {
    case 'synced':
      return { tone: 'success', text: t('authSyncStateSynced') };
    case 'syncing':
      return { tone: 'warning', text: t('authSyncStateSyncing') };
    case 'pending':
      return { tone: 'warning', text: t('authSyncStatePending') };
    case 'failed':
      return { tone: 'danger', text: t('authSyncStateFailed') };
    default:
      return { tone: 'muted', text: t('authSyncStateUnknown') };
  }
}

/** Longest upload problem shown on screen / in the CSV (the full text stays in the queue item). */
export const SYNC_ERROR_MAX_LENGTH = 200;

/**
 * The readable part of an upload problem. A network failure reported by the database client
 * carries a JavaScript stack trace (" at e (https://…/chunks/….js:1:2)") and repeats its message
 * ("…: TypeError: Failed to fetch — TypeError: Failed to fetch"); a guard or supervisor only needs
 * the first sentence. Nothing is invented: the result is always a prefix/subset of the input.
 */
export function readableSyncError(message: string | null | undefined): string {
  if (typeof message !== 'string') return '';
  const firstLine = message.split(/\r?\n/)[0] ?? '';
  const withoutStack = firstLine.replace(/\s+at\s+(?:async\s+)?(?:\S+\s+)?\(?(?:https?|file|webpack|blob):\/\/.*$/i, '');
  const parts = withoutStack
    .split(' — ')
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = parts.filter((part, index) => !parts.slice(0, index).some((earlier) => earlier.endsWith(part)));
  const text = kept.join(' — ');
  return text.length > SYNC_ERROR_MAX_LENGTH ? `${text.slice(0, SYNC_ERROR_MAX_LENGTH - 1).trimEnd()}…` : text;
}

export interface EventLocationView {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  distanceMeters: number | null;
  confidence: GpsConfidence | null;
  gpsError: GpsErrorKind | null;
}

export function eventLocationView(event: LocalEventRecord): EventLocationView {
  const payload = event.payload as EventLocation & Partial<CheckpointScanPayload>;
  const latitude = isFiniteNumber(payload.latitude) ? payload.latitude : null;
  const longitude = isFiniteNumber(payload.longitude) ? payload.longitude : null;
  return {
    latitude,
    longitude,
    accuracyMeters: isFiniteNumber(payload.accuracyMeters) ? payload.accuracyMeters : null,
    distanceMeters:
      event.type === 'checkpoint_scan' && isFiniteNumber(payload.distanceToCheckpointMeters)
        ? payload.distanceToCheckpointMeters
        : null,
    confidence: event.type === 'checkpoint_scan' ? payload.gpsConfidence ?? null : null,
    gpsError: payload.gpsError ?? null
  };
}

/** One line about the phone's GPS for this record, or null when nothing was recorded either way. */
export function gpsSummary(event: LocalEventRecord, t: Translate): { tone: Tone; text: string } | null {
  const location = eventLocationView(event);
  const accuracy = location.accuracyMeters !== null ? t('authGpsAccuracy', Math.round(location.accuracyMeters)) : '';
  if (location.gpsError) {
    return { tone: 'warning', text: t('authGpsNone', t(GPS_ERROR_KEYS[location.gpsError])) };
  }
  if (location.confidence) {
    const parts = [t(GPS_CONFIDENCE_KEYS[location.confidence])];
    if (location.distanceMeters !== null) parts.push(t('authGpsDistance', formatDistance(location.distanceMeters)));
    if (accuracy) parts.push(accuracy);
    return { tone: GPS_CONFIDENCE_TONES[location.confidence], text: parts.join(' · ') };
  }
  if (location.latitude !== null && location.longitude !== null) {
    return { tone: 'muted', text: accuracy ? t('authGpsRecorded', accuracy) : t('authGpsRecordedNoAccuracy') };
  }
  return null;
}

export function describeGuardEvent(event: LocalEventRecord, t: Translate): { title: string; details: string[] } {
  const details: string[] = [];
  let title = t(EVENT_TYPE_KEYS[event.type]);
  switch (event.type) {
    case 'checkpoint_scan': {
      const payload = event.payload as CheckpointScanPayload;
      title = t('authHistScanOf', payload.checkpointName?.trim() || t('authHistUnnamedPoint'));
      const method = t(METHOD_KEYS[payload.method] ?? 'authMethodManual');
      details.push(payload.payloadType === 'legacy_qr' ? t('authHistLegacyCard', method) : method);
      break;
    }
    case 'shift_start': {
      const payload = event.payload as ShiftStartPayload;
      details.push(
        t(
          'authHistShiftPlanned',
          shiftTypeLabel(payload.shiftType, t),
          sastTimeHM(payload.scheduledStart),
          sastTimeHM(payload.scheduledEnd)
        )
      );
      break;
    }
    case 'incident': {
      const payload = event.payload as IncidentPayload;
      const typeKey = INCIDENT_TYPE_KEYS[payload.incidentType];
      title = t('authHistIncidentOf', typeKey ? t(typeKey) : payload.incidentType);
      const severityKey = SEVERITY_KEYS[payload.severity];
      if (severityKey) details.push(t('authHistSeverity', t(severityKey)));
      if (payload.description?.trim()) details.push(payload.description.trim());
      break;
    }
    case 'gate_entry': {
      const payload = event.payload as GateEntryPayload;
      title = t(payload.direction === 'out' ? 'authHistVehicleOut' : 'authHistVehicleIn', payload.licensePlate);
      const vehicle = [payload.makeModel, payload.vehicleColour].filter((part) => part && part.trim()).join(', ');
      if (vehicle) details.push(vehicle);
      if (payload.driverName?.trim()) details.push(t('authHistDriver', payload.driverName.trim()));
      break;
    }
    default:
      break;
  }
  if (event.mediaFields.length > 0) details.push(t('authHistWithPhoto', event.mediaFields.length));
  return { title, details };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: always quoted, quotes doubled. Text that a spreadsheet would run as a formula
 * (starting with = + - @ tab or CR) gets a leading apostrophe. Numbers are written as numbers
 * (0 stays 0; missing stays empty).
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? `"${value}"` : '""';
  let text = typeof value === 'boolean' ? String(value) : value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const CSV_HEADER_KEYS: TranslationKey[] = [
  'authCsvNr',
  'authCsvDate',
  'authCsvTime',
  'authCsvType',
  'authCsvDetails',
  'authCsvSite',
  'authCsvShift',
  'authCsvGps',
  'authCsvLatitude',
  'authCsvLongitude',
  'authCsvAccuracy',
  'authCsvDistance',
  'authCsvPhotos',
  'authCsvUpload',
  'authCsvUploadError',
  'authCsvRecordId',
  'authCsvHash'
];

/**
 * CSV of the given records (oldest first, as a log is read), with a UTF-8 byte-order mark so
 * spreadsheet programs show Afrikaans / isiZulu characters correctly. Times are SAST.
 */
export function buildGuardEventsCsv(
  rows: readonly GuardEventRow[],
  t: Translate,
  siteNames: Readonly<Record<string, string>> = {}
): string {
  const ordered = [...rows].sort((a, b) => a.event.sequenceNumber - b.event.sequenceNumber);
  const lines = [CSV_HEADER_KEYS.map((key) => csvCell(t(key))).join(',')];
  ordered.forEach((row, index) => {
    const { event } = row;
    const description = describeGuardEvent(event, t);
    const location = eventLocationView(event);
    const gps = gpsSummary(event, t);
    lines.push(
      [
        index + 1,
        sastDateString(event.createdAt),
        sastTimeHM(event.createdAt),
        description.title,
        description.details.join('; '),
        siteNames[event.siteId] ?? event.siteId,
        event.shiftId ?? '',
        gps?.text ?? '',
        location.latitude,
        location.longitude,
        location.accuracyMeters === null ? null : Math.round(location.accuracyMeters * 10) / 10,
        location.distanceMeters === null ? null : Math.round(location.distanceMeters * 10) / 10,
        event.mediaFields.length,
        syncStateView(row.syncState, t).text,
        readableSyncError(row.lastError),
        event.id,
        event.hash ?? ''
      ]
        .map(csvCell)
        .join(',')
    );
  });
  return `﻿${lines.join('\r\n')}\r\n`;
}
