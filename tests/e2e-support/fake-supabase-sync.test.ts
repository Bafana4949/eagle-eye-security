/**
 * The production offline queue (shiftStore + OfflineSyncEngine) delivering a whole guard shift
 * to the E2E fake Supabase server through the REAL @supabase/supabase-js client over HTTP, with
 * responses lost on the way back (scripted via /__test/faults). Proves that the fake server's
 * PostgREST / Storage emulation is what the app's sync code expects.
 *
 *   npx tsx --test tests/e2e-support/fake-supabase-sync.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { determineShiftForClockIn } from '../../src/features/shifts/shiftCalculator';
import { loadIdentity } from '../../src/lib/auth/identity';
import { loadCheckpoints, resolveCheckpoint } from '../../src/lib/data/checkpoints';
import { createShiftStore } from '../../src/lib/data/shiftStore';
import type { LocationFixResult } from '../../src/lib/gps/location';
import { EagleEyeOfflineDB } from '../../src/lib/offline/db';
import { eventLocationFromFix } from '../../src/lib/offline/eventLocation';
import { OfflineSyncEngine } from '../../src/lib/offline/sync';
import { getEvidenceSignedUrl } from '../../src/lib/storage/evidence';
import { TEST_ANON_KEY, TEST_CONTROL_HEADER, TEST_CONTROL_TOKEN } from './constants';
import { pointNorthOf, WORKSHOP_NFC_SERIAL, type E2EFixture, type E2EUserKey } from './fixture';
import { startFakeSupabase, type FakeSupabaseServer } from './fake-supabase/server';
import { retryFetch } from './netRetry';

let fake: FakeSupabaseServer;
let fixture: E2EFixture;

async function control<T>(path: string, body?: unknown): Promise<T> {
  const res = await retryFetch(`${fake.url}/__test/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { [TEST_CONTROL_HEADER]: TEST_CONTROL_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/__test/${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await control<{ rows: T[] }>('sql', { sql: query, params })).rows;
}

async function signedIn(user: E2EUserKey): Promise<SupabaseClient> {
  const supabase = createClient(fake.url, TEST_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: retryFetch } });
  const { error } = await supabase.auth.signInWithPassword({ email: fixture.users[user].email, password: fixture.users[user].password });
  assert.equal(error, null);
  return supabase;
}

function jpegBlob(size: number): Blob {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function fixNorth(meters: number, accuracy: number): LocationFixResult {
  const point = pointNorthOf(fixture.siteA.latitude!, fixture.siteA.longitude!, meters);
  return { status: 'ok', latitude: point.latitude, longitude: point.longitude, accuracy, timestamp: Date.now(), ageMs: 0 };
}

describe('production offline queue → fake Supabase over HTTP', () => {
  let guard: SupabaseClient;
  let dexie: EagleEyeOfflineDB;
  let engine: OfflineSyncEngine;
  let online = false;
  const ids: Record<string, string> = {};

  before(async () => {
    fake = await startFakeSupabase({ port: 0, quiet: true });
    fixture = (await control<{ fixture: E2EFixture }>('reset', {})).fixture;
    guard = await signedIn('guard');
    dexie = new EagleEyeOfflineDB(`e2e-http-${randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
    engine = new OfflineSyncEngine({
      db: dexie,
      getSupabase: () => guard,
      locks: null,
      isOnline: () => online,
      sleep: () => new Promise<void>(() => undefined),
      checkStorage: async () => ({ persisted: true, usageBytes: 0, quotaBytes: 1_000_000_000, nearlyFull: false })
    });
    engine.setActiveUser(fixture.users.guard.id);
  });

  after(async () => {
    engine?.dispose();
    dexie?.close();
    await fake?.close();
  });

  it('records a whole shift offline, then delivers every record exactly once despite lost responses', async () => {
    const identity = await loadIdentity(guard, { id: fixture.users.guard.id, email: fixture.users.guard.email });
    assert.equal(identity.kind, 'ok');
    if (identity.kind !== 'ok') return;
    const site = identity.snapshot.sites[0];
    const ctx = { userId: fixture.users.guard.id, organisationId: identity.snapshot.profile.organisationId, siteId: site.id };
    const store = createShiftStore({ db: dexie, engine });
    const schedule = determineShiftForClockIn(site, Date.now());
    const shift = await store.startShift({
      ctx,
      shiftType: schedule.shiftType,
      scheduledStart: new Date(schedule.scheduledStart).toISOString(),
      scheduledEnd: new Date(schedule.scheduledEnd).toISOString(),
      selfieBlob: jpegBlob(1500),
      location: eventLocationFromFix(fixNorth(3, 5))
    });
    ids.shift = shift.shiftId;
    const eventIds: Record<string, string> = { clockIn: shift.startEventId };
    const { checkpoints } = await loadCheckpoints(site.id, { supabase: guard, cache: null, isOnline: () => true });

    const qr = await resolveCheckpoint({ method: 'qr', raw: fixture.checkpoints.gate.qrToken }, checkpoints, { allowLegacyQr: site.allowLegacyQr });
    assert.ok(qr.ok);
    ids.scanQr = await engine.enqueue('checkpoint_scan', ctx, {
      shiftId: shift.shiftId,
      checkpointId: qr.checkpoint.id,
      method: 'qr',
      payloadType: qr.payloadType,
      rawPayload: fixture.checkpoints.gate.qrToken,
      ...eventLocationFromFix(fixNorth(5, 4))
    });
    const nfc = await resolveCheckpoint({ method: 'nfc', raw: WORKSHOP_NFC_SERIAL }, checkpoints);
    assert.ok(nfc.ok);
    ids.scanNfc = await engine.enqueue('checkpoint_scan', ctx, {
      shiftId: shift.shiftId,
      checkpointId: nfc.checkpoint.id,
      method: 'nfc',
      payloadType: 'nfc_uid',
      rawPayload: WORKSHOP_NFC_SERIAL,
      ...eventLocationFromFix(fixNorth(30, 6))
    });
    const legacy = await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP1' }, checkpoints, { allowLegacyQr: site.allowLegacyQr });
    assert.ok(legacy.ok);
    ids.scanLegacy = await engine.enqueue('checkpoint_scan', ctx, {
      shiftId: shift.shiftId,
      checkpointId: legacy.checkpoint.id,
      method: 'qr',
      payloadType: 'legacy_qr',
      rawPayload: 'PLAAS-CP:CP1',
      ...eventLocationFromFix({ status: 'permission_denied', message: 'denied' })
    });
    ids.incident = await engine.enqueue(
      'incident',
      ctx,
      { shiftId: shift.shiftId, incidentType: 'fence', severity: 'high', description: 'Cut fence (E2E)', ...eventLocationFromFix(fixNorth(20, 8)) },
      [
        { field: 'photo', blob: jpegBlob(2100) },
        { field: 'photo2', blob: jpegBlob(2200) }
      ]
    );
    const entryTime = new Date().toISOString();
    ids.gateIn = await engine.enqueue(
      'gate_entry',
      ctx,
      { shiftId: shift.shiftId, direction: 'in', licensePlate: 'CA 123-456', isDiscScanned: false, entryTime, ...eventLocationFromFix(fixNorth(2, 5)) },
      [{ field: 'photo', blob: jpegBlob(2300) }]
    );
    ids.gateOut = await engine.enqueue('gate_entry', ctx, {
      shiftId: shift.shiftId,
      direction: 'out',
      licensePlate: 'CA 123-456',
      isDiscScanned: false,
      entryTime,
      exitTime: new Date(Date.now() + 1000).toISOString(),
      linkedEntryId: ids.gateIn,
      ...eventLocationFromFix({ status: 'timeout', message: 'timeout' })
    });
    ids.panic = await engine.enqueue('panic', ctx, { shiftId: shift.shiftId, ...eventLocationFromFix(fixNorth(1, 3)) });
    const ended = await store.endShift({ ctx, shiftId: shift.shiftId, selfieBlob: jpegBlob(1600), location: eventLocationFromFix(fixNorth(4, 6)) });
    ids.shiftEnd = ended.eventId;

    assert.equal((await engine.getSummary()).pendingCount, 9);
    const sentWhileOffline = (await control<{ entries: Array<{ method: string; path: string }> }>('requests')).entries.filter(
      (e) => e.method !== 'GET' && e.method !== 'HEAD' && !e.path.startsWith('/auth/')
    );
    assert.deepEqual(sentWhileOffline, [], 'nothing is written while offline');

    // The server applies these requests but the phone never sees the answer.
    await control('faults', {
      rules: [
        { method: 'POST', path: '^/rest/v1/patrol_scans', action: 'lose_response' },
        { method: 'POST', path: '^/storage/v1/object/evidence-media/.*/incident/', action: 'lose_response' },
        { method: 'PATCH', path: '^/rest/v1/shifts', action: 'lose_response' },
        { method: 'POST', path: '^/rest/v1/gate_entries', action: 'lose_response' }
      ]
    });
    online = true;
    for (let pass = 0; pass < 15; pass += 1) {
      await engine.triggerSync({ force: true });
      const summary = await engine.getSummary();
      if (summary.pendingCount === 0 && summary.syncingCount === 0) break;
    }
    const summary = await engine.getSummary();
    assert.equal(summary.failedCount, 0, `dead-lettered: ${summary.lastError ?? ''}`);
    assert.equal(summary.pendingCount, 0, `still pending: ${summary.lastError ?? ''}`);
    const { faults } = await control<{ faults: Array<{ remaining: number }> }>('faults');
    assert.equal(
      faults.reduce((n, f) => n + f.remaining, 0),
      0,
      'every scripted lost response was exercised'
    );
    // Every queued event (the shift row id is not an event id; its clock-in event is startEventId).
    for (const [name, id] of Object.entries({ ...ids, ...eventIds, shift: undefined })) {
      if (id) assert.equal(await engine.getSyncState(id), 'synced', name);
    }

    const [shiftRow] = await sql<{ status: string; start_selfie_url: string; end_selfie_url: string }>(
      `SELECT status, start_selfie_url, end_selfie_url FROM shifts WHERE id = $1`,
      [ids.shift]
    );
    assert.equal(shiftRow.status, 'completed');
    const scans = await sql<{ id: string; payload_verified: boolean; gps_confidence: string }>(
      `SELECT id, payload_verified, gps_confidence FROM patrol_scans WHERE shift_id = $1`,
      [ids.shift]
    );
    assert.equal(scans.length, 3, 'one row per scan despite the lost response');
    const byId = new Map(scans.map((row) => [row.id, row]));
    assert.equal(byId.get(ids.scanQr)?.gps_confidence, 'verified');
    assert.equal(byId.get(ids.scanQr)?.payload_verified, true);
    assert.equal(byId.get(ids.scanNfc)?.payload_verified, true);
    assert.equal(byId.get(ids.scanLegacy)?.payload_verified, false);
    assert.equal(byId.get(ids.scanLegacy)?.gps_confidence, 'no_fix');
    assert.equal((await sql(`SELECT 1 FROM incident_media WHERE incident_id = $1`, [ids.incident])).length, 2);
    const [out] = await sql<{ linked_entry_id: string }>(`SELECT linked_entry_id FROM gate_entries WHERE id = $1`, [ids.gateOut]);
    assert.equal(out.linked_entry_id, ids.gateIn);
    assert.equal((await sql(`SELECT 1 FROM panic_alerts WHERE id = $1`, [ids.panic])).length, 1);
    const { objects } = await control<{ objects: Array<{ name: string }> }>(`storage?prefix=evidence-media/${fixture.orgA.id}/`);
    assert.equal(objects.length, 5, objects.map((o) => o.name).join('\n'));
    assert.equal(await dexie.mediaBlobs.count(), 0, 'photos leave the phone only after delivery');

    // Evidence display: the supervisor opens the clock-in selfie through a signed URL.
    const supervisor = await signedIn('supervisor');
    const url = await getEvidenceSignedUrl(shiftRow.start_selfie_url, 60, supervisor);
    const image = await retryFetch(url);
    assert.equal(image.status, 200);
    assert.equal((await image.arrayBuffer()).byteLength, 1500);
  });
});
