import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftStore, ShiftStoreError } from './shiftStore';
import { activeShiftKey } from '@/lib/offline/db';
import { CHECKPOINT_1, GUARD_A, GUARD_B, ORG, SITE, createHarness, jpeg } from '@/lib/offline/testing/harness';
import type { EventContext, ShiftStartPayload, ShiftEndPayload, CheckpointScanPayload } from '@/types/offline';

const CTX_A: EventContext = { userId: GUARD_A, organisationId: ORG, siteId: SITE };
const CTX_B: EventContext = { userId: GUARD_B, organisationId: ORG, siteId: SITE };
const OTHER_SITE = '6a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const WINDOW = { shiftType: 'night' as const, scheduledStart: '2026-09-30T16:00:00.000Z', scheduledEnd: '2026-10-01T04:00:00.000Z' };
const FIX = { latitude: -25.6841, longitude: 27.8145, accuracyMeters: 8, locationTimestamp: '2026-09-30T17:59:59.000Z', gpsError: null };

function setup() {
  const h = createHarness();
  const store = createShiftStore({ db: h.db, engine: h.engine });
  return { h, store };
}

describe('shiftStore', () => {
  it('startShift and endShift enqueue the SAME client-generated shift id', async () => {
    const { h, store } = setup();
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: jpeg(), location: FIX });
    assert.match(active.shiftId, /^[0-9a-f-]{36}$/);
    assert.equal((await store.getActiveShift(GUARD_A))?.shiftId, active.shiftId);

    const start = await h.db.syncQueue.get(active.startEventId);
    assert.equal(start?.eventType, 'shift_start');
    assert.equal((start?.payload as ShiftStartPayload).shiftId, active.shiftId);
    assert.deepEqual(start?.mediaFields, ['selfie']);

    const ended = await store.endShift({ ctx: CTX_A, shiftId: active.shiftId, selfieBlob: jpeg(), location: { ...FIX, accuracyMeters: 4 } });
    assert.equal(ended.shiftId, active.shiftId);
    const end = await h.db.syncQueue.get(ended.eventId);
    assert.equal(end?.eventType, 'shift_end');
    assert.equal((end?.payload as ShiftEndPayload).shiftId, active.shiftId);
    assert.equal(await store.getActiveShift(GUARD_A), null);
  });

  it('endShift refuses when there is no running shift, or a different one', async () => {
    const { h, store } = setup();
    await assert.rejects(
      store.endShift({ ctx: CTX_A, shiftId: 'd1111111-2222-4333-8444-555555555555', selfieBlob: null, location: FIX }),
      (error: unknown) => error instanceof ShiftStoreError && error.code === 'no_active_shift'
    );
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    await assert.rejects(
      store.endShift({ ctx: CTX_A, shiftId: 'd1111111-2222-4333-8444-555555555555', selfieBlob: null, location: FIX }),
      (error: unknown) => error instanceof ShiftStoreError && error.code === 'shift_mismatch'
    );
    assert.equal(await h.db.syncQueue.where('eventType').equals('shift_end').count(), 0, 'nothing queued');
    assert.equal((await store.getActiveShift(GUARD_A))?.shiftId, active.shiftId);
  });

  it('refuses a second shift while one is running (no duplicate clock-in)', async () => {
    const { h, store } = setup();
    await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    await assert.rejects(
      store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX }),
      (error: unknown) => error instanceof ShiftStoreError && error.code === 'already_active'
    );
    const results = await Promise.allSettled([
      store.startShift({ ctx: CTX_B, ...WINDOW, selfieBlob: null, location: FIX }),
      store.startShift({ ctx: CTX_B, ...WINDOW, selfieBlob: null, location: FIX })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, 'double tap opens one shift');
    assert.equal(await h.db.syncQueue.where('eventType').equals('shift_start').count(), 2);
  });

  it('getActiveShift returns exactly this user’s running shift, never an arbitrary row', async () => {
    const { h, store } = setup();
    // Historical/other rows in the legacy v1 shifts table must not be picked up.
    await h.db.shifts.bulkAdd([
      { id: 'old-1', siteId: SITE, guardId: GUARD_A, shiftType: 'day', scheduledStart: 'x', scheduledEnd: 'y', status: 'completed' },
      { id: 'old-2', siteId: SITE, guardId: GUARD_A, shiftType: 'night', scheduledStart: 'x', scheduledEnd: 'y', status: 'active' }
    ]);
    assert.equal(await store.getActiveShift(GUARD_A), null);

    const a = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    const b = await store.startShift({ ctx: { ...CTX_B, siteId: OTHER_SITE }, ...WINDOW, selfieBlob: null, location: FIX });
    assert.equal((await store.getActiveShift(GUARD_A))?.shiftId, a.shiftId);
    assert.equal((await store.getActiveShift(GUARD_B))?.shiftId, b.shiftId);
    assert.equal((await store.getActiveShift(GUARD_B))?.siteId, OTHER_SITE);
    assert.equal(await store.getActiveShift(''), null);
  });

  it('ends the shift at the site where it started even if another site is selected now', async () => {
    const { h, store } = setup();
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    const ended = await store.endShift({ ctx: { ...CTX_A, siteId: OTHER_SITE }, shiftId: active.shiftId, selfieBlob: null, location: FIX });
    assert.equal((await h.db.syncQueue.get(ended.eventId))?.siteId, SITE);
  });

  it('syncs clock-in, scans and clock-out against the real shift id', async () => {
    const { h, store } = setup();
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: jpeg(), location: FIX });
    const scan: CheckpointScanPayload = { shiftId: active.shiftId, checkpointId: CHECKPOINT_1, method: 'qr', payloadType: 'secure_token', ...FIX };
    await h.engine.enqueue('checkpoint_scan', CTX_A, scan);
    h.advance(10 * 60_000);
    await store.endShift({ ctx: CTX_A, shiftId: active.shiftId, selfieBlob: jpeg(), location: FIX });
    h.setOnline(true);
    await h.engine.triggerSync();

    const [shift] = h.supabase.rows('shifts');
    assert.equal(shift.id, active.shiftId);
    assert.equal(shift.status, 'completed');
    assert.equal(shift.actual_start, active.startedAt);
    assert.match(String(shift.start_selfie_url), new RegExp(`^${ORG}/${SITE}/selfie/${GUARD_A}/`));
    assert.match(String(shift.end_selfie_url), /-selfie\.jpg$/);
    assert.equal(h.supabase.rows('patrol_scans')[0].shift_id, active.shiftId);
  });

  it('reconcileWithServer restores exactly one server shift, refuses to guess between several, clears closed ones', async () => {
    const { h, store } = setup();
    const serverShift = {
      id: 'd3333333-2222-4333-8444-555555555555',
      guard_id: GUARD_A,
      site_id: SITE,
      shift_type: 'day',
      scheduled_start: '2026-09-30T04:00:00.000Z',
      scheduled_end: '2026-09-30T16:00:00.000Z',
      actual_start: '2026-09-30T04:02:00.000Z',
      start_latitude: -25.6,
      start_longitude: 27.8,
      start_accuracy_meters: 12,
      status: 'active'
    };
    h.supabase.table('shifts').set(serverShift.id, serverShift);
    const restored = await store.reconcileWithServer(h.supabase.client, CTX_A);
    assert.equal(restored.status, 'restored');
    assert.equal((await store.getActiveShift(GUARD_A))?.shiftId, serverShift.id);

    serverShift.status = 'completed';
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), { status: 'closed_on_server', shiftId: serverShift.id });
    assert.equal(await h.db.guardState.get(activeShiftKey(GUARD_A)), undefined);

    h.supabase.table('shifts').set('s1', { ...serverShift, id: 's1', status: 'active' });
    h.supabase.table('shifts').set('s2', { ...serverShift, id: 's2', status: 'active' });
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), { status: 'ambiguous', count: 2 });
    assert.equal(await store.getActiveShift(GUARD_A), null);
  });

  it('reconcileWithServer leaves a shift whose clock-in has not synced yet alone', async () => {
    const { h, store } = setup();
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), { status: 'unchanged' });
    assert.equal((await store.getActiveShift(GUARD_A))?.shiftId, active.shiftId);
  });

  it('reconcileWithServer never revives a shift the guard ended on this phone while the clock-out is still queued', async () => {
    const { h, store } = setup();
    const active = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: jpeg(), location: FIX });
    h.setOnline(true);
    await h.engine.triggerSync({ force: true });
    assert.equal(h.supabase.rows('shifts')[0]?.status, 'active', 'clock-in reached the server');

    h.setOnline(false);
    h.advance(8 * 3_600_000);
    await store.endShift({ ctx: CTX_A, shiftId: active.shiftId, selfieBlob: jpeg(), location: FIX });
    // Back online; a page reconciles before the queued clock-out has been delivered.
    h.setOnline(true);
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), {
      status: 'unchanged',
      reason: 'ended_on_this_device'
    });
    assert.equal(await store.getActiveShift(GUARD_A), null);
    const next = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    assert.notEqual(next.shiftId, active.shiftId, 'the next shift can start');

    // Even after the clock-out synced, a server that still lists the shift as active cannot revive it.
    await h.engine.triggerSync({ force: true });
    await h.db.guardState.delete(activeShiftKey(GUARD_A));
    h.supabase.table('shifts').get(active.shiftId)!.status = 'active';
    h.supabase.table('shifts').get(next.shiftId)!.status = 'completed';
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), {
      status: 'unchanged',
      reason: 'ended_on_this_device'
    });
  });

  it('reconcileWithServer does not restore a server shift while this phone has clock-in/out events on their way', async () => {
    const { h, store } = setup();
    const local = await store.startShift({ ctx: CTX_A, ...WINDOW, selfieBlob: null, location: FIX });
    await store.endShift({ ctx: CTX_A, shiftId: local.shiftId, selfieBlob: null, location: FIX });
    h.supabase.table('shifts').set('d4444444-2222-4333-8444-555555555555', {
      id: 'd4444444-2222-4333-8444-555555555555',
      guard_id: GUARD_A,
      site_id: SITE,
      shift_type: 'day',
      scheduled_start: '2026-09-30T04:00:00.000Z',
      scheduled_end: '2026-09-30T16:00:00.000Z',
      actual_start: '2026-09-30T04:02:00.000Z',
      start_latitude: null,
      start_longitude: null,
      start_accuracy_meters: null,
      status: 'active'
    });
    assert.deepEqual(await store.reconcileWithServer(h.supabase.client, CTX_A), {
      status: 'unchanged',
      reason: 'local_shift_changes_pending'
    });
    assert.equal(await store.getActiveShift(GUARD_A), null);
  });
});
