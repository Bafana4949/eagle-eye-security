'use client';

import { useEffect, useState } from 'react';
import { startLocationWatch, type LocationFailureStatus, type LocationFixResult } from './location';

export interface LocationWatchState {
  /** Latest watched fix (null until the first one arrives). */
  fix: LocationFixResult | null;
  /** Latest watch error; cleared by the next fix. */
  error: { status: LocationFailureStatus; message: string } | null;
}

const IDLE: LocationWatchState = { fix: null, error: null };

/**
 * Keeps a warm high-accuracy GPS watch while `active` is true (the guard has an open shift),
 * like the reference app. getLocationFix() then answers checkpoint scans and other events
 * instantly from the latest fix instead of cold-starting GNSS for every scan.
 * Stops the watch when `active` turns false or the component unmounts.
 */
export function useLocationWatch(active: boolean): LocationWatchState {
  const [state, setState] = useState<LocationWatchState>(IDLE);

  useEffect(() => {
    if (!active) return;
    const handle = startLocationWatch({
      onFix: (fix) => setState({ fix, error: null }),
      onError: (status, message) => setState((prev) => ({ fix: prev.fix, error: { status, message } }))
    });
    return () => {
      handle.stop();
      setState(IDLE);
    };
  }, [active]);

  return active ? state : IDLE;
}
