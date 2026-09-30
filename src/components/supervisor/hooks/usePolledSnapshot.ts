'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PolledSnapshot<T> {
  /** Last successfully loaded data for the current key (kept while a refresh fails). */
  data: T | null;
  /** Error of the most recent attempt (null after a success). */
  error: unknown;
  /** A request is in flight. */
  loading: boolean;
  /** Epoch ms of the last successful load for the current key. */
  lastSuccessAt: number | null;
  /** Starts a refresh now (coalesced with one already running). */
  refresh: () => void;
}

interface State<T> {
  key: string | null;
  data: T | null;
  error: unknown;
  loading: boolean;
  lastSuccessAt: number | null;
}

/**
 * Loads `load()` for `key`, then again every `intervalMs`, when the window regains focus, the
 * tab becomes visible or the connection comes back. Requests never overlap: a refresh asked for
 * while one is running runs once right after it. A failed refresh keeps the previous data and
 * reports the error, so the UI can say "showing data from HH:MM" instead of blanking or faking.
 * `key` null disables loading (e.g. no sites yet).
 */
export function usePolledSnapshot<T>(options: {
  key: string | null;
  load: () => Promise<T>;
  intervalMs: number;
}): PolledSnapshot<T> {
  const { key, load, intervalMs } = options;
  const [state, setState] = useState<State<T>>({ key: null, data: null, error: null, loading: false, lastSuccessAt: null });

  const loadRef = useRef(load);
  const keyRef = useRef(key);
  const inFlight = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    loadRef.current = load;
    keyRef.current = key;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const runKey = keyRef.current;
    if (runKey === null) return;
    inFlight.current = true;
    again.current = false;
    try {
      // Deferred so the state change never happens synchronously inside an effect.
      await Promise.resolve();
      if (!mounted.current) return;
      setState((prev) =>
        prev.key === runKey
          ? { ...prev, loading: true }
          : { key: runKey, data: null, error: null, loading: true, lastSuccessAt: null }
      );
      const data = await loadRef.current();
      if (mounted.current && keyRef.current === runKey) {
        setState({ key: runKey, data, error: null, loading: false, lastSuccessAt: Date.now() });
      }
    } catch (error) {
      if (mounted.current && keyRef.current === runKey) {
        setState((prev) => ({ ...prev, key: runKey, error, loading: false }));
      }
    } finally {
      inFlight.current = false;
      if (again.current && mounted.current) {
        again.current = false;
        void run();
      }
    }
  }, []);

  useEffect(() => {
    if (key === null) return;
    void run();
  }, [key, run]);

  useEffect(() => {
    if (key === null) return;
    const id = window.setInterval(() => void run(), intervalMs);
    return () => window.clearInterval(id);
  }, [key, intervalMs, run]);

  useEffect(() => {
    if (key === null) return;
    const onWake = () => void run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, run]);

  const refresh = useCallback(() => void run(), [run]);
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: current ? state.loading : key !== null,
    lastSuccessAt: current ? state.lastSuccessAt : null,
    refresh
  };
}
