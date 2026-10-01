'use client';

/**
 * What is waiting on THIS phone, read from the offline database (no network needed):
 * - records (sync queue items) not yet on the server, per person - on a shared patrol phone a
 *   person's records upload only when that person signs in on this phone again, and the server
 *   refuses evidence older than 7 days, so the phone must show whose records are waiting;
 * - the open shift of a person (clocked in on this phone and not clocked out).
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import { offlineDB, type ActiveShiftRecord } from '@/lib/offline/db';
import { getActiveShift } from '@/lib/data/shiftStore';
import { countQueuedByUser, type QueuedCounts } from './devicesData';

/** Queue states that are not on the server yet (same as the sync engine's "unsynced"). */
const UNSYNCED_STATES: readonly string[] = ['pending', 'syncing', 'failed'];

export interface QueuedRecords extends QueuedCounts {
  /** false until the first answer from the offline database. */
  ready: boolean;
}

const EMPTY: QueuedRecords = { byUser: {}, total: 0, ready: false };

/** Live counts of this phone's unsynced records, per person. */
export function useQueuedRecords(): QueuedRecords {
  const [state, setState] = useState<QueuedRecords>(EMPTY);
  useEffect(() => {
    const db = offlineDB;
    if (!db) return;
    const subscription = liveQuery(async () => {
      // Index keys only ([userId, syncState]) - the queued records themselves (photos) are not loaded.
      const keys = (await db.syncQueue.orderBy('[userId+syncState]').keys()) as unknown as Array<[string, string]>;
      return countQueuedByUser(keys.filter((key) => Array.isArray(key) && UNSYNCED_STATES.includes(key[1])).map((key) => key[0]));
    }).subscribe({
      next: (counts) => setState({ ...counts, ready: true }),
      error: () => setState({ ...EMPTY, ready: true })
    });
    return () => subscription.unsubscribe();
  }, []);
  return state;
}

/** The open shift of `userId` on this phone (null: none / unknown user; undefined while loading). */
export function useOpenShift(userId: string | null): ActiveShiftRecord | null | undefined {
  const [state, setState] = useState<{ userId: string | null; record: ActiveShiftRecord | null | undefined }>({
    userId: null,
    record: undefined
  });
  useEffect(() => {
    if (!userId || !offlineDB) return;
    const subscription = liveQuery(() => getActiveShift(userId)).subscribe({
      next: (record) => setState({ userId, record }),
      error: () => setState({ userId, record: null })
    });
    return () => subscription.unsubscribe();
  }, [userId]);
  return useMemo(() => {
    if (!userId || !offlineDB) return null;
    return state.userId === userId ? state.record : undefined;
  }, [userId, state]);
}
