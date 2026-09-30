/**
 * Patrol screen logic without React, so it can be unit-tested by importing it.
 *
 * - Duplicate suppression: the same checkpoint scanned again within 120 s is not recorded
 *   (Dawie's reference app: `if (last && Date.now() - last.ts < 120000) return toast(justScanned)`).
 * - Round progress: rounds are aligned to the active shift's SCHEDULED start and the site's
 *   round interval (same rule as the patrol alarm and the shift summary).
 * - Scan payload: built only from the real active shift, the resolved checkpoint, exactly what
 *   was read, and the location fix taken at scan time. The GPS verdict here is the phone's
 *   estimate; the patrol_scans trigger recomputes it on the server.
 */
import type { LocalEventRecord } from '@/lib/offline/db';
import type { CheckpointProximityAssessment } from '@/lib/gps/haversine';
import { generateShiftRounds } from '@/features/shifts/shiftCalculator';
import type {
  Checkpoint,
  CheckpointPayloadType,
  GpsConfidence,
  GpsErrorKind,
  ScanMethod
} from '@/types/models';
import type { CheckpointScanPayload, EventLocation, SyncState } from '@/types/offline';

/** Same checkpoint again within this window is "already scanned" (reference app: 120 s). */
export const DUPLICATE_SCAN_WINDOW_MS = 120_000;

/** One checkpoint scan of the active shift as recorded on this phone, plus its upload state. */
export interface ShiftScan {
  /** Event id (= queue item id = server row id). */
  id: string;
  checkpointId: string;
  checkpointName: string | null;
  /** Device time the scan was recorded (epoch ms). */
  atMs: number;
  method: ScanMethod;
  payloadType: CheckpointPayloadType | null;
  gpsConfidence: GpsConfidence | null;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  gpsError: GpsErrorKind | null;
  /** Upload state from the sync queue; 'unknown' when this phone has no queue item for it. */
  syncState: SyncState | 'unknown';
  lastError: string | null;
}

export interface QueueStateLike {
  syncState: SyncState;
  lastError?: string | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Converts a local event record into a ShiftScan; null for other event types or broken rows. */
export function shiftScanFromLocalEvent(event: LocalEventRecord, queueItem?: QueueStateLike | null): ShiftScan | null {
  if (event.type !== 'checkpoint_scan') return null;
  const payload = event.payload as CheckpointScanPayload;
  const atMs = Date.parse(event.createdAt);
  if (!payload || typeof payload.checkpointId !== 'string' || !Number.isFinite(atMs)) return null;
  return {
    id: event.id,
    checkpointId: payload.checkpointId,
    checkpointName: typeof payload.checkpointName === 'string' ? payload.checkpointName : null,
    atMs,
    method: payload.method,
    payloadType: payload.payloadType ?? null,
    gpsConfidence: payload.gpsConfidence ?? null,
    distanceMeters: finiteOrNull(payload.distanceToCheckpointMeters),
    accuracyMeters: finiteOrNull(payload.accuracyMeters),
    gpsError: payload.gpsError ?? null,
    syncState: queueItem?.syncState ?? 'unknown',
    lastError: queueItem?.lastError ?? null
  };
}

/**
 * The most recent scan of `checkpointId` that is less than `windowMs` old at `nowMs`, or null.
 * Like the reference app, a scan with a device time AFTER now (clock stepped back) also counts
 * as recent, so a clock change cannot be used to record the same point twice in a row.
 */
export function findRecentScan<T extends { checkpointId: string; atMs: number }>(
  scans: ReadonlyArray<T>,
  checkpointId: string,
  nowMs: number,
  windowMs: number = DUPLICATE_SCAN_WINDOW_MS
): T | null {
  let latest: T | null = null;
  for (const scan of scans) {
    if (scan.checkpointId !== checkpointId) continue;
    if (!latest || scan.atMs > latest.atMs) latest = scan;
  }
  if (!latest) return null;
  return nowMs - latest.atMs < windowMs ? latest : null;
}

/** Active checkpoints in patrol order (order_index, then name). Inactive points are not part of rounds. */
export function patrolCheckpoints(checkpoints: ReadonlyArray<Checkpoint>): Checkpoint[] {
  return checkpoints
    .filter((cp) => cp.isActive)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name));
}

export interface RoundItem {
  checkpoint: Checkpoint;
  /** Earliest scan of this checkpoint inside the round window, or null (not yet). */
  scannedAtMs: number | null;
}

export type RoundProgress =
  | { kind: 'config_error'; message: string }
  | { kind: 'before_start'; startMs: number }
  | { kind: 'after_end'; endMs: number }
  | {
      kind: 'in_round';
      roundNumber: number;
      totalRounds: number;
      windowStart: number;
      windowEnd: number;
      items: RoundItem[];
      doneCount: number;
    };

export interface RoundProgressInput {
  scheduledStartMs: number;
  scheduledEndMs: number;
  roundIntervalMinutes: number;
  checkpoints: ReadonlyArray<Checkpoint>;
  scans: ReadonlyArray<{ checkpointId: string; atMs: number }>;
  nowMs: number;
}

/**
 * Which round of the active shift is running now and which active checkpoints were scanned in
 * it. Invalid schedules or intervals are reported (config_error), never hidden.
 */
export function computeRoundProgress(input: RoundProgressInput): RoundProgress {
  const { scheduledStartMs, scheduledEndMs, roundIntervalMinutes, nowMs } = input;
  let rounds;
  try {
    rounds = generateShiftRounds(
      { startTime: scheduledStartMs, endTime: scheduledEndMs, roundIntervalMinutes },
      nowMs
    );
  } catch (error) {
    return { kind: 'config_error', message: error instanceof Error ? error.message : String(error) };
  }
  if (nowMs < scheduledStartMs) return { kind: 'before_start', startMs: scheduledStartMs };
  const current = rounds.find((round) => round.isCurrent);
  if (!current) return { kind: 'after_end', endMs: scheduledEndMs };

  const items: RoundItem[] = patrolCheckpoints(input.checkpoints).map((checkpoint) => {
    let scannedAtMs: number | null = null;
    for (const scan of input.scans) {
      if (scan.checkpointId !== checkpoint.id) continue;
      if (scan.atMs < current.windowStart || scan.atMs >= current.windowEnd) continue;
      if (scannedAtMs === null || scan.atMs < scannedAtMs) scannedAtMs = scan.atMs;
    }
    return { checkpoint, scannedAtMs };
  });
  return {
    kind: 'in_round',
    roundNumber: current.roundNumber,
    totalRounds: rounds.length,
    windowStart: current.windowStart,
    windowEnd: current.windowEnd,
    items,
    doneCount: items.filter((item) => item.scannedAtMs !== null).length
  };
}

export interface ScanPayloadInput {
  /** From shiftStore.getActiveShift(userId).shiftId — never generated here. */
  shiftId: string;
  checkpoint: Pick<Checkpoint, 'id' | 'name'>;
  method: Extract<ScanMethod, 'qr' | 'nfc'>;
  payloadType: CheckpointPayloadType;
  /** Exactly what was read: the QR text, or the NFC serial as the browser reported it. */
  rawPayload: string;
  location: EventLocation;
  assessment: CheckpointProximityAssessment;
}

/** The checkpoint_scan payload queued with syncEngine.enqueue(). */
export function buildCheckpointScanPayload(input: ScanPayloadInput): CheckpointScanPayload {
  return {
    shiftId: input.shiftId,
    checkpointId: input.checkpoint.id,
    checkpointName: input.checkpoint.name,
    method: input.method,
    payloadType: input.payloadType,
    rawPayload: input.rawPayload,
    ...input.location,
    // Advisory only: the patrol_scans trigger recomputes these on the server.
    distanceToCheckpointMeters: input.assessment.distanceMeters,
    gpsConfidence: input.assessment.confidence,
    isValidProximity: input.assessment.isValidProximity
  };
}

export type Tone = 'success' | 'success-soft' | 'warning' | 'danger' | 'muted';

/** Colour tone for a GPS verdict. Only 'verified' and 'likely' are green. */
export function confidenceTone(confidence: GpsConfidence | null): Tone {
  switch (confidence) {
    case 'verified':
      return 'success';
    case 'likely':
      return 'success-soft';
    case 'low_confidence':
    case 'no_fix':
      return 'warning';
    case 'outside':
      return 'danger';
    default:
      return 'muted';
  }
}

/** Colour tone for an upload state. Only a synced item is green. */
export function syncTone(state: SyncState | 'unknown'): Tone {
  if (state === 'synced') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'unknown') return 'muted';
  return 'warning';
}

/** Tailwind text colour class for a tone (theme tokens only). */
export function toneTextClass(tone: Tone): string {
  switch (tone) {
    case 'success':
      return 'text-ee-success';
    case 'success-soft':
      return 'text-ee-success/80';
    case 'warning':
      return 'text-ee-warning';
    case 'danger':
      return 'text-ee-danger';
    default:
      return 'text-ee-muted';
  }
}

/** Splits an age into the unit shown to the guard ("just now", minutes, hours, days). */
export function ageParts(ageMs: number): { unit: 'now' | 'min' | 'h' | 'days'; value: number } {
  const ms = Math.max(0, ageMs);
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return { unit: 'now', value: 0 };
  if (minutes < 60) return { unit: 'min', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: 'h', value: hours };
  return { unit: 'days', value: Math.floor(hours / 24) };
}

/** Whole hours and minutes of a duration (rounded to the minute). */
export function durationParts(durationMs: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(durationMs / 60000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
