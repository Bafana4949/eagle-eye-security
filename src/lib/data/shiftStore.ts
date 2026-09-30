/**
 * The guard's shift lifecycle on this device.
 *
 * - The active shift is ONE record per user in Dexie guardState (`activeShift:<userId>`), so the
 *   app always resumes/closes exactly that shift — never "the first shift row found".
 * - startShift generates the shift id on the device; shift_start, shift_end and every checkpoint
 *   scan carry that same id, so the server rows link up even when all of it happened offline.
 * - The queue event and the active-shift record are committed in one Dexie transaction.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShiftType } from '@/types/models';
import type { EventContext, EventLocation, MediaAttachment } from '@/types/offline';
import { EagleEyeOfflineDB, activeShiftKey, offlineDB, type ActiveShiftRecord } from '@/lib/offline/db';
import { OfflineSyncEngine, syncEngine } from '@/lib/offline/sync';

export type ShiftStoreErrorCode = 'already_active' | 'no_active_shift' | 'shift_mismatch' | 'unavailable';

export class ShiftStoreError extends Error {
  readonly code: ShiftStoreErrorCode;
  constructor(code: ShiftStoreErrorCode, message: string) {
    super(message);
    this.name = 'ShiftStoreError';
    this.code = code;
  }
}

export interface StartShiftInput {
  ctx: EventContext;
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
  /** Clock-in selfie (already compressed). null only when the camera genuinely failed; the UI must say so. */
  selfieBlob: Blob | null;
  location: EventLocation;
}

export interface EndShiftInput {
  ctx: EventContext;
  shiftId: string;
  selfieBlob: Blob | null;
  location: EventLocation;
}

export interface EndShiftResult {
  shiftId: string;
  /** Queue/event id of the shift_end event. */
  eventId: string;
  endedAt: string;
}

export interface ShiftStore {
  getActiveShift(userId: string): Promise<ActiveShiftRecord | null>;
  startShift(input: StartShiftInput): Promise<ActiveShiftRecord>;
  endShift(input: EndShiftInput): Promise<EndShiftResult>;
  reconcileWithServer(
    supabase: Pick<SupabaseClient, 'from'>,
    ctx: Pick<EventContext, 'userId' | 'organisationId'>
  ): Promise<ReconcileResult>;
}

export type ReconcileResult =
  | {
      status: 'unchanged';
      /**
       * Why an active server shift was NOT restored: the guard already ended it on this phone
       * (clock-out not delivered yet), or other clock-in/out events are still on their way.
       */
      reason?: 'ended_on_this_device' | 'local_shift_changes_pending';
    }
  | { status: 'restored'; shift: ActiveShiftRecord }
  | { status: 'closed_on_server'; shiftId: string }
  | { status: 'ambiguous'; count: number }
  | { status: 'error'; message: string };

function selfieMedia(blob: Blob | null): MediaAttachment[] {
  return blob ? [{ field: 'selfie', blob, mimeType: blob.type || 'image/jpeg' }] : [];
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ServerShiftRow {
  id: string;
  site_id: string;
  shift_type: ShiftType;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  start_latitude: number | null;
  start_longitude: number | null;
  start_accuracy_meters: number | null;
  status: string;
}

export function createShiftStore(deps: { db: EagleEyeOfflineDB; engine: OfflineSyncEngine }): ShiftStore {
  const { db, engine } = deps;

  async function getActiveShift(userId: string): Promise<ActiveShiftRecord | null> {
    if (!userId) return null;
    const record = await db.guardState.get(activeShiftKey(userId));
    return record && record.kind === 'activeShift' && record.userId === userId ? record : null;
  }

  async function startShift(input: StartShiftInput): Promise<ActiveShiftRecord> {
    const { ctx } = input;
    const existing = await getActiveShift(ctx.userId);
    if (existing) {
      throw new ShiftStoreError('already_active', 'A shift is already running on this phone. End it before starting a new one.');
    }
    const shiftId = globalThis.crypto.randomUUID();
    const committed: { record?: ActiveShiftRecord } = {};

    await engine.enqueue(
      'shift_start',
      ctx,
      {
        shiftId,
        shiftType: input.shiftType,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        ...input.location
      },
      selfieMedia(input.selfieBlob),
      {
        additionalWrites: async ({ db: tx, eventId, createdAt }) => {
          // Re-check inside the transaction so two quick taps cannot open two shifts.
          const current = await tx.guardState.get(activeShiftKey(ctx.userId));
          if (current && current.kind === 'activeShift') {
            throw new ShiftStoreError('already_active', 'A shift is already running on this phone.');
          }
          const record: ActiveShiftRecord = {
            kind: 'activeShift',
            key: activeShiftKey(ctx.userId),
            userId: ctx.userId,
            organisationId: ctx.organisationId,
            siteId: ctx.siteId,
            shiftId,
            shiftType: input.shiftType,
            scheduledStart: input.scheduledStart,
            scheduledEnd: input.scheduledEnd,
            startedAt: createdAt,
            startEventId: eventId,
            startLatitude: numberOrNull(input.location.latitude),
            startLongitude: numberOrNull(input.location.longitude),
            startAccuracyMeters: numberOrNull(input.location.accuracyMeters)
          };
          await tx.guardState.put(record);
          committed.record = record;
        }
      }
    );
    if (!committed.record) throw new ShiftStoreError('unavailable', 'Clock-in was not stored.');
    return committed.record;
  }

  async function endShift(input: EndShiftInput): Promise<EndShiftResult> {
    const { ctx } = input;
    const active = await getActiveShift(ctx.userId);
    if (!active) {
      throw new ShiftStoreError('no_active_shift', 'There is no running shift on this phone to end.');
    }
    if (active.shiftId !== input.shiftId) {
      throw new ShiftStoreError('shift_mismatch', 'This is not the shift that is running on this phone.');
    }
    const committed: { endedAt?: string } = {};
    // The shift is ended at the site it was started at, whatever site is selected now.
    const shiftCtx: EventContext = { userId: ctx.userId, organisationId: active.organisationId, siteId: active.siteId };
    const eventId = await engine.enqueue(
      'shift_end',
      shiftCtx,
      { shiftId: active.shiftId, ...input.location },
      selfieMedia(input.selfieBlob),
      {
        additionalWrites: async ({ db: tx, createdAt }) => {
          const current = await tx.guardState.get(activeShiftKey(ctx.userId));
          if (!current || current.kind !== 'activeShift' || current.shiftId !== active.shiftId) {
            throw new ShiftStoreError('no_active_shift', 'The shift was already ended.');
          }
          await tx.guardState.delete(activeShiftKey(ctx.userId));
          committed.endedAt = createdAt;
        }
      }
    );
    if (!committed.endedAt) throw new ShiftStoreError('unavailable', 'Clock-out was not stored.');
    return { shiftId: active.shiftId, eventId, endedAt: committed.endedAt };
  }

  /**
   * Online check against the server (best effort, never guesses):
   * - local shift closed on the server (e.g. by a supervisor) → local record cleared;
   * - no local shift but exactly ONE active server shift for this guard → restored
   *   (new phone / cleared storage mid-shift); several → 'ambiguous', nothing picked.
   * A local shift whose clock-in has not synced yet is left alone. The phone's own record wins
   * over the server's "active" while its clock-in/out events are still on their way: a shift the
   * guard already ended here (clock-out queued) is never revived.
   */
  async function reconcileWithServer(
    supabase: Pick<SupabaseClient, 'from'>,
    ctx: Pick<EventContext, 'userId' | 'organisationId'>
  ): Promise<ReconcileResult> {
    const columns =
      'id, site_id, shift_type, scheduled_start, scheduled_end, actual_start, start_latitude, start_longitude, start_accuracy_meters, status';
    try {
      const local = await getActiveShift(ctx.userId);
      if (local) {
        const { data, error } = await supabase.from('shifts').select('id, status').eq('id', local.shiftId).maybeSingle();
        if (error) return { status: 'error', message: error.message };
        const row = data as { id: string; status: string } | null;
        if (row && row.status !== 'active') {
          await db.guardState.delete(activeShiftKey(ctx.userId));
          return { status: 'closed_on_server', shiftId: local.shiftId };
        }
        return { status: 'unchanged' };
      }

      const { data, error } = await supabase
        .from('shifts')
        .select(columns)
        .eq('guard_id', ctx.userId)
        .eq('status', 'active')
        .order('actual_start', { ascending: false })
        .limit(2);
      if (error) return { status: 'error', message: error.message };
      const rows = (data ?? []) as ServerShiftRow[];
      if (rows.length === 0) return { status: 'unchanged' };
      if (rows.length > 1) return { status: 'ambiguous', count: rows.length };
      const row = rows[0];
      const record: ActiveShiftRecord = {
        kind: 'activeShift',
        key: activeShiftKey(ctx.userId),
        userId: ctx.userId,
        organisationId: ctx.organisationId,
        siteId: row.site_id,
        shiftId: row.id,
        shiftType: row.shift_type,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        startedAt: row.actual_start ?? row.scheduled_start,
        // Clock-in happened on another device / before local storage was cleared.
        startEventId: row.id,
        startLatitude: row.start_latitude,
        startLongitude: row.start_longitude,
        startAccuracyMeters: row.start_accuracy_meters
      };
      const outcome = await db.transaction('rw', [db.guardState, db.localEvents, db.syncQueue], async () => {
        if (await db.guardState.get(activeShiftKey(ctx.userId))) return 'already_active' as const;
        const endedHere = await db.localEvents
          .where('shiftId')
          .equals(row.id)
          .filter((event) => event.type === 'shift_end' && event.userId === ctx.userId)
          .count();
        if (endedHere > 0) return 'ended_on_this_device' as const;
        const shiftEventsOnTheirWay = await db.syncQueue
          .where('[userId+syncState]')
          .anyOf([
            [ctx.userId, 'pending'],
            [ctx.userId, 'syncing']
          ])
          .filter((item) => item.eventType === 'shift_start' || item.eventType === 'shift_end')
          .count();
        if (shiftEventsOnTheirWay > 0) return 'local_shift_changes_pending' as const;
        await db.guardState.put(record);
        return 'restored' as const;
      });
      if (outcome === 'restored') return { status: 'restored', shift: record };
      return outcome === 'already_active' ? { status: 'unchanged' } : { status: 'unchanged', reason: outcome };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { getActiveShift, startShift, endShift, reconcileWithServer };
}

const browserStore: ShiftStore | null =
  offlineDB && syncEngine ? createShiftStore({ db: offlineDB, engine: syncEngine }) : null;

function requireStore(): ShiftStore {
  if (!browserStore) {
    throw new ShiftStoreError('unavailable', 'Shift storage is only available in the browser.');
  }
  return browserStore;
}

/** The user's running shift on this device, or null. Never an arbitrary/historical shift. */
export function getActiveShift(userId: string): Promise<ActiveShiftRecord | null> {
  return browserStore ? browserStore.getActiveShift(userId) : Promise.resolve(null);
}

export function startShift(input: StartShiftInput): Promise<ActiveShiftRecord> {
  return requireStore().startShift(input);
}

export function endShift(input: EndShiftInput): Promise<EndShiftResult> {
  return requireStore().endShift(input);
}

export function reconcileActiveShift(
  supabase: Pick<SupabaseClient, 'from'>,
  ctx: Pick<EventContext, 'userId' | 'organisationId'>
): Promise<ReconcileResult> {
  return requireStore().reconcileWithServer(supabase, ctx);
}

export type { ActiveShiftRecord } from '@/lib/offline/db';
