'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { STALE_FIX_MS, getLocationFix, type LocationFixResult } from '@/lib/gps/location';
import { raceWithTimeout } from '@/lib/supabase/timeouts';

/** A fix obtained while the guard fills in the form is reused if it is at most this old. */
export const REUSE_FIX_MS = 60_000;
/** Saving never waits longer than this for GPS; the report is then saved with gpsError 'timeout'. */
export const SUBMIT_GPS_WAIT_MS = 8_000;

export interface IncidentLocationState {
  phase: 'locating' | 'done';
  result: LocationFixResult | null;
  /** Device time at which `result` arrived. */
  receivedAt: number | null;
}

const TIMED_OUT: LocationFixResult = { status: 'timeout', message: 'No GPS fix within the time limit.' };

/**
 * GPS for an incident report, without ever blocking the guard:
 * - a fix is requested as soon as the form opens (and answered instantly from the warm watch
 *   when a shift is running), so it is usually ready by the time the guard presses Save;
 * - on Save, a fix up to 60 s old is reused; otherwise a new one is awaited for at most 8 s;
 * - every failure keeps its kind (permission_denied, timeout, …) so it is recorded with the report.
 */
export function useIncidentLocation() {
  const [state, setState] = useState<IncidentLocationState>({ phase: 'locating', result: null, receivedAt: null });
  const latestRef = useRef<{ result: LocationFixResult; receivedAt: number } | null>(null);
  const pendingRef = useRef<Promise<LocationFixResult> | null>(null);
  const mountedRef = useRef(true);

  const start = useCallback((): Promise<LocationFixResult> => {
    if (pendingRef.current) return pendingRef.current;
    const request = getLocationFix({ maxAgeMs: 30_000, timeoutMs: 10_000 }).then((result) => {
      const receivedAt = Date.now();
      latestRef.current = { result, receivedAt };
      if (pendingRef.current === request) pendingRef.current = null;
      if (mountedRef.current) setState({ phase: 'done', result, receivedAt });
      return result;
    });
    pendingRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void start();
    return () => {
      mountedRef.current = false;
    };
  }, [start]);

  /** "Try GPS again" button. */
  const retry = useCallback(() => {
    setState((prev) => ({ ...prev, phase: 'locating' }));
    void start();
  }, [start]);

  /** The location to save with the report (never waits more than SUBMIT_GPS_WAIT_MS). */
  const locationForSubmit = useCallback(async (): Promise<{ result: LocationFixResult; receivedAt: number }> => {
    const latest = latestRef.current;
    const now = Date.now();
    if (latest && latest.result.status === 'ok' && latest.result.ageMs + (now - latest.receivedAt) <= REUSE_FIX_MS) {
      return latest;
    }
    const outcome = await raceWithTimeout(start(), SUBMIT_GPS_WAIT_MS);
    if (!outcome.timedOut) return { result: outcome.value, receivedAt: Date.now() };
    // Still no answer: keep an earlier fix that is not yet stale, else record the timeout.
    const after = Date.now();
    if (latest && latest.result.status === 'ok' && latest.result.ageMs + (after - latest.receivedAt) <= STALE_FIX_MS) {
      return latest;
    }
    return { result: TIMED_OUT, receivedAt: after };
  }, [start]);

  return { ...state, retry, locationForSubmit };
}
