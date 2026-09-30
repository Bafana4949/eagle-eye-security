'use client';

import { useEffect, useState } from 'react';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import type { DroppableLink, SyncState } from '@/types/offline';

export interface QueuedEventStatus {
  /** false until the first read of this phone's queue has finished. */
  loaded: boolean;
  /** State reported by the sync engine; undefined when this phone has no such event. */
  syncState: SyncState | undefined;
  lastError: string | undefined;
  droppedLinks: DroppableLink[] | undefined;
  /** navigator.onLine as reported by the sync engine (a hint only). */
  isOnline: boolean;
}

const INITIAL: QueuedEventStatus = {
  loaded: false,
  syncState: undefined,
  lastError: undefined,
  droppedLinks: undefined,
  isOnline: true
};

/** Re-reads the queue this often as well, so a pass run by another tab is also noticed. */
const POLL_MS = 3000;

/**
 * Live upload status of one queued event (incident, panic, …).
 * The state comes from syncEngine.getSyncState(eventId); the last error and dropped links are read
 * from the same queue item. Nothing here assumes success: 'synced' is shown only when the engine
 * has marked the item synced after the server accepted it.
 */
export function useQueuedEventStatus(eventId: string | null): QueuedEventStatus {
  const [status, setStatus] = useState<QueuedEventStatus>(INITIAL);
  const [trackedId, setTrackedId] = useState<string | null>(eventId);

  // Reset when the tracked event changes (render-time adjustment, no effect needed).
  if (trackedId !== eventId) {
    setTrackedId(eventId);
    setStatus(INITIAL);
  }

  useEffect(() => {
    if (!eventId) return;
    const engine = syncEngine;
    let cancelled = false;
    let isOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      try {
        const [syncState, item] = await Promise.all([
          engine ? engine.getSyncState(eventId) : Promise.resolve(undefined),
          offlineDB ? offlineDB.syncQueue.get(eventId) : Promise.resolve(undefined)
        ]);
        if (cancelled) return;
        setStatus({
          loaded: true,
          syncState,
          lastError: item?.lastError,
          droppedLinks: item?.droppedLinks,
          isOnline
        });
        return syncState;
      } catch {
        if (!cancelled) setStatus((prev) => ({ ...prev, loaded: true, isOnline }));
        return undefined;
      }
    };

    const loop = async () => {
      const state = await read();
      // A synced record never changes again; everything else keeps being watched.
      if (!cancelled && state !== 'synced') timer = setTimeout(() => void loop(), POLL_MS);
    };
    void loop();

    const unsubscribe = engine?.subscribe((summary) => {
      isOnline = summary.isOnline;
      void read();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [eventId]);

  return eventId ? status : INITIAL;
}
