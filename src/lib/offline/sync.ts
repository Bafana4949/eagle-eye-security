/**
 * Offline-first event queue and sync engine.
 *
 * Guarantees:
 * - enqueue() writes the queue item, its photo Blobs and the local event copy in ONE Dexie
 *   transaction: either all are stored or none are (the caller sees the error).
 * - Sequence numbers are monotonic per device: never below the highest number already stored,
 *   whatever the clock does (network time stepping back, a reload, a second tab).
 * - Only items recorded by the CURRENT session user are ever sent. Items of other accounts on a
 *   shared phone stay queued (reported as otherUserCount) and are never deleted.
 * - One sync pass at a time across tabs (Web Locks). Items go in sequence order, but only real
 *   dependencies hold an item back: scans and the clock-out wait for their clock-in, a gate OUT
 *   for its IN. A record the server rejects, or a photo that will not upload on a weak link,
 *   does not block unrelated records. When the server is unreachable the pass stops and the
 *   queue backs off as a whole (1 s → 60 s).
 * - SOS (panic) alerts are never held back: they go first, are sent the moment they are queued
 *   even while a slow pass is running, and go without their shift link when that shift's
 *   clock-in has not reached the server (panic_alerts.shift_id is optional).
 * - Every delivery has a deadline, so a request that never answers cannot freeze the engine or
 *   the cross-tab lock it holds.
 * - Photos are uploaded to the private evidence bucket at a deterministic path (upsert:false;
 *   "already exists" on a retry counts as success). A failed upload fails the item: the record
 *   is not written and the Blob is kept. Blobs are deleted only after the database write succeeded.
 * - Database writes are idempotent (ON CONFLICT DO NOTHING on the client-generated id), so a
 *   replay after a lost response cannot duplicate or overwrite evidence.
 * - Items the server keeps rejecting are dead-lettered after MAX_REJECTIONS attempts
 *   (state 'failed', lastError kept, never deleted, retryFailed() re-queues them). Network
 *   failures back off but never dead-letter.
 */
import Dexie from 'dexie';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EagleEyeOfflineDB,
  activeShiftKey,
  checkDeviceStorage,
  offlineDB,
  lastSyncKey,
  type LastSyncRecord,
  type LocalEventRecord,
  type StoredMediaBlob
} from './db';
import type {
  AnyQueueItem,
  CheckpointScanPayload,
  DeviceStorageStatus,
  DroppableLink,
  EventContext,
  MediaAttachment,
  OfflineEventType,
  OfflinePayloadMap,
  OfflineQueueItem,
  OfflineSyncSummary,
  QueueItemOf,
  SyncState
} from '@/types/offline';
import {
  EVIDENCE_BUCKET,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  buildEvidencePath,
  evidenceCategoryForEvent
} from '@/lib/storage/evidence';
import { uuidFromName } from '@/lib/utils/hash';
import { isNetworkFailure } from '@/lib/auth/authErrors';
import { createClient } from '@/lib/supabase/client';
import { REQUEST_TIMEOUT_MS, uploadTimeoutMs } from '@/lib/supabase/timeouts';
import { computeScanHash, scanChainCore } from './hashChain';

export const SYNC_LOCK_NAME = 'eagle-eye-sync';
export const ENQUEUE_LOCK_NAME = 'eagle-eye-enqueue';
/** Server rejections before an item is dead-lettered. */
export const MAX_REJECTIONS = 8;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Retry delay when another tab holds the sync lock. */
const LOCK_BUSY_RETRY_MS = 5_000;
/** Background pass interval while the app is open. */
const PERIODIC_SYNC_MS = 30_000;
/** Extra passes run back to back for sync requests that arrived during a pass. */
const MAX_RERUNS = 5;
/** Enqueue attempts when another tab keeps writing between our read and our commit. */
const MAX_ENQUEUE_ATTEMPTS = 5;
/** Slack on top of the per-request limits before a delivery is abandoned. */
const DELIVERY_DEADLINE_MARGIN_MS = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delay before the next automatic attempt after `retryCount` failed attempts: 1 s, 2 s, 4 s … capped at 60 s. */
export function backoffDelayMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (retryCount - 1));
}

/**
 * Longest one delivery may take: each photo upload at the slowest accepted speed plus the
 * database calls (record, one link row per incident photo, the clock-out re-check).
 * The client's own per-request limits normally fire first; this is the backstop.
 */
export function deliveryDeadlineMs(
  item: Pick<OfflineQueueItem, 'eventType' | 'mediaFields'>,
  mediaBytes: readonly number[]
): number {
  const uploads = mediaBytes.reduce((total, bytes) => total + uploadTimeoutMs(bytes), 0);
  const dbCalls = 2 + (item.eventType === 'incident' ? item.mediaFields.length : 0);
  return uploads + dbCalls * REQUEST_TIMEOUT_MS + DELIVERY_DEADLINE_MARGIN_MS;
}

/** Minimal Web Locks surface (navigator.locks). */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

/** A cancellable timer: `promise` resolves when the time is up. */
export interface Deadline {
  promise: Promise<void>;
  cancel(): void;
}

export interface SyncEngineDeps {
  db: EagleEyeOfflineDB;
  getSupabase: () => SupabaseClient;
  /** Cross-tab lock manager. undefined → navigator.locks when available; null → in-tab exclusivity only. */
  locks?: LockManagerLike | null;
  isOnline?: () => boolean;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Used to schedule retries (injectable so tests control time). */
  sleep?: (ms: number) => Promise<void>;
  /** Delivery deadline timer (injectable so tests can make a request "never answer"). */
  deadline?: (ms: number) => Deadline;
  randomUUID?: () => string;
  /** Storage persistence check (navigator.storage in the browser). */
  checkStorage?: (requestPersistence: boolean) => Promise<DeviceStorageStatus>;
}

export interface EnqueueOptions {
  /**
   * Extra Dexie writes committed atomically with the event (e.g. the active-shift record).
   * Only Dexie operations on `db` may be awaited inside.
   */
  additionalWrites?: (tx: { db: EagleEyeOfflineDB; eventId: string; createdAt: string }) => Promise<void>;
}

/**
 * - completed: everything that could be sent was sent.
 * - stopped_on_failure: at least one item failed in this pass (see failedItemId / error).
 * - waiting_backoff: nothing failed, but items are waiting for their retry time.
 */
export type SyncRunStatus = 'completed' | 'stopped_on_failure' | 'waiting_backoff' | 'offline' | 'no_session' | 'busy_elsewhere';

export interface SyncRunReport {
  status: SyncRunStatus;
  /** Items delivered to the server in this pass. */
  synced: number;
  /** First item that failed in this pass. */
  failedItemId?: string;
  error?: string;
}

/** A failed attempt. `transient` = could not reach the server (does not count toward dead-lettering). */
export class SyncItemError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'SyncItemError';
    this.transient = transient;
  }
}

/** Another tab enqueued between our read and our commit (only possible without Web Locks). */
class EnqueueRaceError extends Error {}

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  status?: unknown;
  statusCode?: unknown;
  error?: unknown;
}

/** Readable message for any thrown value (never "[object Object]"). */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as ErrorLike;
    const parts = [e.message, e.error, e.details].filter((part) => typeof part === 'string' && part.length > 0);
    const code = typeof e.code === 'string' && e.code ? ` (${e.code})` : '';
    if (parts.length > 0) return `${parts.join(' — ')}${code}`;
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error';
    }
  }
  return String(error);
}

function isAlreadyExists(error: unknown): boolean {
  const e = (error ?? {}) as ErrorLike;
  return (
    String(e.statusCode) === '409' ||
    e.status === 409 ||
    e.code === 'ResourceAlreadyExists' ||
    e.error === 'Duplicate' ||
    /already exists|duplicate/i.test(typeof e.message === 'string' ? e.message : '')
  );
}

function isTransientStorageError(error: unknown): boolean {
  const status = (error as ErrorLike | null)?.status;
  // No HTTP status means the request never completed (StorageUnknownError / fetch failure / timeout).
  if (typeof status !== 'number') return true;
  return status === 401 || isNetworkFailure(status, error);
}

interface WriteResult {
  error: ErrorLike | null;
  status: number;
}

function assertWrite(result: WriteResult, what: string): void {
  if (!result.error) return;
  // 401 = expired/invalid JWT: a refreshed session fixes it, so it is not the item's fault.
  const transient = result.status === 401 || isNetworkFailure(result.status, result.error);
  throw new SyncItemError(`${what}: ${describeError(result.error)}`, transient);
}

function uuidOrThrow(label: string, value: unknown): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`enqueue: ${label} must be a UUID (got ${JSON.stringify(value)})`);
  }
}

const TIMESTAMP_FIELDS = ['locationTimestamp', 'scheduledStart', 'scheduledEnd', 'entryTime', 'exitTime'] as const;

/** Values the database would reject forever are refused up front (the caller can still fix them). */
function checkTimestampsAndDates(p: Record<string, unknown>): void {
  for (const field of TIMESTAMP_FIELDS) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new Error(`enqueue: payload.${field} is not a valid timestamp (got ${JSON.stringify(value)})`);
    }
  }
  const expiry = p.discExpiryDate;
  if (expiry !== undefined && expiry !== null) {
    const match = typeof expiry === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry) : null;
    const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!match || !date || date.toISOString().slice(0, 10) !== expiry) {
      throw new Error(`enqueue: payload.discExpiryDate must be a real YYYY-MM-DD date (got ${JSON.stringify(expiry)})`);
    }
  }
}

/** Payload fields without a database default: a missing value would be rejected on every attempt. */
const REQUIRED_FIELDS: Partial<Record<OfflineEventType, readonly string[]>> = {
  shift_start: ['shiftType', 'scheduledStart', 'scheduledEnd'],
  checkpoint_scan: ['method'],
  incident: ['incidentType'],
  gate_entry: ['direction', 'entryTime']
};

/** varchar(n) limits of the target columns (Postgres counts characters). */
const MAX_LENGTHS: Partial<Record<OfflineEventType, Readonly<Record<string, number>>>> = {
  incident: { incidentType: 100 },
  gate_entry: {
    licensePlate: 50,
    makeModel: 100,
    vehicleColour: 50,
    vinNumber: 100,
    engineNumber: 100,
    registerNumber: 50,
    vehicleDescription: 120,
    driverName: 255,
    driverPhone: 50,
    company: 255,
    personVisited: 255
  }
};

/** Enum / CHECK constraint values of the target columns. */
const ALLOWED_VALUES: Partial<Record<OfflineEventType, Readonly<Record<string, readonly string[]>>>> = {
  shift_start: { shiftType: ['day', 'night', 'custom'] },
  checkpoint_scan: { method: ['qr', 'nfc', 'manual'], payloadType: ['secure_token', 'legacy_qr', 'nfc_uid', 'manual'] },
  incident: { severity: ['low', 'medium', 'high', 'critical'] },
  gate_entry: { direction: ['in', 'out'] }
};
const GPS_ERROR_KINDS: readonly string[] = ['permission_denied', 'timeout', 'unavailable', 'unsupported', 'insecure', 'stale'];
const INT4_MAX = 2_147_483_647;

function checkColumnConstraints(eventType: OfflineEventType, p: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS[eventType] ?? []) {
    const value = p[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new Error(`enqueue: ${eventType} needs payload.${field}`);
    }
  }
  for (const [field, max] of Object.entries(MAX_LENGTHS[eventType] ?? {})) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error(`enqueue: payload.${field} must be text`);
    // The licence plate is stored trimmed; count code points like Postgres counts characters.
    const length = [...(field === 'licensePlate' ? value.trim() : value)].length;
    if (length > max) {
      throw new Error(`enqueue: payload.${field} is ${length} characters long; at most ${max} can be stored`);
    }
  }
  const allowed: Record<string, readonly string[]> = { ...(ALLOWED_VALUES[eventType] ?? {}), gpsError: GPS_ERROR_KINDS };
  for (const [field, values] of Object.entries(allowed)) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new Error(`enqueue: payload.${field} must be one of ${values.join(', ')} (got ${JSON.stringify(value)})`);
    }
  }
  const dwell = p.dwellDurationSeconds;
  if (dwell !== undefined && dwell !== null && (typeof dwell !== 'number' || !Number.isInteger(dwell) || dwell < 0 || dwell > INT4_MAX)) {
    throw new Error(`enqueue: payload.dwellDurationSeconds must be a whole number of seconds (got ${JSON.stringify(dwell)})`);
  }
}

const MEDIA_FIELDS: Record<OfflineEventType, RegExp | null> = {
  shift_start: /^selfie$/,
  shift_end: /^selfie$/,
  checkpoint_scan: /^photo$/,
  incident: /^photo([2-9])?$/,
  gate_entry: /^photo$/,
  panic: null
};

function validateEnqueue<T extends OfflineEventType>(
  eventType: T,
  ctx: EventContext,
  payload: OfflinePayloadMap[T],
  media: readonly MediaAttachment[]
): void {
  uuidOrThrow('ctx.userId', ctx.userId);
  uuidOrThrow('ctx.organisationId', ctx.organisationId);
  uuidOrThrow('ctx.siteId', ctx.siteId);
  const p = payload as Partial<OfflinePayloadMap[OfflineEventType]> & Record<string, unknown>;
  switch (eventType) {
    case 'shift_start':
    case 'shift_end':
      uuidOrThrow('payload.shiftId', p.shiftId);
      break;
    case 'checkpoint_scan':
      uuidOrThrow('payload.shiftId', p.shiftId);
      uuidOrThrow('payload.checkpointId', p.checkpointId);
      break;
    case 'gate_entry':
      if (typeof p.licensePlate !== 'string' || p.licensePlate.trim() === '') {
        throw new Error('enqueue: gate_entry needs a licence plate');
      }
      if (p.linkedEntryId) uuidOrThrow('payload.linkedEntryId', p.linkedEntryId);
      if (p.shiftId) uuidOrThrow('payload.shiftId', p.shiftId);
      break;
    case 'incident':
    case 'panic':
      if (p.shiftId) uuidOrThrow('payload.shiftId', p.shiftId);
      break;
  }
  checkTimestampsAndDates(p);
  checkColumnConstraints(eventType, p);

  const allowed = MEDIA_FIELDS[eventType];
  const seen = new Set<string>();
  for (const attachment of media) {
    if (!allowed || !allowed.test(attachment.field)) {
      throw new Error(`enqueue: ${eventType} does not accept media field "${attachment.field}"`);
    }
    if (seen.has(attachment.field)) throw new Error(`enqueue: duplicate media field "${attachment.field}"`);
    seen.add(attachment.field);
    if (!(attachment.blob instanceof Blob) || attachment.blob.size === 0) {
      throw new Error(`enqueue: media "${attachment.field}" is empty`);
    }
    if (attachment.blob.size > EVIDENCE_MAX_BYTES) {
      throw new Error(`enqueue: media "${attachment.field}" is larger than ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB`);
    }
    const mime = attachment.mimeType || attachment.blob.type || 'image/jpeg';
    if (!EVIDENCE_MIME_TYPES.includes(mime)) {
      throw new Error(`enqueue: media "${attachment.field}" has unsupported type ${mime}`);
    }
  }
}

function defaultIsOnline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true;
  return navigator.onLine;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: unknown }).locks;
  return locks && typeof (locks as LockManagerLike).request === 'function' ? (locks as LockManagerLike) : null;
}

function defaultRandomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is unavailable. Open the app over https to record events.');
  }
  return globalThis.crypto.randomUUID();
}

function defaultDeadline(ms: number): Deadline {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    // Node (tests): a pending deadline must not keep the process alive.
    (handle as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

const bySequence = (a: OfflineQueueItem, b: OfflineQueueItem) => a.sequenceNumber - b.sequenceNumber;

function shiftIdOf(item: OfflineQueueItem): string | null {
  return (item.payload as { shiftId?: string | null }).shiftId ?? null;
}

interface UploadedMedia {
  path: string;
  mimeType: string;
  size: number;
}

/** What to do with one pending item in this pass. */
type DeliveryPlan =
  | { action: 'send'; dropShiftLink: boolean; dropLinkedEntry: boolean }
  | { action: 'wait' }
  | { action: 'park'; reason: string };

type SendPlan = Extract<DeliveryPlan, { action: 'send' }>;

const SEND_AS_IS: SendPlan = { action: 'send', dropShiftLink: false, dropLinkedEntry: false };

/** Where a shift's clock-in stands on this device ('absent': not recorded here, e.g. restored from the server). */
interface ShiftStartInfo {
  state: SyncState | 'absent';
  /** The site the shift was started at, when this device knows it. */
  siteId: string | null;
}

/** Per-pass lookups of clock-in events by shift id (the event id and site never change). */
type ShiftStartIndex = Map<string, { eventId: string | null; siteId: string | null }>;

export const PARKED_BEHIND_REJECTED_CLOCK_IN =
  'Not sent: the clock-in of this shift was rejected by the server. It will be retried together with the clock-in.';

export class OfflineSyncEngine {
  private readonly db: EagleEyeOfflineDB;
  private readonly getSupabase: () => SupabaseClient;
  private readonly locks: LockManagerLike | null;
  private readonly isOnlineFn: () => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deadline: (ms: number) => Deadline;
  private readonly randomUUID: () => string;
  private readonly checkStorage: (requestPersistence: boolean) => Promise<DeviceStorageStatus>;

  private listeners: Array<(summary: OfflineSyncSummary) => void> = [];
  private activeUserId: string | null = null;
  private inFlight: Promise<SyncRunReport> | null = null;
  private rerunRequested = false;
  private forceRequested = false;
  private syncing = false;
  private retryGeneration = 0;
  private lastSequence = 0;
  private enqueueChain: Promise<unknown> = Promise.resolve();
  private disposers: Array<() => void> = [];
  /** Consecutive passes that found the server unreachable (drives the queue-wide backoff). */
  private connectionFailures = 0;
  private connectionRetryAt = 0;
  private urgentInFlight: Promise<number> | null = null;
  private urgentRerun = false;
  /** Panic items being delivered by the urgent lane of this tab (not "stale syncing"). */
  private readonly urgentClaims = new Set<string>();
  private storageStatus: DeviceStorageStatus | undefined;
  private persistenceRequested = false;

  constructor(deps: SyncEngineDeps) {
    this.db = deps.db;
    this.getSupabase = deps.getSupabase;
    this.locks = deps.locks === undefined ? defaultLocks() : deps.locks;
    this.isOnlineFn = deps.isOnline ?? defaultIsOnline;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.deadline = deps.deadline ?? defaultDeadline;
    this.randomUUID = deps.randomUUID ?? defaultRandomUUID;
    this.checkStorage = deps.checkStorage ?? ((requestPersistence) => checkDeviceStorage({ requestPersistence }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (browser)
  // ---------------------------------------------------------------------------

  /** Wires online/visibility events and a periodic pass, checks storage persistence, then syncs once. Browser only. */
  start(): void {
    if (typeof window === 'undefined' || this.disposers.length > 0) return;
    const onOnline = () => void this.triggerSync({ force: true });
    const onOffline = () => void this.notify();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.triggerSync();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void this.triggerSync(), PERIODIC_SYNC_MS);
    this.disposers.push(
      () => window.removeEventListener('online', onOnline),
      () => window.removeEventListener('offline', onOffline),
      () => document.removeEventListener('visibilitychange', onVisible),
      () => window.clearInterval(interval)
    );
    void this.refreshStorageStatus(false);
    void this.triggerSync();
  }

  dispose(): void {
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
    this.retryGeneration += 1;
    this.listeners = [];
  }

  /** The signed-in user whose queue the summary describes (set by the AuthProvider; null when signed out). */
  setActiveUser(userId: string | null): void {
    if (this.activeUserId === userId) return;
    this.activeUserId = userId;
    void this.notify();
    if (userId) void this.triggerSync();
  }

  /** Re-checks storage persistence and space (optionally asking for persistence again). */
  async refreshStorageStatus(requestPersistence = false): Promise<DeviceStorageStatus | undefined> {
    try {
      this.storageStatus = await this.checkStorage(requestPersistence);
      void this.notify();
    } catch {
      // Unknown storage status is reported as undefined; it never blocks recording.
    }
    return this.storageStatus;
  }

  // ---------------------------------------------------------------------------
  // Subscriptions & status
  // ---------------------------------------------------------------------------

  subscribe(callback: (summary: OfflineSyncSummary) => void): () => void {
    this.listeners.push(callback);
    void this.getSummary().then(
      (summary) => {
        if (this.listeners.includes(callback)) callback(summary);
      },
      () => undefined
    );
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
    };
  }

  private async notify(): Promise<void> {
    if (this.listeners.length === 0) return;
    try {
      const summary = await this.getSummary();
      this.listeners.forEach((listener) => listener(summary));
    } catch {
      // A failing IndexedDB read must not break the sync pass that triggered the notification.
    }
  }

  private async sessionUserId(supabase?: SupabaseClient): Promise<string | null> {
    try {
      const client = supabase ?? this.getSupabase();
      const { data } = await client.auth.getSession();
      return data.session?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  private async summaryUserId(): Promise<string | null> {
    return this.activeUserId ?? (await this.sessionUserId());
  }

  private countFor(userId: string, state: OfflineQueueItem['syncState']): Promise<number> {
    return this.db.syncQueue.where('[userId+syncState]').equals([userId, state]).count();
  }

  async getSummary(): Promise<OfflineSyncSummary> {
    const isOnline = this.isOnlineFn();
    const isSyncing = this.syncing || this.urgentInFlight !== null;
    const storage = this.storageStatus;
    const unsyncedTotal = await this.db.syncQueue.where('syncState').anyOf(['pending', 'syncing', 'failed']).count();
    const userId = await this.summaryUserId();
    if (!userId) {
      return {
        isOnline,
        isSyncing,
        pendingCount: 0,
        syncingCount: 0,
        failedCount: 0,
        otherUserCount: unsyncedTotal,
        ...(storage ? { storage } : {})
      };
    }
    const [pendingCount, syncingCount, failedCount] = await Promise.all([
      this.countFor(userId, 'pending'),
      this.countFor(userId, 'syncing'),
      this.countFor(userId, 'failed')
    ]);
    const lastSync = (await this.db.guardState.get(lastSyncKey(userId))) as LastSyncRecord | undefined;
    let lastError: string | undefined;
    if (pendingCount + failedCount > 0) {
      const unsynced = await this.db.syncQueue
        .where('[userId+syncState]')
        .anyOf([
          [userId, 'pending'],
          [userId, 'failed']
        ])
        .toArray();
      unsynced.sort(bySequence);
      lastError = unsynced.find((item) => item.lastError)?.lastError;
    }
    return {
      isOnline,
      isSyncing,
      pendingCount,
      syncingCount,
      failedCount,
      otherUserCount: unsyncedTotal - pendingCount - syncingCount - failedCount,
      lastSyncTimestamp: lastSync?.kind === 'lastSync' ? lastSync.at : undefined,
      lastError,
      ...(storage ? { storage } : {})
    };
  }

  /** Unsynced items (pending, syncing or dead-lettered) recorded by `userId` on this device. */
  async pendingCountForUser(userId: string): Promise<number> {
    const counts = await Promise.all([
      this.countFor(userId, 'pending'),
      this.countFor(userId, 'syncing'),
      this.countFor(userId, 'failed')
    ]);
    return counts[0] + counts[1] + counts[2];
  }

  /** Sync state of one event (undefined when this device has no such event). */
  async getSyncState(eventId: string): Promise<OfflineQueueItem['syncState'] | undefined> {
    return (await this.db.syncQueue.get(eventId))?.syncState;
  }

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  private async highestStoredSequence(): Promise<number> {
    return (await this.db.syncQueue.orderBy('sequenceNumber').last())?.sequenceNumber ?? 0;
  }

  /** max(clock, highest stored + 1, last issued here + 1): immune to clock steps, reloads and tabs. */
  private nextSequence(highestStored: number): number {
    const floor = Math.max(this.lastSequence, highestStored);
    const candidate = this.now() * 1000;
    this.lastSequence = candidate > floor ? candidate : floor + 1;
    return this.lastSequence;
  }

  private lastScanOf(userId: string): Promise<LocalEventRecord | undefined> {
    return this.db.localEvents
      .where('[userId+type+sequenceNumber]')
      .between([userId, 'checkpoint_scan', Dexie.minKey], [userId, 'checkpoint_scan', Dexie.maxKey])
      .last();
  }

  /** Serialises enqueues in this tab and, with Web Locks, across tabs (keeps the hash chain linear). */
  private withEnqueueLock<T>(task: () => Promise<T>): Promise<T> {
    const run = () => (this.locks ? this.locks.request(ENQUEUE_LOCK_NAME, { mode: 'exclusive' }, () => task()) : task());
    const result = this.enqueueChain.then(run, run);
    this.enqueueChain = result.catch(() => undefined);
    return result;
  }

  /**
   * Stores an event for delivery and returns its id (also the server row id / offline_uuid).
   * Resolves only after the event, its photos and its local copy are committed to IndexedDB.
   */
  async enqueue<T extends OfflineEventType>(
    eventType: T,
    ctx: EventContext,
    payload: OfflinePayloadMap[T],
    media: readonly MediaAttachment[] = [],
    options: EnqueueOptions = {}
  ): Promise<string> {
    validateEnqueue(eventType, ctx, payload, media);
    const eventId = await this.withEnqueueLock(async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.storeEvent(eventType, ctx, payload, media, options);
        } catch (error) {
          if (!(error instanceof EnqueueRaceError) || attempt >= MAX_ENQUEUE_ATTEMPTS) throw error;
        }
      }
    });

    void this.notify();
    // Ask for persistent storage once, on the first thing the guard records (a user action, so
    // browsers that prompt do so in context); afterwards only refresh the space estimate.
    if (!this.persistenceRequested || media.length > 0) {
      void this.refreshStorageStatus(!this.persistenceRequested && this.storageStatus?.persisted !== true);
      this.persistenceRequested = true;
    }
    if (this.isOnlineFn()) {
      if (eventType === 'panic') {
        // The SOS goes out now, even if a slow pass is uploading photos; the pass follows.
        void this.sendPanicsNow()
          .catch(() => 0)
          .then(() => this.triggerSync());
      } else {
        void this.triggerSync();
      }
    }
    return eventId;
  }

  /**
   * One attempt at storing an event. Sequence number and hash-chain link are read first and
   * re-checked inside the write transaction; if another tab wrote in between, EnqueueRaceError
   * makes the caller recompute them (the SHA-256 digest cannot run inside the transaction).
   */
  private async storeEvent<T extends OfflineEventType>(
    eventType: T,
    ctx: EventContext,
    payload: OfflinePayloadMap[T],
    media: readonly MediaAttachment[],
    options: EnqueueOptions
  ): Promise<string> {
    const db = this.db;
    const id = this.randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const highestStored = await this.highestStoredSequence();
    const sequenceNumber = this.nextSequence(highestStored);
    let storedPayload: OfflinePayloadMap[OfflineEventType] = { ...payload };
    let prevHash: string | null | undefined;
    let hash: string | undefined;
    let previousScanId: string | null = null;

    if (eventType === 'checkpoint_scan') {
      const scanPayload = payload as CheckpointScanPayload;
      const previous = await this.lastScanOf(ctx.userId);
      previousScanId = previous?.id ?? null;
      prevHash = previous?.hash ?? null;
      hash = await computeScanHash(
        prevHash,
        scanChainCore({ eventId: id, guardId: ctx.userId, scannedAt: createdAt, payload: scanPayload })
      );
      storedPayload = { ...scanPayload, prevHashChain: prevHash, hashChain: hash };
    }

    const mediaFields = media.map((attachment) => attachment.field);
    const item: OfflineQueueItem = {
      id,
      sequenceNumber,
      userId: ctx.userId,
      organisationId: ctx.organisationId,
      siteId: ctx.siteId,
      eventType,
      payload: storedPayload,
      mediaFields,
      deviceTimestamp: createdAt,
      syncState: 'pending',
      retryCount: 0,
      rejectionCount: 0,
      createdAt
    };
    const localEvent: LocalEventRecord = {
      id,
      userId: ctx.userId,
      organisationId: ctx.organisationId,
      siteId: ctx.siteId,
      shiftId: shiftIdOf(item),
      type: eventType,
      sequenceNumber,
      createdAt,
      payload: storedPayload,
      mediaFields,
      ...(eventType === 'checkpoint_scan' ? { prevHash, hash } : {})
    };
    const blobs: StoredMediaBlob[] = media.map((attachment) => {
      const mimeType = attachment.mimeType || attachment.blob.type || 'image/jpeg';
      return {
        id: `${id}-${attachment.field}`,
        queueItemId: id,
        field: attachment.field,
        data: attachment.blob,
        mimeType,
        fileName: `${id}-${attachment.field}`,
        createdAt
      };
    });

    await db.transaction('rw', [db.syncQueue, db.mediaBlobs, db.localEvents, db.guardState], async () => {
      if ((await this.highestStoredSequence()) >= sequenceNumber) throw new EnqueueRaceError();
      if (eventType === 'checkpoint_scan' && ((await this.lastScanOf(ctx.userId))?.id ?? null) !== previousScanId) {
        throw new EnqueueRaceError();
      }
      await db.syncQueue.add(item);
      if (blobs.length > 0) await db.mediaBlobs.bulkAdd(blobs);
      await db.localEvents.add(localEvent);
      if (options.additionalWrites) await options.additionalWrites({ db, eventId: id, createdAt });
    });
    return id;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Runs a sync pass for the current session user. Concurrent calls share the pass in flight;
   * a request that arrives during a pass gets another pass right after it (whatever the first
   * one's outcome). `force` ignores backoff (manual "Sync now", reconnect).
   */
  triggerSync(options: { force?: boolean } = {}): Promise<SyncRunReport> {
    if (options.force) this.forceRequested = true;
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    const run = async (): Promise<SyncRunReport> => {
      let report: SyncRunReport;
      let passes = 0;
      try {
        do {
          this.rerunRequested = false;
          const force = this.forceRequested;
          this.forceRequested = false;
          report = await this.runExclusive(force);
          passes += 1;
          // Bounded, so a caller that re-triggers from a status callback cannot spin forever.
        } while (this.rerunRequested && passes <= MAX_RERUNS);
        if (this.rerunRequested) this.scheduleRetry(BACKOFF_BASE_MS);
        return report;
      } finally {
        this.inFlight = null;
        this.syncing = false;
        void this.notify();
      }
    };
    this.inFlight = run();
    return this.inFlight;
  }

  private async runExclusive(force: boolean): Promise<SyncRunReport> {
    if (!this.isOnlineFn()) return { status: 'offline', synced: 0 };
    if (!this.locks) return this.runPass(force);
    return this.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        // Another tab is syncing; look again shortly in case it read the queue before our newest item.
        this.scheduleRetry(LOCK_BUSY_RETRY_MS);
        return { status: 'busy_elsewhere' as const, synced: 0 };
      }
      return this.runPass(force);
    });
  }

  /**
   * Items left in 'syncing' by a closed tab or crashed pass. Safe to reset: we hold the sync lock.
   * Panics that this tab's urgent lane is delivering right now are left alone.
   */
  private async resetStaleSyncing(): Promise<number> {
    return this.db.syncQueue
      .where('syncState')
      .equals('syncing')
      .and((item) => !this.urgentClaims.has(item.id))
      .modify({ syncState: 'pending' });
  }

  /** This user's pending items in delivery order: panic alerts first, then sequence order. */
  private async orderedPendingItems(userId: string): Promise<OfflineQueueItem[]> {
    const pending = await this.db.syncQueue.where('[userId+syncState]').equals([userId, 'pending']).toArray();
    pending.sort(bySequence);
    return [...pending.filter((item) => item.eventType === 'panic'), ...pending.filter((item) => item.eventType !== 'panic')];
  }

  private async shiftStartInfo(userId: string, shiftId: string, index: ShiftStartIndex): Promise<ShiftStartInfo> {
    let entry = index.get(shiftId);
    if (!entry) {
      const events = await this.db.localEvents.where('shiftId').equals(shiftId).toArray();
      const start = events.find((event) => event.type === 'shift_start' && event.userId === userId);
      if (start) {
        entry = { eventId: start.id, siteId: start.siteId };
      } else {
        // Clock-in recorded elsewhere (restored from the server): the active-shift record knows the site.
        const active = await this.db.guardState.get(activeShiftKey(userId));
        entry = { eventId: null, siteId: active?.kind === 'activeShift' && active.shiftId === shiftId ? active.siteId : null };
      }
      index.set(shiftId, entry);
    }
    if (!entry.eventId) return { state: 'absent', siteId: entry.siteId };
    const queued = await this.db.syncQueue.get(entry.eventId);
    return { state: queued?.syncState ?? 'absent', siteId: entry.siteId };
  }

  /**
   * Decides, from the current queue state, whether an item can go now:
   * - scans / clock-out wait for their clock-in, and are parked when it was dead-lettered
   *   (the server cannot accept anything for a shift it does not have);
   * - incidents / gate entries wait for their clock-in, and go without the shift link when it
   *   was dead-lettered (shift_id is optional there); a gate OUT waits for its IN likewise;
   * - panics never wait: without a confirmed clock-in they go without the shift link.
   * A shift link that points at a shift of another site (the RLS check would refuse the row
   * forever) is left out as well.
   */
  private async planDelivery(item: OfflineQueueItem, index: ShiftStartIndex): Promise<DeliveryPlan> {
    const shiftId = shiftIdOf(item);
    const shift = shiftId ? await this.shiftStartInfo(item.userId, shiftId, index) : null;
    const clockInPending = shift?.state === 'pending' || shift?.state === 'syncing';
    const clockInRejected = shift?.state === 'failed';
    const otherSite = !!shift?.siteId && shift.siteId !== item.siteId;

    switch (item.eventType) {
      case 'shift_start':
        return SEND_AS_IS;
      case 'checkpoint_scan':
      case 'shift_end':
        if (clockInRejected) return { action: 'park', reason: PARKED_BEHIND_REJECTED_CLOCK_IN };
        if (clockInPending) return { action: 'wait' };
        return SEND_AS_IS;
      case 'panic':
        return {
          action: 'send',
          dropShiftLink: !!shift && (otherSite || (shift.state !== 'synced' && shift.state !== 'absent')),
          dropLinkedEntry: false
        };
      case 'incident':
      case 'gate_entry': {
        if (clockInPending) return { action: 'wait' };
        let dropLinkedEntry = false;
        const linkedEntryId = item.eventType === 'gate_entry' ? (item.payload as { linkedEntryId?: string | null }).linkedEntryId : null;
        if (linkedEntryId) {
          const linked = await this.db.syncQueue.get(linkedEntryId);
          if (linked && linked.syncState !== 'synced') {
            // A rejected IN, or another account's IN this session can never send: go without the link.
            if (linked.syncState === 'failed' || linked.userId !== item.userId) dropLinkedEntry = true;
            else return { action: 'wait' };
          }
        }
        return { action: 'send', dropShiftLink: !!shift && (clockInRejected || otherSite), dropLinkedEntry };
      }
    }
  }

  private async claim(itemId: string): Promise<OfflineQueueItem | null> {
    const db = this.db;
    return db.transaction('rw', db.syncQueue, async () => {
      const current = await db.syncQueue.get(itemId);
      if (!current || current.syncState !== 'pending') return null;
      const lastAttemptAt = new Date(this.now()).toISOString();
      await db.syncQueue.update(itemId, { syncState: 'syncing', lastAttemptAt });
      return { ...current, syncState: 'syncing' as const, lastAttemptAt };
    });
  }

  private async runPass(force: boolean): Promise<SyncRunReport> {
    this.syncing = true;
    const now = this.now();
    if (!force && now < this.connectionRetryAt) {
      // The server was unreachable a moment ago; the whole queue waits (a forced pass does not).
      this.scheduleRetry(this.connectionRetryAt - now);
      return { status: 'waiting_backoff', synced: 0 };
    }
    await this.resetStaleSyncing();
    void this.notify();

    let supabase: SupabaseClient;
    try {
      supabase = this.getSupabase();
    } catch (error) {
      return { status: 'no_session', synced: 0, error: describeError(error) };
    }
    const userId = await this.sessionUserId(supabase);
    if (!userId) return { status: 'no_session', synced: 0 };

    let synced = 0;
    let waited = false;
    let firstFailure: { id: string; error: string } | undefined;
    let serverUnreachable = false;
    /** After a photo upload failed on the network, only records without photos are tried. */
    let photosStalled = false;
    const index: ShiftStartIndex = new Map();

    for (const item of await this.orderedPendingItems(userId)) {
      const plan = await this.planDelivery(item, index);
      if (plan.action === 'park') {
        await this.db.syncQueue.update(item.id, { syncState: 'failed', lastError: plan.reason, nextAttemptAt: undefined });
        void this.notify();
        continue;
      }
      if (plan.action === 'wait') continue;
      // Panics ignore their own backoff: every pass tries the SOS again.
      const nextAttempt = item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : 0;
      if (!force && item.eventType !== 'panic' && nextAttempt > this.now()) {
        waited = true;
        continue;
      }
      if (photosStalled && item.mediaFields.length > 0) continue;
      // Stop if the session changed hands mid-pass: never send one user's item with another's token.
      if ((await this.sessionUserId(supabase)) !== userId) return { status: 'no_session', synced };

      const claimed = await this.claim(item.id);
      if (!claimed) continue;
      void this.notify();
      try {
        await this.deliver(supabase, claimed, plan);
        await this.markSynced(claimed, plan);
        synced += 1;
        this.connectionFailures = 0;
        this.connectionRetryAt = 0;
        void this.notify();
      } catch (error) {
        const { transient } = await this.markFailed(claimed, error);
        firstFailure ??= { id: claimed.id, error: describeError(error) };
        if (transient && claimed.mediaFields.length === 0) {
          // Even a small record could not get through: the server is unreachable. Stop here.
          serverUnreachable = true;
          break;
        }
        if (transient) photosStalled = true;
      }
    }

    if (serverUnreachable) {
      this.connectionFailures += 1;
      const delay = backoffDelayMs(this.connectionFailures);
      this.connectionRetryAt = this.now() + delay;
      this.scheduleRetry(delay);
    } else {
      await this.scheduleNextDue(userId);
    }
    if (firstFailure) return { status: 'stopped_on_failure', synced, failedItemId: firstFailure.id, error: firstFailure.error };
    return { status: waited ? 'waiting_backoff' : 'completed', synced };
  }

  /**
   * Schedules the next automatic pass for when this user's earliest retry is due. Items without
   * a retry time of their own wait on one that has it (their clock-in, their gate IN, or the
   * photo whose failure paused the other photos), so they need no timer of their own.
   */
  private async scheduleNextDue(userId: string): Promise<void> {
    const pending = await this.db.syncQueue.where('[userId+syncState]').equals([userId, 'pending']).toArray();
    if (pending.length === 0) return;
    const now = this.now();
    const due = pending.reduce(
      (earliest, item) => (item.nextAttemptAt ? Math.min(earliest, Date.parse(item.nextAttemptAt)) : earliest),
      Number.POSITIVE_INFINITY
    );
    this.scheduleRetry(Number.isFinite(due) ? Math.max(BACKOFF_BASE_MS, due - now) : BACKOFF_BASE_MS);
  }

  private scheduleRetry(delayMs: number): void {
    const generation = ++this.retryGeneration;
    void this.sleep(Math.max(0, delayMs)).then(() => {
      if (generation === this.retryGeneration) void this.triggerSync();
    });
  }

  // ---------------------------------------------------------------------------
  // SOS lane
  // ---------------------------------------------------------------------------

  /**
   * Sends this user's pending panic alerts right away, alongside any running pass (which may be
   * stuck on a slow photo upload). Claiming is atomic, so a panic is never sent by both at once.
   * Resolves with the number delivered.
   */
  sendPanicsNow(): Promise<number> {
    if (this.urgentInFlight) {
      this.urgentRerun = true;
      return this.urgentInFlight;
    }
    const run = async (): Promise<number> => {
      let sent = 0;
      let reruns = 0;
      try {
        do {
          this.urgentRerun = false;
          sent += await this.runUrgentPass();
          reruns += 1;
        } while (this.urgentRerun && reruns <= MAX_RERUNS);
        return sent;
      } finally {
        this.urgentInFlight = null;
        void this.notify();
      }
    };
    this.urgentInFlight = run();
    return this.urgentInFlight;
  }

  private async runUrgentPass(): Promise<number> {
    if (!this.isOnlineFn()) return 0;
    let supabase: SupabaseClient;
    try {
      supabase = this.getSupabase();
    } catch {
      return 0;
    }
    const userId = await this.sessionUserId(supabase);
    if (!userId) return 0;

    const pending = await this.db.syncQueue.where('[userId+syncState]').equals([userId, 'pending']).toArray();
    const panics = pending.filter((item) => item.eventType === 'panic').sort(bySequence);
    const index: ShiftStartIndex = new Map();
    let sent = 0;
    for (const item of panics) {
      const plan = await this.planDelivery(item, index);
      if (plan.action !== 'send') continue;
      const claimed = await this.claim(item.id);
      if (!claimed) continue;
      this.urgentClaims.add(claimed.id);
      void this.notify();
      try {
        await this.deliver(supabase, claimed, plan);
        await this.markSynced(claimed, plan);
        sent += 1;
        this.connectionFailures = 0;
        this.connectionRetryAt = 0;
      } catch (error) {
        const { transient } = await this.markFailed(claimed, error);
        if (transient) break;
      } finally {
        this.urgentClaims.delete(claimed.id);
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------------------
  // Outcome bookkeeping
  // ---------------------------------------------------------------------------

  private async markSynced(item: OfflineQueueItem, plan: SendPlan): Promise<void> {
    const db = this.db;
    const at = new Date(this.now()).toISOString();
    const droppedLinks: DroppableLink[] = [
      ...(plan.dropShiftLink ? (['shift_id'] as const) : []),
      ...(plan.dropLinkedEntry ? (['linked_entry_id'] as const) : [])
    ];
    await db.transaction('rw', [db.syncQueue, db.mediaBlobs, db.guardState], async () => {
      await db.syncQueue.update(item.id, {
        syncState: 'synced',
        syncedAt: at,
        lastError: undefined,
        nextAttemptAt: undefined,
        droppedLinks: droppedLinks.length > 0 ? droppedLinks : undefined
      });
      // Only now, with the record confirmed on the server, may the local photo copies go.
      await db.mediaBlobs.where('queueItemId').equals(item.id).delete();
      const record: LastSyncRecord = { kind: 'lastSync', key: lastSyncKey(item.userId), userId: item.userId, at };
      await db.guardState.put(record);
    });
  }

  private async markFailed(item: OfflineQueueItem, error: unknown): Promise<{ deadLettered: boolean; transient: boolean }> {
    const transient = error instanceof SyncItemError ? error.transient : isNetworkFailure(undefined, error);
    const retryCount = item.retryCount + 1;
    const rejectionCount = (item.rejectionCount ?? 0) + (transient ? 0 : 1);
    const deadLettered = rejectionCount >= MAX_REJECTIONS;
    const delayMs = backoffDelayMs(retryCount);
    await this.db.syncQueue.update(item.id, {
      syncState: deadLettered ? 'failed' : 'pending',
      retryCount,
      rejectionCount,
      lastError: describeError(error),
      nextAttemptAt: deadLettered ? undefined : new Date(this.now() + delayMs).toISOString()
    });
    void this.notify();
    return { deadLettered, transient };
  }

  /** Re-queues this user's dead-lettered items and syncs immediately. Returns how many were re-queued. */
  async retryFailed(userId?: string): Promise<number> {
    const owner = userId ?? (await this.summaryUserId());
    if (!owner) return 0;
    const count = await this.db.syncQueue
      .where('[userId+syncState]')
      .equals([owner, 'failed'])
      .modify({ syncState: 'pending', retryCount: 0, rejectionCount: 0, nextAttemptAt: undefined });
    void this.notify();
    void this.triggerSync({ force: true });
    return count;
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  /** Uploads the photos and writes the record, abandoned (as a network failure) after its deadline. */
  private async deliver(supabase: SupabaseClient, item: OfflineQueueItem, plan: SendPlan): Promise<void> {
    const blobs = item.mediaFields.length > 0 ? await this.db.mediaBlobs.where('queueItemId').equals(item.id).toArray() : [];
    const limitMs = deliveryDeadlineMs(item, blobs.map((blob) => blob.data.size));
    const work = (async () => {
      const media = await this.uploadMedia(supabase, item, blobs);
      await this.writeRecord(supabase, item as AnyQueueItem, media, plan);
    })();
    // A late settlement after the deadline is ignored (the next attempt is idempotent).
    work.catch(() => undefined);
    const timer = this.deadline(limitMs);
    try {
      await Promise.race([
        work,
        timer.promise.then(() => {
          throw new SyncItemError(`No answer from the server within ${Math.round(limitMs / 1000)} s; will retry`, true);
        })
      ]);
    } finally {
      timer.cancel();
    }
  }

  private async uploadMedia(
    supabase: SupabaseClient,
    item: OfflineQueueItem,
    blobs: readonly StoredMediaBlob[]
  ): Promise<Record<string, UploadedMedia>> {
    const uploaded: Record<string, UploadedMedia> = {};
    const fields = item.mediaFields ?? [];
    if (fields.length === 0) return uploaded;

    const category = evidenceCategoryForEvent(item.eventType);
    if (!category) throw new SyncItemError(`${item.eventType} events cannot carry photos`, false);

    for (const field of fields) {
      const blob = blobs.find((candidate) => candidate.field === field);
      if (!blob) {
        throw new SyncItemError(`Photo "${field}" is missing from this device's storage; the record was not sent`, false);
      }
      const path = buildEvidencePath({
        organisationId: item.organisationId,
        siteId: item.siteId,
        category,
        userId: item.userId,
        eventId: item.id,
        field,
        mimeType: blob.mimeType
      });
      const { error } = await supabase.storage
        .from(EVIDENCE_BUCKET)
        .upload(path, blob.data, { contentType: blob.mimeType, upsert: false, cacheControl: '3600' });
      // Evidence is immutable (no UPDATE policy): on a retry the object already exists, which is success.
      if (error && !isAlreadyExists(error)) {
        throw new SyncItemError(`Photo upload failed: ${describeError(error)}`, isTransientStorageError(error));
      }
      uploaded[field] = { path, mimeType: blob.mimeType, size: blob.data.size };
    }
    return uploaded;
  }

  private async writeRecord(
    supabase: SupabaseClient,
    item: AnyQueueItem,
    media: Record<string, UploadedMedia>,
    plan: SendPlan
  ): Promise<void> {
    const immutable = { onConflict: 'offline_uuid', ignoreDuplicates: true } as const;
    const optionalShiftId = (shiftId: string | null | undefined) => (plan.dropShiftLink ? null : shiftId ?? null);
    switch (item.eventType) {
      case 'shift_start': {
        const p = item.payload;
        const result = await supabase.from('shifts').upsert(
          {
            id: p.shiftId,
            site_id: item.siteId,
            guard_id: item.userId,
            shift_type: p.shiftType,
            scheduled_start: p.scheduledStart,
            scheduled_end: p.scheduledEnd,
            actual_start: item.deviceTimestamp,
            start_selfie_url: media.selfie?.path ?? null,
            start_latitude: p.latitude ?? null,
            start_longitude: p.longitude ?? null,
            start_accuracy_meters: p.accuracyMeters ?? null,
            status: 'active'
          },
          { onConflict: 'id', ignoreDuplicates: true }
        );
        assertWrite(result, 'Saving clock-in');
        return;
      }

      case 'shift_end':
        return this.writeShiftEnd(supabase, item, media);

      case 'checkpoint_scan': {
        const p = item.payload;
        const result = await supabase.from('patrol_scans').upsert(
          {
            id: item.id,
            offline_uuid: item.id,
            shift_id: p.shiftId,
            patrol_round_id: p.patrolRoundId ?? null,
            checkpoint_id: p.checkpointId,
            guard_id: item.userId,
            site_id: item.siteId,
            scan_timestamp_device: item.deviceTimestamp,
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            accuracy_meters: p.accuracyMeters ?? null,
            location_timestamp: p.locationTimestamp ?? null,
            gps_error: p.gpsError ?? null,
            // Advisory only: the BEFORE INSERT trigger recomputes distance, confidence and validity.
            distance_to_checkpoint_meters: p.distanceToCheckpointMeters ?? null,
            gps_confidence: p.gpsConfidence ?? null,
            is_valid_proximity: p.isValidProximity ?? false,
            method: p.method,
            payload_type: p.payloadType,
            raw_payload: p.rawPayload ?? null,
            hash_chain: p.hashChain ?? null,
            prev_hash_chain: p.prevHashChain ?? null
          },
          immutable
        );
        assertWrite(result, 'Saving checkpoint scan');
        return;
      }

      case 'incident': {
        const p = item.payload;
        const result = await supabase.from('incidents').upsert(
          {
            id: item.id,
            offline_uuid: item.id,
            site_id: item.siteId,
            shift_id: optionalShiftId(p.shiftId),
            guard_id: item.userId,
            incident_type: p.incidentType,
            severity: p.severity,
            description: p.description,
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            accuracy_meters: p.accuracyMeters ?? null,
            status: 'reported',
            reported_at: item.deviceTimestamp
          },
          immutable
        );
        assertWrite(result, 'Saving incident');
        for (const field of item.mediaFields) {
          const photo = media[field];
          if (!photo) throw new SyncItemError(`Incident photo "${field}" was not uploaded`, false);
          // Deterministic id → a replay cannot create a second link row.
          const mediaId = await uuidFromName(`incident_media:${item.id}:${field}`);
          const link = await supabase.from('incident_media').upsert(
            {
              id: mediaId,
              incident_id: item.id,
              media_url: photo.path,
              media_type: photo.mimeType,
              file_size_bytes: photo.size
            },
            { onConflict: 'id', ignoreDuplicates: true }
          );
          assertWrite(link, 'Linking incident photo');
        }
        return;
      }

      case 'gate_entry': {
        const p = item.payload;
        const result = await supabase.from('gate_entries').upsert(
          {
            id: item.id,
            offline_uuid: item.id,
            site_id: item.siteId,
            shift_id: optionalShiftId(p.shiftId),
            guard_id: item.userId,
            direction: p.direction,
            license_plate: p.licensePlate.trim(),
            make_model: p.makeModel ?? null,
            vehicle_colour: p.vehicleColour ?? null,
            disc_expiry_date: p.discExpiryDate ?? null,
            vin_number: p.vinNumber ?? null,
            engine_number: p.engineNumber ?? null,
            register_number: p.registerNumber ?? null,
            vehicle_description: p.vehicleDescription ?? null,
            driver_name: p.driverName ?? null,
            driver_phone: p.driverPhone ?? null,
            company: p.company ?? null,
            visit_reason: p.visitReason ?? null,
            person_visited: p.personVisited ?? null,
            is_disc_scanned: p.isDiscScanned,
            entry_time: p.entryTime,
            exit_time: p.exitTime ?? null,
            dwell_duration_seconds: p.dwellDurationSeconds ?? null,
            vehicle_photo_url: media.photo?.path ?? null,
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            accuracy_meters: p.accuracyMeters ?? null,
            linked_entry_id: plan.dropLinkedEntry ? null : p.linkedEntryId ?? null
          },
          immutable
        );
        assertWrite(result, 'Saving gate entry');
        return;
      }

      case 'panic': {
        const p = item.payload;
        const result = await supabase.from('panic_alerts').upsert(
          {
            id: item.id,
            offline_uuid: item.id,
            site_id: item.siteId,
            shift_id: optionalShiftId(p.shiftId),
            guard_id: item.userId,
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            accuracy_meters: p.accuracyMeters ?? null,
            status: 'active',
            triggered_at: item.deviceTimestamp
          },
          immutable
        );
        assertWrite(result, 'Saving panic alert');
        return;
      }
    }
  }

  /**
   * Clock-out is an UPDATE of the shift row. It must affect exactly the open shift: 0 rows is a
   * failure, unless the row already carries this very clock-out (a replay after a lost response).
   */
  private async writeShiftEnd(
    supabase: SupabaseClient,
    item: QueueItemOf<'shift_end'>,
    media: Record<string, UploadedMedia>
  ): Promise<void> {
    const p = item.payload;
    const result = await supabase
      .from('shifts')
      .update({
        actual_end: item.deviceTimestamp,
        end_selfie_url: media.selfie?.path ?? null,
        end_latitude: p.latitude ?? null,
        end_longitude: p.longitude ?? null,
        end_accuracy_meters: p.accuracyMeters ?? null,
        status: 'completed'
      })
      .eq('id', p.shiftId)
      .eq('guard_id', item.userId)
      .is('actual_end', null)
      .select('id');
    assertWrite(result, 'Saving clock-out');
    if (Array.isArray(result.data) && result.data.length > 0) return;

    const check = await supabase.from('shifts').select('id, actual_end').eq('id', p.shiftId).maybeSingle();
    assertWrite(check, 'Checking clock-out');
    const row = check.data as { id: string; actual_end: string | null } | null;
    if (row?.actual_end && Date.parse(row.actual_end) === Date.parse(item.deviceTimestamp)) return;
    throw new SyncItemError(
      row
        ? 'Clock-out not saved: the server already has a different end time for this shift'
        : 'Clock-out not saved: the shift is not on the server (its clock-in has not been accepted)',
      false
    );
  }
}

/** Browser singleton (null during server rendering). Starts syncing on load, on reconnect and periodically. */
export const syncEngine: OfflineSyncEngine | null =
  typeof window !== 'undefined' && offlineDB ? new OfflineSyncEngine({ db: offlineDB, getSupabase: createClient }) : null;

syncEngine?.start();
