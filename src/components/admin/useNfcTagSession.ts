'use client';

/**
 * One Web NFC session for the admin console: register a tag on a checkpoint ("enrol") or read a
 * tag and show which checkpoint it belongs to ("test").
 *
 * - start() calls startNfcScan synchronously, so it MUST be called from the click handler
 *   (Chrome needs the user gesture for the permission prompt).
 * - Exactly one session at a time; it stops on the first reading, on Cancel, after 60 s, and on
 *   unmount. Callbacks from an older session are ignored.
 * - The serial is only ever what the browser reported. An empty or malformed serial is an error;
 *   nothing is invented and nothing is written in that case.
 * - "Registered" is shown only when the database returned the row with this tag's fingerprint and
 *   its server enrolment time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getNfcSupport, startNfcScan, type NfcErrorKind, type NfcReading, type NfcScanSession, type NfcSupport } from '@/lib/nfc/webNfc';
import { resolveCheckpoint, type ResolveCheckpointResult } from '@/lib/data/checkpoints';
import type { Checkpoint } from '@/types/models';
import {
  enrolNfcTag,
  findCheckpointsByTag,
  moveNfcTag,
  toAdminError,
  type AdminDb,
  type AdminError,
  type TagHolder
} from './adminData';

export const NFC_SESSION_TIMEOUT_MS = 60_000;

export type NfcMode = 'enrol' | 'test';

export type NfcFailureReason = NfcErrorKind | 'timeout' | 'server';

export type NfcSessionState =
  | { phase: 'idle' }
  | { phase: 'unsupported'; mode: NfcMode; checkpoint?: Checkpoint; support: Exclude<NfcSupport, 'supported'> }
  | { phase: 'scanning'; mode: NfcMode; checkpoint?: Checkpoint; listening: boolean; readFailed: boolean }
  | { phase: 'saving'; mode: NfcMode; checkpoint?: Checkpoint; serial: string }
  | { phase: 'enrolled'; checkpoint: Checkpoint; serial: string; enrolledAt: string; releasedFrom?: Checkpoint }
  | { phase: 'duplicate'; checkpoint: Checkpoint; serial: string; holders: TagHolder[] | null; lookupError?: AdminError }
  | { phase: 'moving'; checkpoint: Checkpoint; serial: string }
  | {
      phase: 'tested';
      reading: NfcReading;
      holders: TagHolder[] | null;
      lookupError: AdminError | null;
      resolution: ResolveCheckpointResult | null;
    }
  | {
      phase: 'failed';
      mode: NfcMode;
      checkpoint?: Checkpoint;
      reason: NfcFailureReason;
      error?: AdminError;
      /** Move: the tag was released from this checkpoint but not registered on the target. */
      releasedFrom?: Checkpoint;
    };

export interface TestContext {
  /** The selected site's checkpoints, to show what the guard app would resolve. */
  siteCheckpoints: Checkpoint[];
  allowLegacyQr: boolean;
}

function getDb(): AdminDb | AdminError {
  try {
    return createClient();
  } catch (error) {
    return toAdminError(error);
  }
}

function isDb(value: AdminDb | AdminError): value is AdminDb {
  return typeof (value as AdminDb).from === 'function';
}

export function useNfcTagSession(onCheckpointStored: (checkpoint: Checkpoint) => void) {
  const [state, setState] = useState<NfcSessionState>({ phase: 'idle' });
  const sessionRef = useRef<NfcScanSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const storedRef = useRef(onCheckpointStored);

  useEffect(() => {
    storedRef.current = onCheckpointStored;
  });

  const halt = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const invalidate = useCallback(() => {
    seqRef.current += 1;
    halt();
  }, [halt]);

  useEffect(() => invalidate, [invalidate]);

  const saveTag = useCallback(async (seq: number, checkpoint: Checkpoint, reading: NfcReading) => {
    setState({ phase: 'saving', mode: 'enrol', checkpoint, serial: reading.serial });
    const db = getDb();
    if (!isDb(db)) {
      if (seq === seqRef.current) setState({ phase: 'failed', mode: 'enrol', checkpoint, reason: 'server', error: db });
      return;
    }
    const result = await enrolNfcTag(db, checkpoint.id, reading.serial);
    if (seq !== seqRef.current) return;
    if (result.ok) {
      storedRef.current(result.value.checkpoint);
      setState({ phase: 'enrolled', checkpoint: result.value.checkpoint, serial: result.value.serial, enrolledAt: result.value.enrolledAt });
      return;
    }
    if (result.error.problem === 'duplicate_tag' && result.error.kind === 'conflict') {
      setState({
        phase: 'duplicate',
        checkpoint,
        serial: reading.serial,
        holders: result.holders ?? null,
        lookupError: result.holders ? undefined : result.error
      });
      return;
    }
    const reason: NfcFailureReason = result.error.problem === 'invalid_tag_serial' ? 'invalid_serial' : 'server';
    setState({ phase: 'failed', mode: 'enrol', checkpoint, reason, error: result.error });
  }, []);

  const testTag = useCallback(async (seq: number, reading: NfcReading, context: TestContext) => {
    setState({ phase: 'saving', mode: 'test', serial: reading.serial });
    const db = getDb();
    let holders: TagHolder[] | null = null;
    let lookupError: AdminError | null = null;
    if (isDb(db)) {
      const lookup = await findCheckpointsByTag(db, reading.serial);
      if (lookup.ok) holders = lookup.value;
      else lookupError = lookup.error;
    } else {
      lookupError = db;
    }
    let resolution: ResolveCheckpointResult | null = null;
    try {
      resolution = await resolveCheckpoint({ method: 'nfc', raw: reading.serialRaw }, context.siteCheckpoints, {
        allowLegacyQr: context.allowLegacyQr
      });
    } catch {
      resolution = null;
    }
    if (seq !== seqRef.current) return;
    setState({ phase: 'tested', reading, holders, lookupError, resolution });
  }, []);

  /** Call directly from a click handler. */
  const start = useCallback(
    (mode: NfcMode, checkpoint?: Checkpoint, context?: TestContext) => {
      halt();
      const seq = ++seqRef.current;
      const support = getNfcSupport();
      if (support !== 'supported') {
        setState({ phase: 'unsupported', mode, checkpoint, support });
        return;
      }
      setState({ phase: 'scanning', mode, checkpoint, listening: false, readFailed: false });
      sessionRef.current = startNfcScan({
        onStarted: () => {
          if (seq !== seqRef.current) return;
          setState((current) => (current.phase === 'scanning' ? { ...current, listening: true } : current));
        },
        onReading: (reading) => {
          if (seq !== seqRef.current) return;
          halt();
          if (mode === 'enrol' && checkpoint) void saveTag(seq, checkpoint, reading);
          else void testTag(seq, reading, context ?? { siteCheckpoints: [], allowLegacyQr: false });
        },
        onError: (kind) => {
          if (seq !== seqRef.current) return;
          if (kind === 'read_failed') {
            // The session keeps listening: the tag was moved away too quickly.
            setState((current) => (current.phase === 'scanning' ? { ...current, readFailed: true } : current));
            return;
          }
          halt();
          if (kind === 'cancelled') {
            setState({ phase: 'idle' });
            return;
          }
          setState({ phase: 'failed', mode, checkpoint, reason: kind });
        }
      });
      timerRef.current = setTimeout(() => {
        if (seq !== seqRef.current) return;
        halt();
        setState({ phase: 'failed', mode, checkpoint, reason: 'timeout' });
      }, NFC_SESSION_TIMEOUT_MS);
    },
    [halt, saveTag, testTag]
  );

  /** Clears the tag from the checkpoint(s) holding it, then registers it on `checkpoint`. */
  const moveHere = useCallback(async (checkpoint: Checkpoint, serial: string, holders: TagHolder[]) => {
    const seq = ++seqRef.current;
    setState({ phase: 'moving', checkpoint, serial });
    const db = getDb();
    if (!isDb(db)) {
      setState({ phase: 'failed', mode: 'enrol', checkpoint, reason: 'server', error: db });
      return;
    }
    const result = await moveNfcTag(
      db,
      holders.map((holder) => holder.id),
      checkpoint.id,
      serial
    );
    if (seq !== seqRef.current) return;
    if (result.released) storedRef.current(result.released);
    if (result.ok) {
      storedRef.current(result.value.checkpoint);
      setState({
        phase: 'enrolled',
        checkpoint: result.value.checkpoint,
        serial: result.value.serial,
        enrolledAt: result.value.enrolledAt,
        releasedFrom: result.released
      });
      return;
    }
    setState({ phase: 'failed', mode: 'enrol', checkpoint, reason: 'server', error: result.error, releasedFrom: result.released });
  }, []);

  const close = useCallback(() => {
    invalidate();
    setState({ phase: 'idle' });
  }, [invalidate]);

  return { state, start, moveHere, close };
}
