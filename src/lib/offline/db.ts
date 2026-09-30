import Dexie, { type Table } from 'dexie';
import { OfflineQueueItem } from '@/types/offline';
import { Checkpoint, Shift, PatrolScan, Incident, GateEntry } from '@/types/models';

export interface StoredMediaBlob {
  id: string; // matches event UUID or media identifier
  queueItemId: string;
  field: string;
  data: Blob;
  mimeType: string;
  fileName: string;
  createdAt: string;
}

export class EagleEyeOfflineDB extends Dexie {
  syncQueue!: Table<OfflineQueueItem, string>;
  checkpoints!: Table<Checkpoint, string>;
  shifts!: Table<Shift, string>;
  scans!: Table<PatrolScan, string>;
  incidents!: Table<Incident, string>;
  gateEntries!: Table<GateEntry, string>;
  mediaBlobs!: Table<StoredMediaBlob, string>;

  constructor() {
    super('EagleEyeOfflineDB');
    this.version(1).stores({
      syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt',
      checkpoints: 'id, siteId, qrCodeHash, nfcUid, isActive',
      shifts: 'id, siteId, guardId, status',
      scans: 'id, offlineUuid, shiftId, checkpointId, guardId, scanTimestampDevice',
      incidents: 'id, offlineUuid, siteId, shiftId, guardId, status',
      gateEntries: 'id, offlineUuid, siteId, direction, licensePlate, entryTime',
      mediaBlobs: 'id, queueItemId, field'
    });
  }
}

// Global singleton instance for browser runtime
export const offlineDB = typeof window !== 'undefined' ? new EagleEyeOfflineDB() : (null as unknown as EagleEyeOfflineDB);
