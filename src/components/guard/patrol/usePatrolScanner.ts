'use client';

/**
 * The checkpoint scan pipeline shared by the QR and NFC paths:
 *   fresh active shift → resolveCheckpoint → 120 s duplicate check → GPS fix taken now →
 *   syncEngine.enqueue('checkpoint_scan', …) → result.
 *
 * Scans are processed one at a time in arrival order (an NFC tap while the previous scan is
 * still waiting for GPS is queued, never raced), and every step reads the latest inputs from a
 * ref, so no callback works on a stale checkpoint list, shift or GPS position.
 * Nothing is recorded for unknown / inactive / disabled codes or duplicates. Nothing here
 * claims "uploaded": the upload state is read from the sync queue by the caller.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveShift } from '@/lib/data/shiftStore';
import { parseCheckpointPayload, resolveCheckpoint } from '@/lib/data/checkpoints';
import { getLocationFix } from '@/lib/gps/location';
import { assessCheckpointProximity, type CheckpointProximityAssessment } from '@/lib/gps/haversine';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import { syncEngine } from '@/lib/offline/sync';
import type { Checkpoint, CheckpointPayloadType, GpsErrorKind } from '@/types/models';
import { buildCheckpointScanPayload, findRecentScan, type ShiftScan } from './patrolLogic';

export type ScanOutcome =
  | { kind: 'busy'; stage: 'checking' }
  | { kind: 'busy'; stage: 'gps'; checkpointName: string }
  | {
      kind: 'recorded';
      eventId: string;
      checkpointName: string;
      atMs: number;
      method: 'qr' | 'nfc';
      payloadType: CheckpointPayloadType;
      assessment: CheckpointProximityAssessment;
      gpsError: GpsErrorKind | null;
    }
  | { kind: 'duplicate'; checkpointName: string; lastAtMs: number }
  | { kind: 'rejected'; reason: 'unknown_tag' | 'legacy_disabled' }
  /** notCheckpointCard: the QR text is not an EE-CP / PLAAS-CP card at all (e.g. a web link). */
  | { kind: 'rejected'; reason: 'unknown_qr'; notCheckpointCard: boolean }
  | { kind: 'rejected'; reason: 'inactive'; checkpointName: string }
  | { kind: 'error'; reason: 'no_shift' | 'no_checkpoints' | 'crypto' }
  | { kind: 'error'; reason: 'save_failed'; message: string };

export interface PatrolScannerInput {
  userId: string;
  /** The site the checkpoint list below belongs to (must be the active shift's site). */
  checkpointsSiteId: string | null;
  /** null while the list is not loaded. */
  checkpoints: ReadonlyArray<Checkpoint> | null;
  /** Site.allowLegacyQr of the shift's site; false when the site is unknown. */
  allowLegacyQr: boolean;
  /** This shift's scans on this phone (for duplicate suppression). */
  scans: ReadonlyArray<ShiftScan>;
  /** Called after a scan was stored on the phone (refresh lists). */
  onRecorded: () => void;
  /** Called when the phone no longer has an active shift. */
  onShiftMissing: () => void;
}

export interface PatrolScanner {
  /** Latest outcome and a counter that changes with every new outcome (for re-announcing). */
  outcome: ScanOutcome | null;
  outcomeSeq: number;
  /**
   * raw: the text the checkpoint is identified by (QR text, or the normalised NFC serial).
   * rawPayload: exactly what was read, sent to the server (defaults to raw; NFC: serialRaw).
   */
  processScan: (method: 'qr' | 'nfc', raw: string, rawPayload?: string) => Promise<void>;
}

const VIBRATE_BAD = [90, 60, 90];

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Vibration is best effort.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function usePatrolScanner(input: PatrolScannerInput): PatrolScanner {
  const [state, setState] = useState<{ outcome: ScanOutcome | null; seq: number }>({ outcome: null, seq: 0 });
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  /** Scans stored in this session that the local list may not contain yet. */
  const recordedRef = useRef<Array<{ id: string; shiftId: string; checkpointId: string; atMs: number }>>([]);

  const show = useCallback((outcome: ScanOutcome) => {
    setState((prev) => ({ outcome, seq: prev.seq + 1 }));
  }, []);

  const runScan = useCallback(
    async (method: 'qr' | 'nfc', raw: string, rawPayload: string): Promise<void> => {
      show({ kind: 'busy', stage: 'checking' });
      const userId = inputRef.current.userId;

      // 1. The shift is read fresh for every scan: it is the only source of the shift id.
      let shift;
      try {
        shift = await getActiveShift(userId);
      } catch {
        shift = null;
      }
      if (!shift) {
        vibrate(VIBRATE_BAD);
        show({ kind: 'error', reason: 'no_shift' });
        inputRef.current.onShiftMissing();
        return;
      }

      const { checkpoints, checkpointsSiteId, allowLegacyQr } = inputRef.current;
      if (!checkpoints || checkpointsSiteId !== shift.siteId) {
        vibrate(VIBRATE_BAD);
        show({ kind: 'error', reason: 'no_checkpoints' });
        return;
      }

      // 2. Which checkpoint is this? (QR text only against QR tokens / legacy codes, NFC only against tags.)
      let resolved;
      try {
        resolved = await resolveCheckpoint({ method, raw }, checkpoints, { allowLegacyQr });
      } catch {
        // Web Crypto is missing (plain http): the code cannot be checked, so nothing is recorded.
        vibrate(VIBRATE_BAD);
        show({ kind: 'error', reason: 'crypto' });
        return;
      }
      if (!resolved.ok) {
        vibrate(VIBRATE_BAD);
        show(
          resolved.reason === 'inactive'
            ? { kind: 'rejected', reason: 'inactive', checkpointName: resolved.checkpoint.name }
            : resolved.reason === 'unknown_qr'
              ? { kind: 'rejected', reason: 'unknown_qr', notCheckpointCard: parseCheckpointPayload(raw).kind === 'unknown' }
              : { kind: 'rejected', reason: resolved.reason }
        );
        return;
      }
      const checkpoint = resolved.checkpoint;

      // 3. Same checkpoint within 120 s: not recorded again (reference behaviour).
      const shiftId = shift.shiftId;
      const known = inputRef.current.scans;
      const knownIds = new Set(known.map((scan) => scan.id));
      recordedRef.current = recordedRef.current.filter((scan) => scan.shiftId === shiftId && !knownIds.has(scan.id));
      const recent = findRecentScan([...known, ...recordedRef.current], checkpoint.id, Date.now());
      if (recent) {
        vibrate(120);
        show({ kind: 'duplicate', checkpointName: checkpoint.name, lastAtMs: recent.atMs });
        return;
      }

      // 4. Location at scan time (a warm watch answers at once; otherwise a fresh request).
      show({ kind: 'busy', stage: 'gps', checkpointName: checkpoint.name });
      const fix = await getLocationFix({ timeoutMs: 8000 });
      const location = eventLocationFromFix(fix);
      const assessment = assessCheckpointProximity(
        fix.status === 'ok' ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy } : null,
        checkpoint
      );

      // 5. Store on the phone (queued for upload). The payload carries exactly what was read.
      const payload = buildCheckpointScanPayload({
        shiftId,
        checkpoint,
        method,
        payloadType: resolved.payloadType,
        rawPayload,
        location,
        assessment
      });
      let eventId: string;
      try {
        if (!syncEngine) throw new Error('Offline storage is not available in this browser.');
        eventId = await syncEngine.enqueue(
          'checkpoint_scan',
          { userId, organisationId: shift.organisationId, siteId: shift.siteId },
          payload
        );
      } catch (error) {
        vibrate(VIBRATE_BAD);
        show({ kind: 'error', reason: 'save_failed', message: messageOf(error) });
        return;
      }
      const atMs = Date.now();
      recordedRef.current.push({ id: eventId, shiftId, checkpointId: checkpoint.id, atMs });
      vibrate(assessment.confidence === 'outside' ? [250, 100, 250] : 250);
      show({
        kind: 'recorded',
        eventId,
        checkpointName: checkpoint.name,
        atMs,
        method,
        payloadType: resolved.payloadType,
        assessment,
        gpsError: location.gpsError ?? null
      });
      inputRef.current.onRecorded();
    },
    [show]
  );

  const processScan = useCallback(
    (method: 'qr' | 'nfc', raw: string, rawPayload?: string): Promise<void> => {
      const next = chainRef.current
        .then(() => runScan(method, raw, rawPayload ?? raw))
        .catch((error: unknown) => {
          // Never leave the guard looking at "Checking…": an unexpected failure is shown as such.
          show({ kind: 'error', reason: 'save_failed', message: messageOf(error) });
        });
      chainRef.current = next;
      return next;
    },
    [runScan, show]
  );

  return { outcome: state.outcome, outcomeSeq: state.seq, processScan };
}
