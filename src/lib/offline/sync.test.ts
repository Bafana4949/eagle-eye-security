import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { EagleEyeOfflineDB, LEGACY_UNATTRIBUTED_ERROR, checkDeviceStorage, type LocalEventRecord, type StorageManagerLike } from './db';
import {
  BACKOFF_BASE_MS,
  MAX_REJECTIONS,
  OfflineSyncEngine,
  PARKED_BEHIND_REJECTED_CLOCK_IN,
  backoffDelayMs,
  deliveryDeadlineMs,
  describeError,
  type LockManagerLike
} from './sync';
import { verifyScanChain, computeScanHash, scanChainCore } from './hashChain';
import { buildEvidencePath } from '@/lib/storage/evidence';
import { REQUEST_TIMEOUT_MS, uploadTimeoutMs } from '@/lib/supabase/timeouts';
import { FakeSupabase, NETWORK_ERROR, RLS_ERROR, type RecordedCall } from './testing/fakeSupabase';
import {
  CHECKPOINT_1,
  CHECKPOINT_2,
  GUARD_A,
  GUARD_B,
  ORG,
  SITE,
  createHarness,
  createTestDb,
  jpeg,
  type Harness
} from './testing/harness';
import type { CheckpointScanPayload, EventContext, GateEntryPayload, ShiftStartPayload } from '@/types/offline';

const CTX_A: EventContext = { userId: GUARD_A, organisationId: ORG, siteId: SITE };
const CTX_B: EventContext = { userId: GUARD_B, organisationId: ORG, siteId: SITE };
const SHIFT_A = 'd1111111-2222-4333-8444-555555555555';
const SHIFT_B = 'd2222222-2222-4333-8444-555555555555';
const OTHER_SITE = '6a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

function shiftStart(shiftId: string): ShiftStartPayload {
  return { shiftId, shiftType: 'night', scheduledStart: '2026-09-30T16:00:00.000Z', scheduledEnd: '2026-10-01T04:00:00.000Z' };
}

function gatePayload(extra: Partial<GateEntryPayload> = {}): GateEntryPayload {
  return { shiftId: null, direction: 'in', licensePlate: 'CA 123-456', isDiscScanned: false, entryTime: '2026-09-30T18:00:00.000Z', ...extra };
}

function scan(shiftId: string, checkpointId: string, extra: Partial<CheckpointScanPayload> = {}): CheckpointScanPayload {
  return {
    shiftId,
    checkpointId,
    method: 'nfc',
    payloadType: 'nfc_uid',
    rawPayload: '04:a2:3b:1c:5d:80:00',
    latitude: -25.6841,
    longitude: 27.8145,
    accuracyMeters: 6,
    locationTimestamp: '2026-09-30T17:59:58.000Z',
    gpsError: null,
    ...extra
  };
}

function incidentPayload() {
  return {
    shiftId: SHIFT_A,
    incidentType: 'fence',
    severity: 'high' as const,
    description: 'Fence cut near the river camp',
    latitude: 0,
    longitude: 0,
    accuracyMeters: 0
  };
}

async function state(h: Harness, id: string) {
  const item = await h.db.syncQueue.get(id);
  assert.ok(item, `queue item ${id} exists`);
  return item;
}

const isUpsertTo = (table: string) => (call: RecordedCall) => call.kind === 'upsert' && call.table === table;
const isUpload = (call: RecordedCall) => call.kind === 'upload';

describe('backoff and error text', () => {
  it('backs off 1 s, 2 s, 4 s … capped at 60 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoffDelayMs), [0, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('gives each delivery a deadline that allows slow photo uploads', () => {
    assert.equal(deliveryDeadlineMs({ eventType: 'panic', mediaFields: [] }, []), 2 * REQUEST_TIMEOUT_MS + 5_000);
    assert.equal(
      deliveryDeadlineMs({ eventType: 'incident', mediaFields: ['photo', 'photo2'] }, [900_000, 1_000]),
      uploadTimeoutMs(900_000) + uploadTimeoutMs(1_000) + 4 * REQUEST_TIMEOUT_MS + 5_000
    );
  });

  it('never reports "[object Object]" for PostgREST-style errors', () => {
    assert.equal(describeError({ message: 'permission denied', code: '42501' }), 'permission denied (42501)');
    assert.equal(describeError(new Error('boom')), 'boom');
  });
});

describe('enqueue', () => {
  it('stores queue item, photo Blob and local event together', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg(100) }]);

    const item = await state(h, id);
    assert.equal(item.syncState, 'pending');
    assert.equal(item.userId, GUARD_A);
    assert.equal(item.organisationId, ORG);
    assert.deepEqual(item.mediaFields, ['photo']);
    const blobs = await h.db.mediaBlobs.where('queueItemId').equals(id).toArray();
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].data.size, 100);
    const local = await h.db.localEvents.get(id);
    assert.equal(local?.type, 'incident');
    assert.equal(local?.shiftId, SHIFT_A);
  });

  it('is atomic: when any write in the transaction fails nothing is stored', async () => {
    const h = createHarness();
    await assert.rejects(
      h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg() }], {
        additionalWrites: async () => {
          throw new Error('quota exceeded');
        }
      }),
      /quota exceeded/
    );
    assert.equal(await h.db.syncQueue.count(), 0);
    assert.equal(await h.db.mediaBlobs.count(), 0);
    assert.equal(await h.db.localEvents.count(), 0);
  });

  it('refuses unsyncable input instead of queueing it (non-UUID checkpoint id, bad media)', async () => {
    const h = createHarness();
    await assert.rejects(h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, 'CP1')), /checkpointId must be a UUID/);
    await assert.rejects(
      h.engine.enqueue('checkpoint_scan', CTX_A, scan('random-local-shift', CHECKPOINT_1)),
      /shiftId must be a UUID/
    );
    await assert.rejects(
      h.engine.enqueue('panic', CTX_A, { shiftId: null }, [{ field: 'photo', blob: jpeg() }]),
      /does not accept media/
    );
    await assert.rejects(
      h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: new Blob(['x'], { type: 'text/plain' }) }]),
      /unsupported type/
    );
    const gate = { shiftId: null, direction: 'in' as const, licensePlate: 'CA 1', isDiscScanned: true, entryTime: '2026-09-30T18:00:00.000Z' };
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, { ...gate, discExpiryDate: '2026-02-30' }), /real YYYY-MM-DD/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, { ...gate, entryTime: 'yesterday' }), /not a valid timestamp/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, { ...gate, licensePlate: '  ' }), /licence plate/);
    assert.equal(await h.db.syncQueue.count(), 0);
    await h.engine.enqueue('gate_entry', CTX_A, { ...gate, discExpiryDate: '2027-02-28' });
    assert.equal(await h.db.syncQueue.count(), 1);
  });

  it('refuses values the database would reject on every attempt (lengths, enum values, required fields)', async () => {
    const h = createHarness();
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ licensePlate: 'X'.repeat(51) })), /licensePlate is 51 characters long; at most 50/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ vehicleDescription: 'd'.repeat(121) })), /vehicleDescription/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ registerNumber: 'r'.repeat(51) })), /registerNumber/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ driverPhone: '0'.repeat(51) })), /driverPhone/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ direction: 'sideways' as 'in' })), /direction must be one of in, out/);
    await assert.rejects(h.engine.enqueue('gate_entry', CTX_A, gatePayload({ dwellDurationSeconds: 1.5 })), /whole number/);
    await assert.rejects(h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), incidentType: 'i'.repeat(101) }), /incidentType/);
    await assert.rejects(h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), incidentType: ' ' }), /needs payload.incidentType/);
    await assert.rejects(h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), severity: 'urgent' as 'high' }), /severity/);
    await assert.rejects(h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1, { method: 'bluetooth' as 'nfc' })), /method/);
    await assert.rejects(h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1, { gpsError: 'nope' as 'timeout' })), /gpsError/);
    await assert.rejects(
      h.engine.enqueue('shift_start', CTX_A, { ...shiftStart(SHIFT_A), shiftType: 'Day Shift' as 'day' }),
      /shiftType must be one of day, night, custom/
    );
    assert.equal(await h.db.syncQueue.count(), 0);

    // Limits count characters (as Postgres does), and the plate is stored trimmed.
    await h.engine.enqueue('gate_entry', CTX_A, gatePayload({ licensePlate: ' ' + 'Ü'.repeat(50) + ' ', vehicleDescription: 'd'.repeat(120) }));
    assert.equal(await h.db.syncQueue.count(), 1);
  });

  it('assigns strictly increasing sequence numbers', async () => {
    const h = createHarness();
    const a = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    const b = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    assert.ok((await state(h, b)).sequenceNumber > (await state(h, a)).sequenceNumber);
  });
});

describe('scan hash chain', () => {
  it('links each scan of a user to that user’s previous scan', async () => {
    const h = createHarness();
    const first = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    h.advance(60_000);
    const second = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_2, { method: 'qr', payloadType: 'secure_token', rawPayload: null }));
    await h.engine.enqueue('checkpoint_scan', CTX_B, scan(SHIFT_B, CHECKPOINT_1));

    const one = (await h.db.localEvents.get(first)) as LocalEventRecord;
    const two = (await h.db.localEvents.get(second)) as LocalEventRecord;
    assert.equal(one.prevHash, null);
    assert.match(one.hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(two.prevHash, one.hash);

    // The hash is sha256(prev + canonical JSON) of exactly what was recorded.
    const expected = await computeScanHash(
      one.hash ?? null,
      scanChainCore({ eventId: second, guardId: GUARD_A, scannedAt: two.createdAt, payload: two.payload as CheckpointScanPayload })
    );
    assert.equal(two.hash, expected);

    // Guard B's chain starts on its own.
    const bEvents = await h.db.localEvents.where('userId').equals(GUARD_B).toArray();
    assert.equal(bEvents[0].prevHash, null);

    // The queue payload carries the same values that go to patrol_scans.hash_chain.
    const queued = (await state(h, second)).payload as CheckpointScanPayload;
    assert.equal(queued.hashChain, two.hash);
    assert.equal(queued.prevHashChain, one.hash);

    const links = [one, two].map((event) => ({
      prevHash: event.prevHash ?? null,
      hash: event.hash as string,
      core: scanChainCore({ eventId: event.id, guardId: GUARD_A, scannedAt: event.createdAt, payload: event.payload as CheckpointScanPayload })
    }));
    assert.deepEqual(await verifyScanChain(links), { ok: true });
    links[0].core = { ...links[0].core, checkpointId: CHECKPOINT_2 };
    assert.deepEqual(await verifyScanChain(links), { ok: false, index: 0, reason: 'hash_mismatch' });
  });
});

describe('triggerSync', () => {
  it('sends only the signed-in user’s items; other users’ items stay queued and are counted', async () => {
    const h = createHarness({ sessionUserId: GUARD_A });
    const mine = await h.engine.enqueue('panic', CTX_A, { shiftId: null, latitude: -25.1, longitude: 27.2, accuracyMeters: 12 });
    const theirs = await h.engine.enqueue('panic', CTX_B, { shiftId: null });
    h.setOnline(true);

    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'completed');
    assert.equal(report.synced, 1);
    assert.equal((await state(h, mine)).syncState, 'synced');
    assert.equal((await state(h, theirs)).syncState, 'pending');
    const sent = h.supabase.callsOf('upsert', 'panic_alerts');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].row?.guard_id, GUARD_A);
    assert.equal(sent[0].row?.offline_uuid, mine);

    const summary = await h.engine.getSummary();
    assert.equal(summary.pendingCount, 0);
    assert.equal(summary.otherUserCount, 1);
    assert.ok(summary.lastSyncTimestamp);
    assert.equal(await h.engine.pendingCountForUser(GUARD_B), 1);
  });

  it('sends nothing without a session', async () => {
    const h = createHarness({ sessionUserId: null });
    const id = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    h.setOnline(true);
    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'no_session');
    assert.equal(h.supabase.calls.length, 0);
    assert.equal((await state(h, id)).syncState, 'pending');
  });

  it('does nothing while offline', async () => {
    const h = createHarness();
    await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    assert.equal((await h.engine.triggerSync()).status, 'offline');
    assert.equal(h.supabase.calls.length, 0);
  });

  it('resets items stuck in "syncing" by a closed tab and delivers them', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    await h.db.syncQueue.update(id, { syncState: 'syncing' });
    h.setOnline(true);
    await h.engine.triggerSync();
    assert.equal((await state(h, id)).syncState, 'synced');
  });

  it('writes immutable events with ON CONFLICT DO NOTHING on offline_uuid and stores storage PATHS', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue(
      'gate_entry',
      CTX_A,
      {
        shiftId: null,
        direction: 'in',
        licensePlate: ' CA 123-456 ',
        registerNumber: 'ABC123X',
        vehicleDescription: 'Hatch back',
        isDiscScanned: true,
        entryTime: '2026-09-30T18:00:00.000Z',
        latitude: -25.5,
        longitude: 27.5,
        accuracyMeters: 9
      },
      [{ field: 'photo', blob: jpeg() }]
    );
    h.setOnline(true);
    await h.engine.triggerSync();

    const [call] = h.supabase.callsOf('upsert', 'gate_entries');
    assert.deepEqual(call.options, { onConflict: 'offline_uuid', ignoreDuplicates: true });
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'vehicle', userId: GUARD_A, eventId: id, field: 'photo' });
    assert.equal(call.row?.vehicle_photo_url, path);
    assert.doesNotMatch(String(call.row?.vehicle_photo_url), /^https?:/);
    assert.equal(call.row?.license_plate, 'CA 123-456');
    assert.equal(call.row?.register_number, 'ABC123X');
    assert.equal(call.row?.accuracy_meters, 9);
    const [upload] = h.supabase.callsOf('upload');
    assert.equal(upload.path, path);
    assert.equal(upload.options?.upsert, false);
  });

  it('keeps zero values (0 m accuracy is not turned into NULL)', async () => {
    const h = createHarness();
    await h.engine.enqueue('incident', CTX_A, incidentPayload());
    h.setOnline(true);
    await h.engine.triggerSync();
    const [call] = h.supabase.callsOf('upsert', 'incidents');
    assert.equal(call.row?.latitude, 0);
    assert.equal(call.row?.accuracy_meters, 0);
  });

  it('upload failure: record not written, Blob kept, item not synced', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg() }]);
    h.supabase.failWhen(isUpload, RLS_ERROR);
    h.setOnline(true);

    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'stopped_on_failure');
    assert.equal(h.supabase.callsOf('upsert').length, 0);
    const item = await state(h, id);
    assert.equal(item.syncState, 'pending');
    assert.equal(item.retryCount, 1);
    assert.match(item.lastError ?? '', /Photo upload failed: new row violates row-level security policy/);
    assert.equal(await h.db.mediaBlobs.where('queueItemId').equals(id).count(), 1);
    assert.deepEqual(h.scheduledDelays, [1000]);
  });

  it('treats "resource already exists" on upload as success', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('shift_start', CTX_A, {
      shiftId: SHIFT_A,
      shiftType: 'night',
      scheduledStart: '2026-09-30T16:00:00.000Z',
      scheduledEnd: '2026-10-01T04:00:00.000Z'
    }, [{ field: 'selfie', blob: jpeg() }]);
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'selfie', userId: GUARD_A, eventId: id, field: 'selfie' });
    h.supabase.objects.set(`evidence-media/${path}`, { blob: jpeg() });
    h.setOnline(true);

    await h.engine.triggerSync();
    assert.equal((await state(h, id)).syncState, 'synced');
    const [shift] = h.supabase.rows('shifts');
    assert.equal(shift.id, SHIFT_A);
    assert.equal(shift.start_selfie_url, path);
    assert.equal(shift.status, 'active');
  });

  it('database failure after upload: retry reuses the same path, syncs once, deletes Blob only after success', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg() }, { field: 'photo2', blob: jpeg(80) }]);
    h.supabase.failWhen(isUpsertTo('incidents'), NETWORK_ERROR);
    h.setOnline(true);

    await h.engine.triggerSync();
    assert.equal((await state(h, id)).syncState, 'pending');
    assert.equal(h.supabase.rows('incidents').length, 0);
    assert.equal(await h.db.mediaBlobs.where('queueItemId').equals(id).count(), 2, 'Blobs kept after DB failure');

    const report = await h.engine.triggerSync({ force: true });
    assert.equal(report.status, 'completed');
    const uploads = h.supabase.callsOf('upload').map((call) => call.path);
    assert.equal(uploads.length, 4);
    assert.deepEqual(uploads.slice(2), uploads.slice(0, 2), 'retry uses identical object paths');
    assert.equal(h.supabase.objects.size, 2);
    assert.equal(h.supabase.rows('incidents').length, 1);
    const media = h.supabase.rows('incident_media');
    assert.equal(media.length, 2);
    assert.deepEqual(media.map((row) => row.media_url).sort(), [...new Set(uploads)].sort());
    assert.equal((await state(h, id)).syncState, 'synced');
    assert.equal(await h.db.mediaBlobs.where('queueItemId').equals(id).count(), 0, 'Blobs deleted after success');
  });

  it('replay after a lost response does not duplicate rows (incident + photo links)', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg() }]);
    // The server committed the photo link but the response never arrived.
    h.supabase.failWhen(isUpsertTo('incident_media'), NETWORK_ERROR, { when: 'after' });
    h.setOnline(true);
    await h.engine.triggerSync();
    assert.equal((await state(h, id)).syncState, 'pending');

    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, id)).syncState, 'synced');
    assert.equal(h.supabase.rows('incidents').length, 1);
    assert.equal(h.supabase.rows('incident_media').length, 1);
    const linkCalls = h.supabase.callsOf('upsert', 'incident_media');
    assert.equal(linkCalls.length, 2);
    assert.equal(linkCalls[0].row?.id, linkCalls[1].row?.id, 'deterministic link id');
    assert.deepEqual(linkCalls[0].options, { onConflict: 'id', ignoreDuplicates: true });
  });

  it('shift_end matching 0 rows is a failure, not a success (Blob kept)', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('shift_end', CTX_A, { shiftId: SHIFT_A }, [{ field: 'selfie', blob: jpeg() }]);
    h.setOnline(true);
    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'stopped_on_failure');
    const item = await state(h, id);
    assert.equal(item.syncState, 'pending');
    assert.equal(item.rejectionCount, 1);
    assert.match(item.lastError ?? '', /Clock-out not saved/);
    assert.equal(await h.db.mediaBlobs.where('queueItemId').equals(id).count(), 1);
    const [update] = h.supabase.callsOf('update', 'shifts');
    assert.deepEqual(
      update.filters?.map((f) => `${f.op}:${f.column}`),
      ['eq:id', 'eq:guard_id', 'is:actual_end']
    );
  });

  it('shift start → scan → end: all rows reference the same shift id and clock-out applies once', async () => {
    const h = createHarness();
    await h.engine.enqueue('shift_start', CTX_A, {
      shiftId: SHIFT_A,
      shiftType: 'night',
      scheduledStart: '2026-09-30T16:00:00.000Z',
      scheduledEnd: '2026-10-01T04:00:00.000Z',
      latitude: -25.6,
      longitude: 27.8,
      accuracyMeters: 7
    });
    const scanId = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    h.advance(3_600_000);
    const endId = await h.engine.enqueue('shift_end', CTX_A, { shiftId: SHIFT_A, latitude: -25.61, longitude: 27.81, accuracyMeters: 5 });
    // Clock-out applied on the server but the response was lost.
    h.supabase.failWhen((call) => call.kind === 'update', NETWORK_ERROR, { when: 'after' });
    h.setOnline(true);

    await h.engine.triggerSync();
    assert.equal((await state(h, endId)).syncState, 'pending');
    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, endId)).syncState, 'synced', 'replay recognised the clock-out already applied');

    const [shift] = h.supabase.rows('shifts');
    assert.equal(shift.status, 'completed');
    assert.equal(shift.end_accuracy_meters, 5);
    const [scanRow] = h.supabase.rows('patrol_scans');
    assert.equal(scanRow.shift_id, SHIFT_A);
    assert.equal(scanRow.id, scanId);
    assert.equal(scanRow.payload_type, 'nfc_uid');
    assert.equal(scanRow.gps_error, null);
    assert.equal(scanRow.location_timestamp, '2026-09-30T17:59:58.000Z');
  });

  it('a record the server rejects does not block unrelated records; scans still wait for their clock-in', async () => {
    const h = createHarness();
    const start = await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    const scanId = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    const unrelated = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null });
    h.supabase.failWhen(isUpsertTo('shifts'), RLS_ERROR);
    h.setOnline(true);

    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'stopped_on_failure');
    assert.equal(report.failedItemId, start);
    assert.equal((await state(h, unrelated)).syncState, 'synced', 'unrelated incident delivered despite the rejection');
    const waiting = await state(h, scanId);
    assert.equal(waiting.syncState, 'pending');
    assert.equal(waiting.retryCount, 0, 'the scan was not attempted before its clock-in');
    assert.equal(h.supabase.callsOf('upsert', 'patrol_scans').length, 0);

    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, start)).syncState, 'synced');
    assert.equal((await state(h, scanId)).syncState, 'synced');
    const order = h.supabase.callsOf('upsert').map((call) => call.table);
    assert.ok(order.lastIndexOf('shifts') < order.indexOf('patrol_scans'), 'clock-in reached the server before its scan');
  });

  it('a photo that will not upload on a weak link does not hold back records without photos', async () => {
    const h = createHarness();
    const big = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null }, [{ field: 'photo', blob: jpeg(900_000) }]);
    const gateIn = await h.engine.enqueue('gate_entry', CTX_A, gatePayload());
    const withPhoto = await h.engine.enqueue('gate_entry', CTX_A, gatePayload({ licensePlate: 'ND 22' }), [{ field: 'photo', blob: jpeg() }]);
    const small = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null });
    h.supabase.failWhen(isUpload, NETWORK_ERROR);
    h.setOnline(true);

    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'stopped_on_failure');
    assert.equal(report.failedItemId, big);
    const failed = await state(h, big);
    assert.equal(failed.syncState, 'pending');
    assert.equal(failed.rejectionCount, 0, 'network failures never count toward dead-lettering');
    assert.equal((await state(h, gateIn)).syncState, 'synced');
    assert.equal((await state(h, small)).syncState, 'synced');
    // Other photos are not tried on a link that just failed an upload (each could take minutes).
    assert.equal(h.supabase.callsOf('upload').length, 1);
    assert.equal((await state(h, withPhoto)).retryCount, 0);

    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, big)).syncState, 'synced');
    assert.equal((await state(h, withPhoto)).syncState, 'synced');
  });

  it('when even a small record cannot reach the server the pass stops and the whole queue backs off', async () => {
    const h = createHarness();
    const first = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null });
    const second = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null });
    h.supabase.failWhen(isUpsertTo('incidents'), NETWORK_ERROR);
    h.setOnline(true);

    const report = await h.engine.triggerSync();
    assert.equal(report.status, 'stopped_on_failure');
    assert.equal(h.supabase.callsOf('upsert').length, 1, 'no point trying the rest while the server is unreachable');
    assert.equal((await state(h, second)).retryCount, 0);
    assert.deepEqual(h.scheduledDelays.slice(-1), [BACKOFF_BASE_MS]);

    assert.equal((await h.engine.triggerSync()).status, 'waiting_backoff', 'automatic pass waits for the queue backoff');
    assert.equal(h.supabase.callsOf('upsert').length, 1);
    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, first)).syncState, 'synced');
    assert.equal((await state(h, second)).syncState, 'synced');
  });

  it('automatic passes respect an item’s backoff; a manual (forced) pass does not', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('incident', CTX_A, incidentPayload());
    h.supabase.failWhen(isUpsertTo('incidents'), RLS_ERROR, { times: 2 });
    h.setOnline(true);
    await h.engine.triggerSync();
    assert.equal((await h.engine.triggerSync()).status, 'waiting_backoff');
    assert.equal(h.supabase.callsOf('upsert').length, 1);
    await h.engine.triggerSync({ force: true });
    assert.equal(h.supabase.callsOf('upsert').length, 2);
    h.advance(backoffDelayMs(2));
    await h.engine.triggerSync();
    assert.equal((await state(h, id)).syncState, 'synced');
  });

  it(`dead-letters after ${MAX_REJECTIONS} server rejections; retryFailed re-queues it`, async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    h.supabase.failWhen(isUpsertTo('panic_alerts'), RLS_ERROR, { times: MAX_REJECTIONS });
    h.setOnline(true);

    for (let attempt = 1; attempt <= MAX_REJECTIONS; attempt += 1) {
      await h.engine.triggerSync({ force: true });
      const item = await state(h, id);
      assert.equal(item.syncState, attempt < MAX_REJECTIONS ? 'pending' : 'failed', `attempt ${attempt}`);
    }
    const dead = await state(h, id);
    assert.equal(dead.rejectionCount, MAX_REJECTIONS);
    assert.match(dead.lastError ?? '', /row-level security/);
    assert.equal((await h.engine.triggerSync({ force: true })).synced, 0, 'dead-lettered items are skipped');
    const summary = await h.engine.getSummary();
    assert.equal(summary.failedCount, 1);
    assert.match(summary.lastError ?? '', /row-level security/);

    assert.equal(await h.engine.retryFailed(GUARD_A), 1);
    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, id)).syncState, 'synced');
    assert.equal(await h.db.syncQueue.count(), 1, 'nothing was ever deleted');
  });

  it('parks items of a shift whose clock-in was dead-lettered, keeps other items flowing, re-queues them together', async () => {
    const h = createHarness();
    const start = await h.engine.enqueue('shift_start', CTX_A, {
      shiftId: SHIFT_A,
      shiftType: 'night',
      scheduledStart: '2026-09-30T16:00:00.000Z',
      scheduledEnd: '2026-10-01T04:00:00.000Z'
    });
    const scanId = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    const unrelated = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null });
    // e.g. the guard is not assigned to this site yet.
    h.supabase.failWhen(isUpsertTo('shifts'), RLS_ERROR, { times: MAX_REJECTIONS });
    h.setOnline(true);
    for (let attempt = 0; attempt < MAX_REJECTIONS; attempt += 1) await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, start)).syncState, 'failed');

    await h.engine.triggerSync({ force: true });
    const parked = await state(h, scanId);
    assert.equal(parked.syncState, 'failed');
    assert.match(parked.lastError ?? '', /clock-in of this shift was rejected/);
    assert.equal(h.supabase.callsOf('upsert', 'patrol_scans').length, 0, 'no pointless attempts');
    assert.equal((await state(h, unrelated)).syncState, 'synced');

    // Admin fixes the assignment; the guard taps "retry": clock-in first, then its scan.
    assert.equal(await h.engine.retryFailed(GUARD_A), 2);
    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, start)).syncState, 'synced');
    assert.equal((await state(h, scanId)).syncState, 'synced');
  });

  it('network failures back off but never dead-letter', async () => {
    const h = createHarness();
    const id = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    h.supabase.failWhen(isUpsertTo('panic_alerts'), NETWORK_ERROR, { times: MAX_REJECTIONS + 4 });
    h.setOnline(true);
    for (let attempt = 0; attempt < MAX_REJECTIONS + 4; attempt += 1) await h.engine.triggerSync({ force: true });
    const item = await state(h, id);
    assert.equal(item.syncState, 'pending');
    assert.equal(item.rejectionCount, 0);
    assert.equal(item.retryCount, MAX_REJECTIONS + 4);
    assert.equal(h.scheduledDelays.at(-1), 60_000);
  });

  it('concurrent triggerSync calls deliver each item exactly once (in-tab)', async () => {
    const h = createHarness({ locks: null });
    for (let i = 0; i < 5; i += 1) await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    h.setOnline(true);
    await Promise.all([h.engine.triggerSync(), h.engine.triggerSync(), h.engine.triggerSync()]);
    assert.equal(h.supabase.callsOf('upsert', 'panic_alerts').length, 5);
    assert.equal(h.supabase.rows('panic_alerts').length, 5);
  });

  it('two engines on one database (two tabs) with Web Locks deliver each item exactly once', async () => {
    const webLocks = (globalThis.navigator as Navigator & { locks?: LockManager }).locks;
    assert.ok(webLocks, 'Node provides navigator.locks');
    const locks = webLocks as unknown as LockManagerLike;
    const h = createHarness({ locks });
    const secondTab = new OfflineSyncEngine({
      db: h.db,
      getSupabase: () => h.supabase.client,
      locks,
      isOnline: () => true,
      sleep: () => new Promise<void>(() => undefined)
    });
    for (let i = 0; i < 4; i += 1) await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    h.setOnline(true);
    const reports = await Promise.all([h.engine.triggerSync(), secondTab.triggerSync()]);
    assert.ok(reports.some((report) => report.status === 'busy_elsewhere' || report.synced === 0));
    // Whichever tab lost the lock retries later; run once more to drain anything it skipped.
    await h.engine.triggerSync();
    assert.equal(h.supabase.callsOf('upsert', 'panic_alerts').length, 4);
    assert.equal(await h.db.syncQueue.where('syncState').equals('synced').count(), 4);
  });

  it('gate OUT waits for its IN, and goes without the link when the IN is dead-lettered', async () => {
    const h = createHarness();
    const inId = await h.engine.enqueue('gate_entry', CTX_A, gatePayload());
    const outId = await h.engine.enqueue('gate_entry', CTX_A, gatePayload({ direction: 'out', exitTime: '2026-09-30T19:00:00.000Z', linkedEntryId: inId }));
    h.supabase.failWhen((call) => call.kind === 'upsert' && call.row?.id === inId, RLS_ERROR, { times: MAX_REJECTIONS });
    h.setOnline(true);

    await h.engine.triggerSync();
    assert.equal((await state(h, outId)).retryCount, 0, 'OUT not attempted while its IN is pending');
    for (let attempt = 1; attempt < MAX_REJECTIONS; attempt += 1) await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, inId)).syncState, 'failed');
    await h.engine.triggerSync({ force: true });
    const out = await state(h, outId);
    assert.equal(out.syncState, 'synced');
    assert.deepEqual(out.droppedLinks, ['linked_entry_id']);
    const [row] = h.supabase.rows('gate_entries');
    assert.equal(row.id, outId);
    assert.equal(row.linked_entry_id, null);
  });
});

describe('SOS (panic) delivery', () => {
  it('panics go first; one whose clock-in has not reached the server goes without the shift link', async () => {
    const h = createHarness();
    await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    const panicId = await h.engine.enqueue('panic', CTX_A, { shiftId: SHIFT_A, latitude: -25.1, longitude: 27.2, accuracyMeters: 9 });
    h.setOnline(true);
    await h.engine.triggerSync();

    const order = h.supabase.callsOf('upsert').map((call) => call.table);
    assert.deepEqual(order, ['panic_alerts', 'shifts', 'patrol_scans']);
    const [panic] = h.supabase.rows('panic_alerts');
    assert.equal(panic.shift_id, null);
    assert.equal(panic.guard_id, GUARD_A);
    assert.equal(panic.latitude, -25.1);
    assert.deepEqual((await state(h, panicId)).droppedLinks, ['shift_id']);
    assert.equal((await h.db.localEvents.get(panicId))?.shiftId, SHIFT_A, 'the device keeps the shift link');
  });

  it('a panic keeps its shift link when the clock-in has already synced', async () => {
    const h = createHarness();
    await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    h.setOnline(true);
    await h.engine.triggerSync();
    h.setOnline(false);
    const panicId = await h.engine.enqueue('panic', CTX_A, { shiftId: SHIFT_A });
    h.setOnline(true);
    await h.engine.triggerSync();
    assert.equal(h.supabase.rows('panic_alerts')[0].shift_id, SHIFT_A);
    assert.equal((await state(h, panicId)).droppedLinks, undefined);
  });

  it('is sent while the clock-in selfie keeps failing to upload (weak signal)', async () => {
    const h = createHarness();
    const start = await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A), [{ field: 'selfie', blob: jpeg(400_000) }]);
    const panicId = await h.engine.enqueue('panic', CTX_A, { shiftId: SHIFT_A, latitude: -25.1, longitude: 27.1, accuracyMeters: 8 });
    h.supabase.failWhen(isUpload, NETWORK_ERROR, { times: 50 });
    h.setOnline(true);

    await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, panicId)).syncState, 'synced');
    assert.equal(h.supabase.rows('panic_alerts').length, 1);
    const clockIn = await state(h, start);
    assert.equal(clockIn.syncState, 'pending');
    assert.match(clockIn.lastError ?? '', /Photo upload failed/);
  });

  it('is never parked behind a clock-in the server rejects; incidents go without the link, scans are parked', async () => {
    const h = createHarness();
    const start = await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    const early = await h.engine.enqueue('panic', CTX_A, { shiftId: SHIFT_A });
    // e.g. the phone clock is more than 10 minutes fast (shifts_before_insert).
    h.supabase.failWhen(
      isUpsertTo('shifts'),
      { message: 'Shift start time 2026-09-30T18:15:00Z is in the future', code: '23514' },
      { status: 400, times: 1000 }
    );
    h.setOnline(true);
    for (let attempt = 0; attempt < MAX_REJECTIONS + 2; attempt += 1) await h.engine.triggerSync({ force: true });
    assert.equal((await state(h, start)).syncState, 'failed');
    assert.equal((await state(h, early)).syncState, 'synced', 'the SOS went out in the very first pass');

    h.setOnline(false);
    const late = await h.engine.enqueue('panic', CTX_A, { shiftId: SHIFT_A });
    const incidentId = await h.engine.enqueue('incident', CTX_A, incidentPayload());
    const scanId = await h.engine.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));
    h.setOnline(true);
    await h.engine.triggerSync();

    assert.equal((await state(h, late)).syncState, 'synced', 'not parked');
    assert.equal(h.supabase.rows('panic_alerts').length, 2);
    assert.ok(h.supabase.rows('panic_alerts').every((row) => row.shift_id === null));
    const incident = await state(h, incidentId);
    assert.equal(incident.syncState, 'synced');
    assert.deepEqual(incident.droppedLinks, ['shift_id']);
    assert.equal(h.supabase.rows('incidents')[0].shift_id, null);
    const parked = await state(h, scanId);
    assert.equal(parked.syncState, 'failed');
    assert.equal(parked.lastError, PARKED_BEHIND_REJECTED_CLOCK_IN);
  });

  it('goes without a shift link that belongs to another site (RLS would refuse it forever)', async () => {
    const h = createHarness();
    await h.engine.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    h.setOnline(true);
    await h.engine.triggerSync();
    await h.engine.enqueue('panic', { ...CTX_A, siteId: OTHER_SITE }, { shiftId: SHIFT_A });
    await h.engine.sendPanicsNow();
    const [panic] = h.supabase.rows('panic_alerts');
    assert.equal(panic.site_id, OTHER_SITE);
    assert.equal(panic.shift_id, null);
  });

  it('a request that never answers cannot freeze syncing: the SOS still goes out and the stuck delivery ends at its deadline', async () => {
    const h = createHarness();
    const incidentId = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null }, [{ field: 'photo', blob: jpeg(900_000) }]);
    const held = h.supabase.holdWhen(isUpload); // never released: a black-holed request
    h.setOnline(true);
    const stuck = h.engine.triggerSync({ force: true });
    await held.reached;

    const panicId = await h.engine.enqueue('panic', CTX_A, { shiftId: null, latitude: -25, longitude: 27, accuracyMeters: 5 });
    await h.engine.sendPanicsNow();
    assert.equal((await state(h, panicId)).syncState, 'synced', 'SOS delivered while the upload hangs');
    assert.equal(h.supabase.rows('panic_alerts').length, 1);

    assert.ok(h.deadlines.requestedMs[0] >= uploadTimeoutMs(900_000), 'upload deadline allows a slow link');
    assert.equal(h.deadlines.expireAll(), 1, 'only the stuck delivery was still running');
    await stuck;
    const incident = await state(h, incidentId);
    assert.equal(incident.syncState, 'pending');
    assert.equal(incident.rejectionCount, 0);
    assert.match(incident.lastError ?? '', /No answer from the server/);
    assert.equal((await h.engine.triggerSync()).status, 'waiting_backoff', 'the engine is free again');
  });

  it('a sync request made during a pass that then fails gets its own pass (nothing waits for the failed item’s backoff)', async () => {
    const h = createHarness();
    const incidentId = await h.engine.enqueue('incident', CTX_A, { ...incidentPayload(), shiftId: null }, [{ field: 'photo', blob: jpeg() }]);
    await h.db.syncQueue.update(incidentId, { retryCount: 6 });
    const held = h.supabase.holdWhen(isUpload);
    h.supabase.failWhen(isUpload, NETWORK_ERROR);
    h.setOnline(true);
    const pass = h.engine.triggerSync();
    await held.reached;

    const panicId = await h.engine.enqueue('panic', CTX_A, { shiftId: null });
    const gateId = await h.engine.enqueue('gate_entry', CTX_A, gatePayload());
    await h.engine.sendPanicsNow();
    assert.equal((await state(h, panicId)).syncState, 'synced', 'SOS did not wait for the slow pass');
    held.release();
    await pass;
    assert.equal((await state(h, incidentId)).syncState, 'pending');
    assert.equal((await state(h, gateId)).syncState, 'synced', 'the request made mid-pass got its own pass');
  });
});

describe('sequence numbers and the scan chain across reloads, tabs and clock steps', () => {
  function engineOn(db: EagleEyeOfflineDB, supabase: FakeSupabase, clock: { t: number }, online: { v: boolean }) {
    return new OfflineSyncEngine({
      db,
      getSupabase: () => supabase.client,
      locks: null,
      isOnline: () => online.v,
      now: () => clock.t,
      sleep: () => new Promise<void>(() => undefined),
      checkStorage: async () => ({ persisted: true, usageBytes: null, quotaBytes: null, nearlyFull: false })
    });
  }

  async function chainLinks(db: EagleEyeOfflineDB) {
    const scans = (await db.localEvents.where('type').equals('checkpoint_scan').toArray()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    return scans.map((event) => ({
      prevHash: event.prevHash ?? null,
      hash: event.hash as string,
      core: scanChainCore({ eventId: event.id, guardId: event.userId, scannedAt: event.createdAt, payload: event.payload as CheckpointScanPayload })
    }));
  }

  it('a reload after the clock stepped back still orders scans after their clock-in and keeps the chain linear', async () => {
    const db = createTestDb();
    const supabase = new FakeSupabase(GUARD_A);
    const clock = { t: Date.parse('2026-09-30T19:00:00.000Z') };
    const online = { v: false };
    const firstLoad = engineOn(db, supabase, clock, online);
    const start = await firstLoad.enqueue('shift_start', CTX_A, shiftStart(SHIFT_A));
    clock.t += 60_000;
    const scan1 = await firstLoad.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));

    clock.t -= 3_600_000; // network time corrects a clock that was 1 h fast; the page reloads
    const reloaded = engineOn(db, supabase, clock, online);
    const scan2 = await reloaded.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_2));
    clock.t += 30_000;
    const scan3 = await reloaded.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1));

    const ordered = (await db.syncQueue.toArray()).sort((a, b) => a.sequenceNumber - b.sequenceNumber).map((item) => item.id);
    assert.deepEqual(ordered, [start, scan1, scan2, scan3]);
    assert.equal((await db.localEvents.get(scan2))?.prevHash, (await db.localEvents.get(scan1))?.hash);
    assert.equal((await db.localEvents.get(scan3))?.prevHash, (await db.localEvents.get(scan2))?.hash);
    assert.deepEqual(await verifyScanChain(await chainLinks(db)), { ok: true });

    online.v = true;
    await reloaded.triggerSync();
    assert.deepEqual(
      supabase.callsOf('upsert').map((call) => call.table),
      ['shifts', 'patrol_scans', 'patrol_scans', 'patrol_scans']
    );
  });

  it('two tabs without Web Locks enqueueing in the same millisecond get distinct numbers and one linear chain', async () => {
    const db = createTestDb();
    const supabase = new FakeSupabase(GUARD_A);
    const clock = { t: Date.parse('2026-09-30T18:00:00.000Z') };
    const online = { v: false };
    const tabA = engineOn(db, supabase, clock, online);
    const tabB = engineOn(db, supabase, clock, online);
    await Promise.all([
      tabA.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1)),
      tabB.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_2)),
      tabA.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_2)),
      tabB.enqueue('checkpoint_scan', CTX_A, scan(SHIFT_A, CHECKPOINT_1))
    ]);
    const numbers = (await db.syncQueue.toArray()).map((item) => item.sequenceNumber);
    assert.equal(new Set(numbers).size, 4);
    const links = await chainLinks(db);
    assert.equal(links[0].prevHash, null);
    assert.deepEqual(await verifyScanChain(links), { ok: true });
  });
});

describe('device storage', () => {
  it('asks for persistent storage and reports eviction risk and a nearly full quota', async () => {
    const calls: string[] = [];
    const manager: StorageManagerLike = {
      persisted: async () => {
        calls.push('persisted');
        return false;
      },
      persist: async () => {
        calls.push('persist');
        return true;
      },
      estimate: async () => ({ usage: 90, quota: 100 })
    };
    assert.deepEqual(await checkDeviceStorage({ storage: manager }), { persisted: false, usageBytes: 90, quotaBytes: 100, nearlyFull: true });
    assert.deepEqual(calls, ['persisted'], 'no request unless asked');
    assert.equal((await checkDeviceStorage({ storage: manager, requestPersistence: true })).persisted, true);
    assert.deepEqual(await checkDeviceStorage({ storage: null }), { persisted: null, usageBytes: null, quotaBytes: null, nearlyFull: false });
    const broken: StorageManagerLike = { persisted: async () => Promise.reject(new Error('denied')) };
    assert.equal((await checkDeviceStorage({ storage: broken })).persisted, null);
  });

  it('asks for persistence once, on the first recorded event, then only refreshes the estimate after photos', async () => {
    const requests: boolean[] = [];
    const engine = new OfflineSyncEngine({
      db: createTestDb(),
      getSupabase: () => new FakeSupabase(GUARD_A).client,
      locks: null,
      isOnline: () => false,
      checkStorage: async (requestPersistence) => {
        requests.push(requestPersistence);
        return { persisted: false, usageBytes: 10, quotaBytes: 100, nearlyFull: false };
      }
    });
    await engine.enqueue('panic', CTX_A, { shiftId: null });
    await engine.enqueue('panic', CTX_A, { shiftId: null });
    await engine.enqueue('incident', CTX_A, incidentPayload(), [{ field: 'photo', blob: jpeg() }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(requests, [true, false]);
    assert.equal((await engine.getSummary()).storage?.persisted, false, 'eviction risk is visible to the UI');
  });

  it('the sync summary carries the storage status', async () => {
    const h = createHarness();
    await h.engine.refreshStorageStatus(true);
    assert.deepEqual((await h.engine.getSummary()).storage, { persisted: true, usageBytes: 1_000, quotaBytes: 1_000_000, nearlyFull: false });
  });
});

describe('database upgrade v1 → v2', () => {
  it('keeps v1 queue items and marks placeholder-identity items as unattributable', async () => {
    const indexedDB = new IDBFactory();
    const name = `legacy-${globalThis.crypto.randomUUID()}`;
    const v1 = new Dexie(name, { indexedDB, IDBKeyRange });
    v1.version(1).stores({
      syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt',
      checkpoints: 'id, siteId, qrCodeHash, nfcUid, isActive',
      shifts: 'id, siteId, guardId, status',
      scans: 'id, offlineUuid, shiftId, checkpointId, guardId, scanTimestampDevice',
      incidents: 'id, offlineUuid, siteId, shiftId, guardId, status',
      gateEntries: 'id, offlineUuid, siteId, direction, licensePlate, entryTime',
      mediaBlobs: 'id, queueItemId, field'
    });
    await v1.table('syncQueue').add({
      id: 'legacy-1',
      sequenceNumber: 1,
      userId: '55555555-5555-5555-5555-555555555555',
      siteId: '22222222-2222-2222-2222-222222222222',
      eventType: 'checkpoint_scan',
      payload: { checkpointId: 'CP1' },
      deviceTimestamp: '2026-09-01T00:00:00.000Z',
      syncState: 'pending',
      retryCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z'
    });
    v1.close();

    const db = new EagleEyeOfflineDB(name, { indexedDB, IDBKeyRange });
    const item = await db.syncQueue.get('legacy-1');
    assert.equal(item?.syncState, 'failed');
    assert.equal(item?.lastError, LEGACY_UNATTRIBUTED_ERROR);
    assert.equal(item?.rejectionCount, 0);
    assert.equal(await db.localEvents.count(), 0);
  });
});
