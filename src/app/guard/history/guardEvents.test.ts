import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { EagleEyeOfflineDB, activeShiftKey, type LocalEventRecord } from '@/lib/offline/db';
import type { OfflineQueueItem, OfflinePayload, OfflineEventType, SyncState } from '@/types/offline';
import { translations, type TranslationKey } from '@/lib/i18n/translations';
import {
  buildGuardEventsCsv,
  csvCell,
  describeGuardEvent,
  gpsSummary,
  loadGuardEvents,
  loadGuardShifts,
  readableSyncError,
  shiftOptionLabel,
  SYNC_ERROR_MAX_LENGTH,
  syncStateView,
  type GuardEventRow
} from './guardEvents';

/** The real English dictionary (same lookup as the app). */
function t(key: TranslationKey, ...args: (string | number)[]): string {
  let text = (translations.en as Record<string, string>)[key] ?? key;
  args.forEach((arg, index) => {
    text = text.split(`{${index}}`).join(String(arg));
  });
  return text;
}

const GUARD = '0f6c1f64-2d5b-4c47-9a53-4b2b0a2d7a11';
const OTHER = '6d0cf3a1-8f53-4c1b-8c1e-1f0e3d1c9b22';
const ORG = '1e1f7a9c-7b1d-4f6e-9f10-2a3b4c5d6e7f';
const SITE = '2a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const SHIFT_A = '3b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';
const SHIFT_B = '4c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f';

let seq = 1_000_000;
function event(
  id: string,
  userId: string,
  type: OfflineEventType,
  shiftId: string | null,
  payload: Record<string, unknown>,
  createdAt: string,
  mediaFields: string[] = []
): LocalEventRecord {
  seq += 1;
  return {
    id,
    userId,
    organisationId: ORG,
    siteId: SITE,
    shiftId,
    type,
    sequenceNumber: seq,
    createdAt,
    payload: payload as unknown as OfflinePayload,
    mediaFields
  };
}

function queueItem(local: LocalEventRecord, syncState: SyncState, lastError?: string): OfflineQueueItem {
  return {
    id: local.id,
    sequenceNumber: local.sequenceNumber,
    userId: local.userId,
    organisationId: local.organisationId,
    siteId: local.siteId,
    eventType: local.type,
    payload: local.payload,
    mediaFields: local.mediaFields,
    deviceTimestamp: local.createdAt,
    syncState,
    retryCount: 0,
    rejectionCount: 0,
    createdAt: local.createdAt,
    ...(lastError ? { lastError } : {})
  };
}

const dbs: EagleEyeOfflineDB[] = [];
async function seededDb() {
  const db = new EagleEyeOfflineDB(`guard-events-${globalThis.crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange
  });
  dbs.push(db);
  const startA = event('a1', GUARD, 'shift_start', SHIFT_A, {
    shiftId: SHIFT_A,
    shiftType: 'night',
    scheduledStart: '2026-09-28T16:00:00.000Z',
    scheduledEnd: '2026-09-29T04:00:00.000Z',
    latitude: -25.1,
    longitude: 28.2,
    accuracyMeters: 12
  }, '2026-09-28T15:55:00.000Z', ['selfie']);
  const scanA = event('a2', GUARD, 'checkpoint_scan', SHIFT_A, {
    shiftId: SHIFT_A,
    checkpointId: 'cp1',
    checkpointName: 'Gate #2 "north"',
    method: 'nfc',
    payloadType: 'nfc_uid',
    gpsConfidence: 'verified',
    distanceToCheckpointMeters: 0,
    accuracyMeters: 4,
    latitude: -25.1001,
    longitude: 28.2001
  }, '2026-09-28T17:00:00.000Z');
  const otherUsers = event('x1', OTHER, 'incident', SHIFT_A, {
    shiftId: SHIFT_A,
    incidentType: 'fence',
    severity: 'high',
    description: 'not mine'
  }, '2026-09-28T17:30:00.000Z');
  const startB = event('b1', GUARD, 'shift_start', SHIFT_B, {
    shiftId: SHIFT_B,
    shiftType: 'day',
    scheduledStart: '2026-09-30T04:00:00.000Z',
    scheduledEnd: '2026-09-30T16:00:00.000Z',
    gpsError: 'permission_denied'
  }, '2026-09-30T03:58:00.000Z');
  const incidentB = event('b2', GUARD, 'incident', SHIFT_B, {
    shiftId: SHIFT_B,
    incidentType: 'fence',
    severity: 'high',
    description: '=HYPERLINK("http://evil")'
  }, '2026-09-30T06:10:00.000Z', ['photo']);
  const panicNoShift = event('c1', GUARD, 'panic', null, { shiftId: null }, '2026-09-30T07:00:00.000Z');

  await db.localEvents.bulkAdd([startA, scanA, otherUsers, startB, incidentB, panicNoShift]);
  await db.syncQueue.bulkAdd([
    queueItem(startA, 'synced'),
    queueItem(scanA, 'failed', 'Scan outside the shift window'),
    queueItem(otherUsers, 'pending'),
    queueItem(startB, 'pending'),
    queueItem(incidentB, 'syncing')
    // c1 has no queue item on this phone: state must be reported as unknown, never "uploaded".
  ]);
  await db.guardState.put({
    kind: 'activeShift',
    key: activeShiftKey(GUARD),
    userId: GUARD,
    organisationId: ORG,
    siteId: SITE,
    shiftId: SHIFT_B,
    shiftType: 'day',
    scheduledStart: '2026-09-30T04:00:00.000Z',
    scheduledEnd: '2026-09-30T16:00:00.000Z',
    startedAt: '2026-09-30T03:58:00.000Z',
    startEventId: 'b1',
    startLatitude: null,
    startLongitude: null,
    startAccuracyMeters: null
  });
  return db;
}

after(() => {
  dbs.forEach((db) => db.close());
});

describe('loadGuardEvents', () => {
  it('returns only this guard’s records, newest first, with the real upload state', async () => {
    const db = await seededDb();
    const rows = await loadGuardEvents(db, GUARD, { kind: 'all' });
    assert.deepEqual(
      rows.map((row) => row.event.id),
      ['c1', 'b2', 'b1', 'a2', 'a1']
    );
    assert.deepEqual(
      rows.map((row) => row.syncState),
      ['unknown', 'syncing', 'pending', 'failed', 'synced']
    );
    assert.equal(rows[3].lastError, 'Scan outside the shift window');
    assert.ok(rows.every((row) => row.event.userId === GUARD));
  });

  it('filters by shift and never mixes in another account’s records of that shift', async () => {
    const db = await seededDb();
    const rows = await loadGuardEvents(db, GUARD, { kind: 'shift', shiftId: SHIFT_A });
    assert.deepEqual(
      rows.map((row) => row.event.id),
      ['a2', 'a1']
    );
  });

  it('honours the limit and returns nothing without a user', async () => {
    const db = await seededDb();
    assert.equal((await loadGuardEvents(db, GUARD, { kind: 'all' }, 2)).length, 2);
    assert.deepEqual(await loadGuardEvents(db, '', { kind: 'all' }), []);
  });

  it('reads every record when the limit is unbounded (CSV export) instead of passing it to IndexedDB', async () => {
    // Chrome rejects getAll(count > 2^32-1) with "Value is outside the 'unsigned long' value range"
    // (seen in the browser run: the export used Number.MAX_SAFE_INTEGER).
    const db = await seededDb();
    for (const limit of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2 ** 32]) {
      assert.deepEqual(
        (await loadGuardEvents(db, GUARD, { kind: 'all' }, limit)).map((row) => row.event.id),
        ['c1', 'b2', 'b1', 'a2', 'a1']
      );
      assert.equal((await loadGuardEvents(db, GUARD, { kind: 'shift', shiftId: SHIFT_B }, limit)).length, 2);
    }
  });
});

describe('loadGuardShifts', () => {
  it('lists this guard’s clock-ins newest first and marks the open one', async () => {
    const db = await seededDb();
    const shifts = await loadGuardShifts(db, GUARD);
    assert.deepEqual(
      shifts.map((shift) => [shift.shiftId, shift.shiftType, shift.isOpen]),
      [
        [SHIFT_B, 'day', true],
        [SHIFT_A, 'night', false]
      ]
    );
    assert.equal(shiftOptionLabel(shifts[0], t), 'Day shift · 2026-09-30 05:58 (now)');
  });
});

describe('display helpers', () => {
  it('describes events from their recorded fields only (times in SAST)', async () => {
    const db = await seededDb();
    const rows = await loadGuardEvents(db, GUARD, { kind: 'all' });
    const byId = new Map(rows.map((row) => [row.event.id, row.event]));
    assert.deepEqual(describeGuardEvent(byId.get('a2')!, t), { title: 'Scan: Gate #2 "north"', details: ['NFC tag'] });
    assert.deepEqual(describeGuardEvent(byId.get('a1')!, t), {
      title: 'Clocked in',
      details: ['Night shift, 18:00–06:00', 'Photos: 1']
    });
    assert.equal(describeGuardEvent(byId.get('b2')!, t).title, 'Incident: Fence cut or damaged');
    assert.equal(describeGuardEvent(byId.get('c1')!, t).title, 'SOS alarm');
  });

  it('reports GPS honestly: verdict with 0 m kept, error kind, or nothing', async () => {
    const db = await seededDb();
    const rows = await loadGuardEvents(db, GUARD, { kind: 'all' });
    const byId = new Map(rows.map((row) => [row.event.id, row.event]));
    assert.deepEqual(gpsSummary(byId.get('a2')!, t), { tone: 'success', text: 'At the point · 0 m from point · ±4 m' });
    assert.deepEqual(gpsSummary(byId.get('b1')!, t), { tone: 'warning', text: 'No GPS: location permission is off' });
    assert.equal(gpsSummary(byId.get('c1')!, t), null);
  });

  it('shows the readable part of an upload problem (no stack trace, no repeated message)', () => {
    // Exactly what the engine stored for a dropped connection in the browser run.
    const networkFailure =
      'Saving incident: TypeError: Failed to fetch — TypeError: Failed to fetch\n    at e (http://127.0.0.1:3191/_next/static/chunks/8617-cf673d38269dc9a0.js:1:287784)\n    at async B (http://127.0.0.1:3191/_next/static/chunks/3572-04d98cbaec379ee6.js:14:4885)';
    assert.equal(readableSyncError(networkFailure), 'Saving incident: TypeError: Failed to fetch');
    assert.equal(
      readableSyncError(
        'Saving incident: TypeError: Failed to fetch — TypeError: Failed to fetch at e (https://x.example/_next/a.js:1:2) at async B (https://x.example/b.js:3:4)'
      ),
      'Saving incident: TypeError: Failed to fetch'
    );
    const refusal = 'Saving checkpoint scan: new row violates row-level security policy for table "patrol_scans" (42501)';
    assert.equal(readableSyncError(refusal), refusal);
    assert.equal(
      readableSyncError('Saving gate entry: value too long — detail differs'),
      'Saving gate entry: value too long — detail differs'
    );
    assert.equal(readableSyncError(undefined), '');
    const long = readableSyncError('x'.repeat(500));
    assert.equal(long.length, SYNC_ERROR_MAX_LENGTH);
    assert.ok(long.endsWith('…'));
  });

  it('never calls an item uploaded unless the queue says synced', () => {
    assert.equal(syncStateView('synced', t).text, 'Uploaded');
    assert.equal(syncStateView('pending', t).text, 'Saved on phone');
    assert.equal(syncStateView('failed', t).tone, 'danger');
    assert.equal(syncStateView('unknown', t).text, 'Unknown');
  });
});

describe('CSV export', () => {
  it('quotes every cell, doubles quotes, neutralises formulas and keeps zero', () => {
    assert.equal(csvCell('Gate #2 "north"'), '"Gate #2 ""north"""');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('+27 82'), '"\'+27 82"');
    assert.equal(csvCell(-25.1), '"-25.1"');
    assert.equal(csvCell(0), '"0"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(Number.NaN), '""');
  });

  it('builds a BOM-prefixed, CRLF file of this guard’s records, oldest first', async () => {
    const db = await seededDb();
    const rows: GuardEventRow[] = await loadGuardEvents(db, GUARD, { kind: 'all' });
    const csv = buildGuardEventsCsv(rows, t, { [SITE]: 'Dawie Boerdery' });
    assert.ok(csv.startsWith('﻿"No.","Date (SAST)"'));
    const lines = csv.slice(1).trimEnd().split('\r\n');
    assert.equal(lines.length, 6); // header + 5 records of this guard (not the colleague's)
    assert.ok(lines[1].startsWith('"1","2026-09-28","17:55","Clocked in"'));
    assert.ok(lines[2].includes('"Scan: Gate #2 ""north"""'));
    assert.ok(lines[2].includes('"Dawie Boerdery"'));
    assert.ok(lines[2].includes('"0"'), 'a distance of 0 m is exported, not blanked');
    assert.ok(lines[2].includes('"Failed"') && lines[2].includes('"Scan outside the shift window"'));
    // Guard-typed text inside a cell that does not start with it cannot run as a formula.
    assert.ok(lines[4].includes('"Severity: High; =HYPERLINK(""http://evil""); Photos: 1"'));
    assert.ok(!csv.includes('not mine'));
    assert.ok(lines[5].includes('"SOS alarm"') && lines[5].includes('"Unknown"'));

    // A cell that starts with formula text (here a site name) is neutralised.
    const hostile = buildGuardEventsCsv(rows, t, { [SITE]: '=cmd|" /c calc"!A0' });
    assert.ok(hostile.includes('"\'=cmd|"" /c calc""!A0"'));
    assert.ok(!/(^|,)"=/m.test(hostile));
  });
});
