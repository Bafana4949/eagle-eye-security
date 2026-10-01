'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { parsePatrolDevice, readPatrolDeviceRaw, subscribePatrolDevice, type PatrolDevice } from '@/lib/auth/patrolDevice';

/** The server (and the hydration pass) never sees localStorage: it renders "not enrolled". */
const serverSnapshot = (): string | null => null;
const clientSnapshot = (): string | null => readPatrolDeviceRaw();

/**
 * This phone's patrol-phone enrolment, kept in step with changes from this tab (save / clear)
 * and from other tabs. The raw stored string is the snapshot, so React sees a stable value.
 */
export function usePatrolDevice(): PatrolDevice | null {
  const raw = useSyncExternalStore(subscribePatrolDevice, clientSnapshot, serverSnapshot);
  return useMemo(() => parsePatrolDevice(raw), [raw]);
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** navigator.onLine (true on the server and during hydration). */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
    () => true
  );
}
