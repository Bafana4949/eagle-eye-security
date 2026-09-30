/**
 * TEST SUPPORT ONLY: builds a real EagleEyeOfflineDB on fake-indexeddb and a real
 * OfflineSyncEngine wired to FakeSupabase, with controllable clock, connectivity, retry timers
 * and delivery deadlines.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { EagleEyeOfflineDB } from '../db';
import { OfflineSyncEngine, type Deadline, type LockManagerLike } from '../sync';
import { FakeSupabase } from './fakeSupabase';

export const ORG = '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c';
export const SITE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
export const GUARD_A = 'a1111111-2222-4333-8444-555555555555';
export const GUARD_B = 'b1111111-2222-4333-8444-555555555555';
export const CHECKPOINT_1 = 'c1111111-2222-4333-8444-555555555555';
export const CHECKPOINT_2 = 'c2222222-2222-4333-8444-555555555555';

export function createTestDb(): EagleEyeOfflineDB {
  return new EagleEyeOfflineDB(`test-${globalThis.crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
}

/** Delivery deadlines the test fires by hand (`expireAll`), recording the limits the engine asked for. */
export class ManualDeadlines {
  readonly requestedMs: number[] = [];
  private readonly pending = new Set<() => void>();

  readonly create = (ms: number): Deadline => {
    this.requestedMs.push(ms);
    let fire: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      fire = resolve;
    });
    this.pending.add(fire);
    return { promise, cancel: () => this.pending.delete(fire) };
  };

  /** Makes every running delivery time out now. Returns how many were expired. */
  expireAll(): number {
    const fires = [...this.pending];
    this.pending.clear();
    fires.forEach((fire) => fire());
    return fires.length;
  }
}

export interface Harness {
  db: EagleEyeOfflineDB;
  supabase: FakeSupabase;
  engine: OfflineSyncEngine;
  deadlines: ManualDeadlines;
  /** Connectivity seen by the engine (false by default so enqueue does not auto-sync). */
  setOnline(online: boolean): void;
  /** Advance the engine's clock. */
  advance(ms: number): void;
  /** Delays the engine asked to wait before its next automatic retry (timers never fire in tests). */
  scheduledDelays: number[];
}

export function createHarness(options: { sessionUserId?: string | null; locks?: LockManagerLike | null } = {}): Harness {
  const db = createTestDb();
  const supabase = new FakeSupabase(options.sessionUserId === undefined ? GUARD_A : options.sessionUserId);
  let online = false;
  let clock = Date.parse('2026-09-30T18:00:00.000Z');
  const scheduledDelays: number[] = [];
  const deadlines = new ManualDeadlines();
  const engine = new OfflineSyncEngine({
    db,
    getSupabase: () => supabase.client,
    locks: options.locks === undefined ? null : options.locks,
    isOnline: () => online,
    now: () => clock,
    sleep: (ms) => {
      scheduledDelays.push(ms);
      return new Promise<void>(() => undefined);
    },
    deadline: deadlines.create,
    checkStorage: async () => ({ persisted: true, usageBytes: 1_000, quotaBytes: 1_000_000, nearlyFull: false })
  });
  return {
    db,
    supabase,
    engine,
    deadlines,
    scheduledDelays,
    setOnline: (value) => {
      online = value;
    },
    advance: (ms) => {
      clock += ms;
    }
  };
}

export function jpeg(bytes = 64): Blob {
  return new Blob([new Uint8Array(bytes).fill(7)], { type: 'image/jpeg' });
}

/** Lets pending promise callbacks (and fake-indexeddb's macrotasks) run. */
export function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
