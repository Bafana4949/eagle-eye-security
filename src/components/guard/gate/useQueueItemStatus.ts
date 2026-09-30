'use client';

import { useEffect, useState } from 'react';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import type { OfflineSyncSummary, SyncState } from '@/types/offline';

export interface QueueItemStatus {
  /** Upload state of the event; null until it has been read from this phone's queue. */
  state: SyncState | null;
  /** The server's or network's last answer for this event (English, from the sync engine). */
  lastError: string | null;
  isOnline: boolean;
  isSyncing: boolean;
}

interface Tracked extends QueueItemStatus {
  eventId: string | null;
}

const UNKNOWN: QueueItemStatus = { state: null, lastError: null, isOnline: true, isSyncing: false };

/**
 * Live upload state of one queued event, read from the sync queue whenever the sync engine
 * reports a change. "Received by server" may only be shown when `state === 'synced'`.
 */
export function useQueueItemStatus(eventId: string | null): QueueItemStatus {
  const [tracked, setTracked] = useState<Tracked>({ eventId: null, ...UNKNOWN });

  useEffect(() => {
    if (!eventId || !offlineDB) return;
    const db = offlineDB;
    let cancelled = false;
    const refresh = async (summary?: OfflineSyncSummary) => {
      try {
        const item = await db.syncQueue.get(eventId);
        if (cancelled) return;
        setTracked({
          eventId,
          state: item?.syncState ?? null,
          lastError: item?.lastError ?? null,
          isOnline: summary?.isOnline ?? (typeof navigator === 'undefined' || navigator.onLine !== false),
          isSyncing: summary?.isSyncing ?? false
        });
      } catch {
        // IndexedDB read failed: keep the last known state rather than guessing.
      }
    };
    const unsubscribe = syncEngine?.subscribe((summary) => void refresh(summary));
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [eventId]);

  return tracked.eventId === eventId && eventId ? tracked : UNKNOWN;
}
