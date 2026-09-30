'use client';

import { useEffect, useState } from 'react';
import { keepScreenAwake } from './wakeLock';

/**
 * Keeps the screen awake while `active` is true (an open shift), re-acquiring the wake lock
 * each time the guard returns to the app (see keepScreenAwake). Returns whether a lock is
 * currently held, so the UI can say "screen may sleep" truthfully when it is not.
 */
export function useKeepScreenAwake(active: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = keepScreenAwake({ onChange: setHeld });
    return () => {
      controller.stop();
      setHeld(false);
    };
  }, [active]);

  return active && held;
}
