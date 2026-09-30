import Dexie, { type DexieOptions, type Table } from 'dexie';
import type { DeviceStorageStatus, OfflineEventType, OfflinePayload, OfflineQueueItem } from '@/types/offline';
import type { Checkpoint, Shift, PatrolScan, Incident, GateEntry, ShiftType } from '@/types/models';

export const OFFLINE_DB_NAME = 'EagleEyeOfflineDB';

export interface StoredMediaBlob {
  /** `${queueItemId}-${field}` */
  id: string;
  queueItemId: string;
  field: string;
  data: Blob;
  mimeType: string;
  fileName: string;
  createdAt: string;
}

/** Offline copy of a site's checkpoint list (see src/lib/data/checkpoints.ts). */
export interface CheckpointCacheRecord {
  siteId: string;
  checkpoints: Checkpoint[];
  cachedAt: string;
}

/** The guard's open shift on this device. Exactly one per user (key `activeShift:<userId>`). */
export interface ActiveShiftRecord {
  kind: 'activeShift';
  key: string;
  userId: string;
  organisationId: string;
  siteId: string;
  /** Client-generated shift id: the server row id used by shift_start, shift_end and every scan. */
  shiftId: string;
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
  /** Device time of clock-in (= actual_start sent to the server). */
  startedAt: string;
  /** Queue/event id of the shift_start event. */
  startEventId: string;
  startLatitude: number | null;
  startLongitude: number | null;
  startAccuracyMeters: number | null;
}

/** When this user's queue last delivered an item to the server (key `lastSync:<userId>`). */
export interface LastSyncRecord {
  kind: 'lastSync';
  key: string;
  userId: string;
  at: string;
}

export type GuardStateRecord = ActiveShiftRecord | LastSyncRecord;

export const activeShiftKey = (userId: string): string => `activeShift:${userId}`;
export const lastSyncKey = (userId: string): string => `lastSync:${userId}`;

/**
 * Local copy of every event this device recorded (history, shift statistics, offline display).
 * Same id as the queue item and the server row. Its sync state lives in syncQueue.
 */
export interface LocalEventRecord {
  id: string;
  userId: string;
  organisationId: string;
  siteId: string;
  shiftId: string | null;
  type: OfflineEventType;
  sequenceNumber: number;
  createdAt: string;
  payload: OfflinePayload;
  mediaFields: string[];
  /** checkpoint_scan only: per-user SHA-256 chain. */
  prevHash?: string | null;
  hash?: string;
}

export const LEGACY_UNATTRIBUTED_ERROR =
  'Recorded by an earlier app version under a placeholder identity; it cannot be attributed to a real account and will not be sent. Kept on this device for audit.';

export class EagleEyeOfflineDB extends Dexie {
  syncQueue!: Table<OfflineQueueItem, string>;
  checkpoints!: Table<Checkpoint, string>;
  shifts!: Table<Shift, string>;
  scans!: Table<PatrolScan, string>;
  incidents!: Table<Incident, string>;
  gateEntries!: Table<GateEntry, string>;
  mediaBlobs!: Table<StoredMediaBlob, string>;
  guardState!: Table<GuardStateRecord, string>;
  checkpointCache!: Table<CheckpointCacheRecord, string>;
  localEvents!: Table<LocalEventRecord, string>;

  /** `options` lets tests pass a fake-indexeddb factory; the browser uses the defaults. */
  constructor(name: string = OFFLINE_DB_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt',
      checkpoints: 'id, siteId, qrCodeHash, nfcUid, isActive',
      shifts: 'id, siteId, guardId, status',
      scans: 'id, offlineUuid, shiftId, checkpointId, guardId, scanTimestampDevice',
      incidents: 'id, offlineUuid, siteId, shiftId, guardId, status',
      gateEntries: 'id, offlineUuid, siteId, direction, licensePlate, entryTime',
      mediaBlobs: 'id, queueItemId, field'
    });
    this.version(2)
      .stores({
        syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt, [userId+syncState]',
        guardState: 'key, userId, kind',
        checkpointCache: 'siteId',
        localEvents: 'id, userId, shiftId, type, createdAt, [userId+sequenceNumber], [userId+type+sequenceNumber]'
      })
      .upgrade(async (tx) => {
        // v1 items were written under hard-coded placeholder users and payload shapes the server
        // rejects. They are never deleted; they are marked so the UI can explain them truthfully.
        await tx
          .table('syncQueue')
          .toCollection()
          .modify((item: Partial<OfflineQueueItem>) => {
            if (typeof item.rejectionCount !== 'number') item.rejectionCount = 0;
            if (!Array.isArray(item.mediaFields)) item.mediaFields = [];
            if (!item.organisationId && item.syncState !== 'synced') {
              item.syncState = 'failed';
              item.lastError = LEGACY_UNATTRIBUTED_ERROR;
            }
          });
      });
    // v3: checkpoints carry SHA-256 fingerprints instead of the raw QR token / NFC serial (the
    // server no longer lets guards read those). Cached lists in the old shape hold secrets and
    // cannot be matched, so they are dropped; the next online load of the patrol screen fetches
    // them again. The legacy v1 `checkpoints` table (written by the old admin screen) is emptied
    // for the same reason and loses its secret indexes.
    this.version(3)
      .stores({
        checkpoints: 'id, siteId, isActive'
      })
      .upgrade(async (tx) => {
        await tx.table('checkpoints').clear();
        await tx.table('checkpointCache').clear();
      });
  }
}

/** Browser singleton (null during server rendering). */
export const offlineDB: EagleEyeOfflineDB | null = typeof window !== 'undefined' ? new EagleEyeOfflineDB() : null;

/** The parts of navigator.storage used here (injectable for tests). */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

const NEARLY_FULL_RATIO = 0.8;

function defaultStorageManager(): StorageManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { storage?: StorageManagerLike }).storage ?? null;
}

/**
 * Checks (and, with `requestPersistence`, asks for) persistent storage. Without it the browser
 * may evict IndexedDB — queued events and their photos — under storage pressure, and Safari
 * deletes data of sites that are not installed after 7 days without use. Chrome grants
 * persistence silently to installed PWAs; other browsers may ask the user or refuse.
 * Never throws.
 */
export async function checkDeviceStorage(
  options: { requestPersistence?: boolean; storage?: StorageManagerLike | null } = {}
): Promise<DeviceStorageStatus> {
  const storage = options.storage === undefined ? defaultStorageManager() : options.storage;
  let persisted: boolean | null = null;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    if (storage?.persisted) persisted = await storage.persisted();
    if (persisted !== true && options.requestPersistence && storage?.persist) persisted = await storage.persist();
  } catch {
    persisted = null;
  }
  try {
    const estimate = storage?.estimate ? await storage.estimate() : null;
    usageBytes = typeof estimate?.usage === 'number' ? estimate.usage : null;
    quotaBytes = typeof estimate?.quota === 'number' ? estimate.quota : null;
  } catch {
    usageBytes = null;
    quotaBytes = null;
  }
  const nearlyFull = usageBytes !== null && quotaBytes !== null && quotaBytes > 0 && usageBytes / quotaBytes > NEARLY_FULL_RATIO;
  return { persisted, usageBytes, quotaBytes, nearlyFull };
}
