import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { EagleEyeOfflineDB } from './db';

describe('database upgrade v2 → v3 (checkpoint secrets leave the phone)', () => {
  it('drops cached checkpoint lists and the legacy checkpoint copy, and keeps the queue', async () => {
    const indexedDB = new IDBFactory();
    const name = `v2-${globalThis.crypto.randomUUID()}`;
    // The v2 schema exactly as the previous build declared it.
    const v2 = new Dexie(name, { indexedDB, IDBKeyRange });
    v2.version(1).stores({
      syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt',
      checkpoints: 'id, siteId, qrCodeHash, nfcUid, isActive',
      shifts: 'id, siteId, guardId, status',
      scans: 'id, offlineUuid, shiftId, checkpointId, guardId, scanTimestampDevice',
      incidents: 'id, offlineUuid, siteId, shiftId, guardId, status',
      gateEntries: 'id, offlineUuid, siteId, direction, licensePlate, entryTime',
      mediaBlobs: 'id, queueItemId, field'
    });
    v2.version(2).stores({
      syncQueue: 'id, sequenceNumber, userId, siteId, eventType, syncState, createdAt, [userId+syncState]',
      guardState: 'key, userId, kind',
      checkpointCache: 'siteId',
      localEvents: 'id, userId, shiftId, type, createdAt, [userId+sequenceNumber], [userId+type+sequenceNumber]'
    });
    await v2.table('checkpointCache').put({
      siteId: 'site-1',
      checkpoints: [{ id: 'cp-1', siteId: 'site-1', name: 'Gate', qrCodeHash: 'EE-CP-00112233445566778899AABBCCDDEEFF', nfcUid: '04:a2:3b:1c' }],
      cachedAt: '2026-09-30T10:00:00.000Z'
    });
    await v2.table('checkpoints').put({ id: 'cp-1', siteId: 'site-1', qrCodeHash: 'EE-CP-MAIN-GATE-01', nfcUid: '04:7a:b2:c1', isActive: true });
    await v2.table('syncQueue').add({
      id: 'queued-1',
      sequenceNumber: 1,
      userId: 'a1111111-2222-4333-8444-555555555555',
      organisationId: '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c',
      siteId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
      eventType: 'panic',
      payload: { shiftId: null },
      mediaFields: [],
      deviceTimestamp: '2026-09-30T10:00:00.000Z',
      syncState: 'pending',
      retryCount: 0,
      rejectionCount: 0,
      createdAt: '2026-09-30T10:00:00.000Z'
    });
    v2.close();

    const db = new EagleEyeOfflineDB(name, { indexedDB, IDBKeyRange });
    await db.open();
    assert.equal(db.verno, 3);
    assert.equal(await db.checkpointCache.count(), 0, 'cached lists holding raw tokens / serials are gone');
    assert.equal(await db.checkpoints.count(), 0, 'the legacy checkpoint copy is gone');
    assert.deepEqual(
      db.checkpoints.schema.indexes.map((index) => index.name).sort(),
      ['isActive', 'siteId'],
      'no index on secrets any more'
    );
    const queued = await db.syncQueue.get('queued-1');
    assert.equal(queued?.syncState, 'pending', 'queued evidence is never touched by the upgrade');
    db.close();
  });
});
