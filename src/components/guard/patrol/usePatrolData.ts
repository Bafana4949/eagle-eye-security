'use client';

/**
 * Data hooks for the patrol screen. Everything comes from the real stores:
 * - the active shift from shiftStore (Dexie guardState), re-read when the guard returns to the app;
 * - the site's checkpoints from loadCheckpoints (network, falling back to this phone's copy);
 * - this shift's scans from the local event log plus their sync-queue state, refreshed whenever
 *   the sync engine reports progress.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveShift, type ActiveShiftRecord } from '@/lib/data/shiftStore';
import { CheckpointLoadError, loadCheckpoints, type LoadCheckpointsResult } from '@/lib/data/checkpoints';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { shiftScanFromLocalEvent, type ShiftScan } from './patrolLogic';

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Active shift
// ---------------------------------------------------------------------------

export type ActiveShiftState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'active'; shift: ActiveShiftRecord }
  | { status: 'error'; message: string };

/**
 * The guard's running shift on this phone (shiftStore is the ONLY source of the shift id).
 * Re-read whenever the guard comes back to the app, because the shift may have been ended on
 * the Home screen in another tab.
 */
export function useActiveShift(userId: string | null): {
  state: ActiveShiftState;
  refresh: () => Promise<ActiveShiftRecord | null>;
} {
  const [state, setState] = useState<{ userId: string | null; value: ActiveShiftState }>({
    userId: null,
    value: { status: 'loading' }
  });
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<ActiveShiftRecord | null> => {
    const request = ++requestRef.current;
    if (!userId) return null;
    let shift: ActiveShiftRecord | null = null;
    let value: ActiveShiftState;
    try {
      shift = await getActiveShift(userId);
      value = shift ? { status: 'active', shift } : { status: 'none' };
    } catch (error) {
      value = { status: 'error', message: messageOf(error) };
    }
    if (request === requestRef.current) setState({ userId, value });
    return shift;
  }, [userId]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  // A result for another user (account switch) is never shown.
  const value: ActiveShiftState = state.userId === userId ? state.value : { status: 'loading' };
  return { state: value, refresh };
}

// ---------------------------------------------------------------------------
// Checkpoints of the shift's site
// ---------------------------------------------------------------------------

export type CheckpointsState =
  | { status: 'loading' }
  | { status: 'ready'; result: LoadCheckpointsResult }
  | {
      status: 'error';
      reason: 'offline_no_cache' | 'network_error_no_cache' | 'unexpected';
      message: string;
    };

/**
 * Loads the site's checkpoints (Supabase, else this phone's cached copy) and reloads them when
 * the phone comes back online while showing a cached copy or an error.
 */
export function useSiteCheckpoints(siteId: string | null): { state: CheckpointsState; reload: () => void } {
  const [state, setState] = useState<{ siteId: string | null; value: CheckpointsState }>({
    siteId: null,
    value: { status: 'loading' }
  });
  const requestRef = useRef(0);
  const latestRef = useRef<CheckpointsState>({ status: 'loading' });

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (!siteId) return;
    let value: CheckpointsState;
    try {
      const result = await loadCheckpoints(siteId, { cache: offlineDB?.checkpointCache ?? null });
      value = { status: 'ready', result };
    } catch (error) {
      value =
        error instanceof CheckpointLoadError
          ? { status: 'error', reason: error.reason, message: error.message }
          : { status: 'error', reason: 'unexpected', message: messageOf(error) };
    }
    if (request !== requestRef.current) return;
    latestRef.current = value;
    setState({ siteId, value });
  }, [siteId]);

  useEffect(() => {
    void load();
    const onOnline = () => {
      const current = latestRef.current;
      if (current.status === 'error' || (current.status === 'ready' && current.result.source === 'cache')) void load();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [load]);

  /** For the "Try again" button (an event handler, so the loading state may be set here). */
  const reload = useCallback(() => {
    setState({ siteId, value: { status: 'loading' } });
    void load();
  }, [load, siteId]);

  const value: CheckpointsState = state.siteId === siteId ? state.value : { status: 'loading' };
  return { state: value, reload };
}

// ---------------------------------------------------------------------------
// Scans of the active shift (local event log + upload state)
// ---------------------------------------------------------------------------

async function readShiftScans(userId: string, shiftId: string): Promise<ShiftScan[]> {
  const db = offlineDB;
  if (!db) return [];
  const events = (await db.localEvents.where('shiftId').equals(shiftId).toArray()).filter(
    (event) => event.userId === userId && event.type === 'checkpoint_scan'
  );
  events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const queueItems = events.length > 0 ? await db.syncQueue.bulkGet(events.map((event) => event.id)) : [];
  const scans: ShiftScan[] = [];
  events.forEach((event, index) => {
    const queued = queueItems[index];
    const scan = shiftScanFromLocalEvent(
      event,
      queued ? { syncState: queued.syncState, lastError: queued.lastError ?? null } : null
    );
    if (scan) scans.push(scan);
  });
  return scans;
}

/**
 * This shift's checkpoint scans recorded on this phone, oldest first, with their current upload
 * state. Refreshed after every sync-engine notification (each delivered item notifies).
 */
export function useShiftScans(
  userId: string | null,
  shiftId: string | null
): { scans: ShiftScan[]; loaded: boolean; error: string | null; refresh: () => Promise<void> } {
  const [state, setState] = useState<{ key: string | null; scans: ShiftScan[]; error: string | null }>({
    key: null,
    scans: [],
    error: null
  });
  const key = userId && shiftId ? `${userId}:${shiftId}` : null;
  const inFlightRef = useRef<Promise<void> | null>(null);
  const rerunRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !shiftId) return;
    if (inFlightRef.current) {
      // Coalesce bursts of notifications into one extra read.
      rerunRef.current = true;
      return inFlightRef.current;
    }
    const run = (async () => {
      do {
        rerunRef.current = false;
        try {
          const scans = await readShiftScans(userId, shiftId);
          setState({ key: `${userId}:${shiftId}`, scans, error: null });
        } catch (error) {
          setState((prev) => ({ key: `${userId}:${shiftId}`, scans: prev.scans, error: messageOf(error) }));
        }
      } while (rerunRef.current);
    })();
    inFlightRef.current = run;
    try {
      await run;
    } finally {
      inFlightRef.current = null;
    }
  }, [userId, shiftId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = syncEngine?.subscribe(() => void refresh());
    return () => unsubscribe?.();
  }, [refresh]);

  const current = state.key === key ? state : null;
  return { scans: current?.scans ?? [], loaded: current !== null, error: current?.error ?? null, refresh };
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Current time, updated every `intervalMs` (null until mounted, so server and client render alike). */
export function useClock(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const kick = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}
