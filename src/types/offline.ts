export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed';
export type OfflineEventType = 'shift_start' | 'shift_end' | 'checkpoint_scan' | 'incident' | 'gate_entry' | 'panic';

export interface OfflineQueueItem {
  id: string; // Client UUID
  sequenceNumber: number;
  userId: string;
  siteId: string;
  eventType: OfflineEventType;
  payload: Record<string, unknown>;
  mediaBlobs?: {
    field: string;
    blob: Blob | string; // base64 or Blob
    fileName: string;
    mimeType: string;
  }[];
  deviceTimestamp: string;
  syncState: SyncState;
  retryCount: number;
  lastError?: string;
  createdAt: string;
  syncedAt?: string;
}

export interface OfflineSyncSummary {
  isOnline: boolean;
  pendingCount: number;
  syncingCount: number;
  failedCount: number;
  lastSyncTimestamp?: string;
}
