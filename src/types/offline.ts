import type {
  CheckpointPayloadType,
  GpsConfidence,
  GpsErrorKind,
  IncidentSeverity,
  ScanMethod,
  ShiftType,
  VehicleDirection
} from './models';

export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed';
export type OfflineEventType = 'shift_start' | 'shift_end' | 'checkpoint_scan' | 'incident' | 'gate_entry' | 'panic';

/** Who recorded an event and where. Always taken from the signed-in profile / active site, never hard-coded. */
export interface EventContext {
  userId: string;
  organisationId: string;
  siteId: string;
}

/**
 * Location captured with an event. Coordinates are null when there was no usable fix;
 * `gpsError` then says why (permission_denied, timeout, unavailable, unsupported, insecure, stale).
 */
export interface EventLocation {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  /** ISO time of the GPS fix itself (a cached fix can be older than the event). */
  locationTimestamp?: string | null;
  gpsError?: GpsErrorKind | null;
}

/** Clock-in. `shiftId` is generated on the device and reused by shift_end and every scan of the shift. */
export interface ShiftStartPayload extends EventLocation {
  shiftId: string;
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
}

/** Clock-out of the shift started with the same `shiftId`. */
export interface ShiftEndPayload extends EventLocation {
  shiftId: string;
}

export interface CheckpointScanPayload extends EventLocation {
  /** The real active shift (from shiftStore.getActiveShift), never a random id. */
  shiftId: string;
  checkpointId: string;
  /** Local display only; not sent to the server. */
  checkpointName?: string;
  method: ScanMethod;
  payloadType: CheckpointPayloadType;
  /**
   * Exactly what was read: the QR text (secure token or 'PLAAS-CP:<code>') or the NFC serial.
   * The patrol_scans trigger compares it with the checkpoint and stores the verdict in
   * payload_verified; a scan without it is recorded as unverified.
   */
  rawPayload?: string | null;
  patrolRoundId?: string | null;
  /**
   * Advisory client-side proximity values for local display. They are sent, but the
   * patrol_scans BEFORE INSERT trigger recomputes and overwrites them server-side.
   */
  distanceToCheckpointMeters?: number | null;
  gpsConfidence?: GpsConfidence | null;
  isValidProximity?: boolean | null;
  /** Set by syncEngine.enqueue (per-user SHA-256 chain). Callers must not supply these. */
  prevHashChain?: string | null;
  hashChain?: string;
}

export interface IncidentPayload extends EventLocation {
  shiftId: string | null;
  incidentType: string;
  severity: IncidentSeverity;
  description: string;
}

export interface GateEntryPayload extends EventLocation {
  shiftId: string | null;
  direction: VehicleDirection;
  licensePlate: string;
  makeModel?: string | null;
  vehicleColour?: string | null;
  /** YYYY-MM-DD */
  discExpiryDate?: string | null;
  vinNumber?: string | null;
  engineNumber?: string | null;
  registerNumber?: string | null;
  vehicleDescription?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  company?: string | null;
  visitReason?: string | null;
  personVisited?: string | null;
  isDiscScanned: boolean;
  entryTime: string;
  exitTime?: string | null;
  dwellDurationSeconds?: number | null;
  /** OUT rows: the event id returned by enqueue() for the matching IN row (it is also its server id). */
  linkedEntryId?: string | null;
}

export interface PanicPayload extends EventLocation {
  shiftId: string | null;
}

export interface OfflinePayloadMap {
  shift_start: ShiftStartPayload;
  shift_end: ShiftEndPayload;
  checkpoint_scan: CheckpointScanPayload;
  incident: IncidentPayload;
  gate_entry: GateEntryPayload;
  panic: PanicPayload;
}

export type OfflinePayload = OfflinePayloadMap[OfflineEventType];

/** A photo attached to an event. Stored as a Blob in IndexedDB until it has been uploaded. */
export interface MediaAttachment {
  /** 'selfie' (shift events), 'photo' (gate entry / checkpoint scan), 'photo', 'photo2', … (incident). */
  field: string;
  blob: Blob;
  /** Defaults to blob.type, then image/jpeg. Allowed: image/jpeg, image/png, image/webp. */
  mimeType?: string;
}

export interface OfflineQueueItem {
  /** Client UUID. Also used as the server row id / offline_uuid of the event. */
  id: string;
  /**
   * Monotonic per device (never below the highest stored number, whatever the clock does).
   * Delivery follows this order where one record depends on another (clock-in before its scans).
   */
  sequenceNumber: number;
  userId: string;
  organisationId: string;
  siteId: string;
  eventType: OfflineEventType;
  payload: OfflinePayload;
  /** Names of the media fields stored in the mediaBlobs table for this item. */
  mediaFields: string[];
  deviceTimestamp: string;
  syncState: SyncState;
  /** Failed attempts of any kind (drives the backoff delay). */
  retryCount: number;
  /** Failed attempts the server rejected (drives the dead-letter limit). Network failures do not count. */
  rejectionCount: number;
  lastError?: string;
  lastAttemptAt?: string;
  /** Automatic runs do not retry this item before this time (manual "Sync now" does). */
  nextAttemptAt?: string;
  createdAt: string;
  syncedAt?: string;
  /**
   * Links left out when the record was delivered because their target never reached the server
   * (e.g. an SOS sent before its shift's clock-in, or a gate OUT whose IN was rejected).
   */
  droppedLinks?: DroppableLink[];
}

export type DroppableLink = 'shift_id' | 'linked_entry_id';

/** Queue item narrowed to one event type (the engine guarantees eventType and payload match). */
export type QueueItemOf<T extends OfflineEventType> = Omit<OfflineQueueItem, 'eventType' | 'payload'> & {
  eventType: T;
  payload: OfflinePayloadMap[T];
};

export type AnyQueueItem = { [K in OfflineEventType]: QueueItemOf<K> }[OfflineEventType];

/** How safe this device's queued evidence is from browser storage eviction. */
export interface DeviceStorageStatus {
  /**
   * true: the browser granted persistent storage (queued evidence is not evicted under storage
   * pressure); false: best-effort storage (may be evicted); null: the browser cannot tell.
   */
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Usage is above 80 % of the quota: new photos may fail to save. */
  nearlyFull: boolean;
}

/** Sync status for the signed-in user of this device. */
export interface OfflineSyncSummary {
  /** navigator.onLine (a hint only: true does not guarantee the server is reachable). */
  isOnline: boolean;
  /** True while this tab is running a sync pass. */
  isSyncing: boolean;
  pendingCount: number;
  syncingCount: number;
  /** Dead-lettered items (never deleted; retry with syncEngine.retryFailed()). */
  failedCount: number;
  /** Unsynced items recorded by other accounts on this device. They are never sent with this user's session. */
  otherUserCount: number;
  lastSyncTimestamp?: string;
  /** Most recent error of this user's oldest unsynced item that has one. */
  lastError?: string;
  /** Storage persistence / space on this device (undefined until checked). */
  storage?: DeviceStorageStatus;
}

export const EMPTY_SYNC_SUMMARY: OfflineSyncSummary = {
  isOnline: true,
  isSyncing: false,
  pendingCount: 0,
  syncingCount: 0,
  failedCount: 0,
  otherUserCount: 0
};
