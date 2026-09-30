/**
 * Cross-area integration: the PRODUCTION client modules run their exact queries, uploads and
 * row mappings against the real migrations (RLS, triggers, column privileges, storage
 * policies) through the PGlite-backed client of ./pgSupabase.ts:
 *
 *   src/lib/auth/identity.ts        loadIdentity()            profile / roles / sites per role
 *   src/lib/auth/proxyHandler.ts    handleProxyRequest()      portal redirects from real rows
 *   src/lib/data/checkpoints.ts     loadCheckpoints(), resolveCheckpoint(), fetchCheckpointSecrets(),
 *                                   classifyCheckpointWriteError()
 *   src/lib/data/shiftStore.ts      startShift(), endShift(), reconcileWithServer()
 *   src/lib/offline/sync.ts         OfflineSyncEngine: enqueue → triggerSync → rows + evidence objects,
 *                                   lost responses and replays, per-user queue isolation
 *   src/lib/storage/evidence.ts     getEvidenceSignedUrl() under each role's storage policy
 *
 * No network and no hardware: GPS fixes, photos and tag serials are test inputs.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { NextRequest, NextResponse } from 'next/server';
import { asSuperuser, createTestDb } from './harness';
import { pointNorthOf, seedTwoTenantFixture, type Fixture } from './fixtures';
import { PgSupabase } from './pgSupabase';
import { loadIdentity } from '@/lib/auth/identity';
import { handleProxyRequest } from '@/lib/auth/proxyHandler';
import {
  CHECKPOINT_COLUMNS,
  CheckpointSecretsError,
  classifyCheckpointWriteError,
  fetchCheckpointSecrets,
  generateCheckpointToken,
  loadCheckpoints,
  resolveCheckpoint,
  type CheckpointCacheRecord,
  type CheckpointCacheStore
} from '@/lib/data/checkpoints';
import { createShiftStore } from '@/lib/data/shiftStore';
import { EagleEyeOfflineDB } from '@/lib/offline/db';
import { OfflineSyncEngine } from '@/lib/offline/sync';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import { assessCheckpointProximity } from '@/lib/gps/haversine';
import type { LocationFixResult } from '@/lib/gps/location';
import { getEvidenceSignedUrl, parseEvidencePath } from '@/lib/storage/evidence';
import { determineShiftForClockIn } from '@/features/shifts/shiftCalculator';
import type { Checkpoint, Site } from '@/types/models';
import type { EventContext } from '@/types/offline';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

const as = (userId: string) => new PgSupabase(db, { userId, email: `${userId}@example.test` });

function memoryCache(): CheckpointCacheStore & { records: Map<string, CheckpointCacheRecord> } {
  const records = new Map<string, CheckpointCacheRecord>();
  return {
    records,
    get: async (siteId) => records.get(siteId),
    put: async (record) => {
      records.set(record.siteId, record);
      return record.siteId;
    }
  };
}

function photo(fill: number, bytes = 2048): Blob {
  return new Blob([new Uint8Array(bytes).fill(fill)], { type: 'image/jpeg' });
}

/** A fresh GPS fix `meters` north of checkpoint cpA1 (test input, not a device reading). */
function fixNorthOfCheckpoint(meters: number, accuracy: number): LocationFixResult {
  const point = pointNorthOf(fx.cpLat, fx.cpLng, meters);
  return { status: 'ok', latitude: point.latitude, longitude: point.longitude, accuracy, timestamp: Date.now(), ageMs: 0 };
}

describe('identity loading (src/lib/auth/identity.ts) against real RLS', () => {
  const identity = async (userId: string) => loadIdentity(as(userId).client, { id: userId, email: null });

  test('a guard sees exactly their assigned site and their own role', async () => {
    const result = await identity(fx.users.guardA);
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.deepEqual(result.snapshot.roles, ['guard']);
    assert.deepEqual(
      result.snapshot.sites.map((site) => site.id),
      [fx.siteA1]
    );
    const [site] = result.snapshot.sites;
    assert.equal(site.organisationId, fx.orgA);
    assert.equal(site.latitude, fx.cpLat);
    assert.match(site.nightShiftStart, /^\d\d:\d\d$/);
    assert.equal(site.allowLegacyQr, false, 'new sites do not accept PLAAS-CP cards until an admin allows them');
  });

  test('supervisor: assigned sites only; org admin: the whole organisation; other tenant: its own site', async () => {
    const sup = await identity(fx.users.supA);
    const admin = await identity(fx.users.adminA);
    const adminB = await identity(fx.users.adminB);
    const viewer = await identity(fx.users.viewerA);
    assert.ok(sup.kind === 'ok' && admin.kind === 'ok' && adminB.kind === 'ok' && viewer.kind === 'ok');
    assert.deepEqual(sup.snapshot.sites.map((s) => s.id), [fx.siteA1]);
    assert.deepEqual(new Set(admin.snapshot.sites.map((s) => s.id)), new Set([fx.siteA1, fx.siteA2]));
    assert.deepEqual(adminB.snapshot.sites.map((s) => s.id), [fx.siteB1]);
    assert.deepEqual(viewer.snapshot.sites.map((s) => s.id), [fx.siteA1]);
    assert.deepEqual(viewer.snapshot.roles, ['client_viewer']);
  });

  test('a disabled account is reported as disabled, a user without a profile as no_profile', async () => {
    assert.deepEqual(await identity(fx.users.disabledGuardA), { kind: 'disabled' });
    const orphan = randomUUID();
    await asSuperuser(db, `INSERT INTO auth.users (id, email) VALUES ($1, 'orphan@example.test')`, [orphan]);
    assert.deepEqual(await identity(orphan), { kind: 'no_profile' });
  });
});

describe('portal redirects (src/lib/auth/proxyHandler.ts) from real rows', () => {
  async function landing(userId: string, path: string): Promise<string | null> {
    const client = as(userId);
    const response = await handleProxyRequest(new NextRequest(`https://eagle.example${path}`), (request) => ({
      supabase: client.client,
      response: () => NextResponse.next({ request })
    }));
    const location = response.headers.get('location');
    return location ? new URL(location).pathname + new URL(location).search : null;
  }

  test('each role reaches its own portal and is sent home from the others', async () => {
    assert.equal(await landing(fx.users.guardA, '/guard'), null);
    assert.equal(await landing(fx.users.guardA, '/admin'), '/guard');
    assert.equal(await landing(fx.users.supA, '/supervisor'), null);
    assert.equal(await landing(fx.users.supA, '/admin'), '/supervisor');
    assert.equal(await landing(fx.users.adminA, '/admin'), null);
    assert.equal(await landing(fx.users.viewerA, '/viewer'), null);
    assert.equal(await landing(fx.users.viewerA, '/guard'), '/viewer');
  });

  test('a disabled account is sent to /login with reason=disabled', async () => {
    const target = await landing(fx.users.disabledGuardA, '/guard');
    assert.ok(target?.startsWith('/login?'), String(target));
    assert.equal(new URLSearchParams(target!.split('?')[1]).get('reason'), 'disabled');
  });
});

describe('checkpoints (src/lib/data/checkpoints.ts) against column privileges and triggers', () => {
  test('guards load fingerprints with CHECKPOINT_COLUMNS; the raw secret columns are refused', async () => {
    const guard = as(fx.users.guardA);
    const loaded = await loadCheckpoints(fx.siteA1, { supabase: guard.client, cache: memoryCache(), isOnline: () => true });
    assert.equal(loaded.source, 'network');
    assert.deepEqual(new Set(loaded.checkpoints.map((c) => c.id)), new Set([fx.checkpoints.cpA1, fx.checkpoints.cpA1Inactive, fx.checkpoints.cpA1NoCoords]));
    for (const checkpoint of loaded.checkpoints) {
      assert.match(checkpoint.qrTokenSha256 ?? '', /^[0-9a-f]{64}$/);
      assert.equal(checkpoint.qrTokenStrong, true);
    }
    const secret = await guard.from('checkpoints').select('id, qr_code_hash').eq('site_id', fx.siteA1);
    assert.equal(secret.error?.code, '42501', 'selecting qr_code_hash must fail for a guard');
    const nfc = await guard.from('checkpoints').select('id, nfc_uid').eq('site_id', fx.siteA1);
    assert.equal(nfc.error?.code, '42501');
    assert.ok(!CHECKPOINT_COLUMNS.split(',').some((c) => ['qr_code_hash', 'nfc_uid'].includes(c.trim())));

    const other = await loadCheckpoints(fx.siteA1, { supabase: as(fx.users.guardB).client, cache: null, isOnline: () => true });
    assert.equal(other.checkpoints.length, 0, 'another organisation sees none of these checkpoints');
  });

  test('only org admins can read the raw token (audited); the printed token resolves on the guard phone', async () => {
    await assert.rejects(
      fetchCheckpointSecrets(fx.siteA1, { supabase: as(fx.users.guardA).client }),
      (e: unknown) => e instanceof CheckpointSecretsError && e.code === '42501'
    );
    await assert.rejects(
      fetchCheckpointSecrets(fx.siteA1, { supabase: as(fx.users.supA).client }),
      (e: unknown) => e instanceof CheckpointSecretsError && e.code === '42501'
    );
    const secrets = await fetchCheckpointSecrets(fx.siteA1, { supabase: as(fx.users.adminA).client });
    const cpA1 = secrets.find((s) => s.checkpointId === fx.checkpoints.cpA1);
    assert.ok(cpA1);
    assert.match(cpA1.qrToken, /^EE-CP-[0-9A-F]{32}$/);
    const audit = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'checkpoint.secrets_viewed' AND actor_id = $1`,
      [fx.users.adminA]
    );
    assert.ok(audit.rows[0].n >= 1);

    const list = (await loadCheckpoints(fx.siteA1, { supabase: as(fx.users.guardA).client, cache: null, isOnline: () => true })).checkpoints;
    const resolved = await resolveCheckpoint({ method: 'qr', raw: cpA1.qrToken }, list);
    assert.ok(resolved.ok);
    assert.equal(resolved.checkpoint.id, fx.checkpoints.cpA1);
  });

  test('admin NFC enrolment: the stored serial resolves from any reader format; duplicates and bad serials are explained', async () => {
    const admin = as(fx.users.adminA);
    const enrol = await admin.from('checkpoints').update({ nfc_uid: '04:A2:3B:1C:5D:80:00' }).eq('id', fx.checkpoints.cpA1).select('id, nfc_enrolled_at, nfc_enrolled_by');
    assert.equal(enrol.error, null);
    const [row] = enrol.data as Array<{ nfc_enrolled_at: string; nfc_enrolled_by: string }>;
    assert.ok(row.nfc_enrolled_at, 'stamped by the server');
    assert.equal(row.nfc_enrolled_by, fx.users.adminA);

    const list = (await loadCheckpoints(fx.siteA1, { supabase: as(fx.users.guardA).client, cache: null, isOnline: () => true })).checkpoints;
    for (const raw of ['04:a2:3b:1c:5d:80:00', '04A23B1C5D8000', '04-a2-3b-1c-5d-80-00']) {
      const resolved = await resolveCheckpoint({ method: 'nfc', raw }, list);
      assert.ok(resolved.ok, raw);
      assert.equal(resolved.checkpoint.id, fx.checkpoints.cpA1);
      assert.equal(resolved.payloadType, 'nfc_uid');
    }

    const duplicate = await admin.from('checkpoints').update({ nfc_uid: '04a23b1c5d8000' }).eq('id', fx.checkpoints.cpA1NoCoords);
    assert.equal(classifyCheckpointWriteError(duplicate.error).problem, 'duplicate_tag');
    const invalid = await admin.from('checkpoints').update({ nfc_uid: '04:a2' }).eq('id', fx.checkpoints.cpA1NoCoords);
    assert.equal(classifyCheckpointWriteError(invalid.error).problem, 'invalid_tag_serial');
    const weak = await admin.from('checkpoints').insert({ site_id: fx.siteA1, name: 'Weak', qr_code_hash: 'EE-CP-MAIN-GATE-01' });
    assert.equal(classifyCheckpointWriteError(weak.error).problem, 'invalid_token');
    const good = await admin
      .from('checkpoints')
      .insert({ site_id: fx.siteA1, name: 'New point', qr_code_hash: generateCheckpointToken(), order_index: 9 })
      .select(CHECKPOINT_COLUMNS);
    assert.equal(good.error, null);

    // A supervisor's write is filtered by RLS: no error, but no row changes. UIs must check the
    // returned rows (select) instead of assuming success.
    const sup = await as(fx.users.supA).from('checkpoints').update({ name: 'Renamed' }).eq('id', fx.checkpoints.cpA1).select('id');
    assert.equal(sup.error, null);
    assert.deepEqual(sup.data, []);
  });
});

describe('a full guard shift through the offline queue (shiftStore + OfflineSyncEngine)', () => {
  const guardId = () => fx.users.guardA;
  let supabase: PgSupabase;
  let dexie: EagleEyeOfflineDB;
  let engine: OfflineSyncEngine;
  let online = false;
  let ctx: EventContext;
  let site: Site;
  let checkpoints: Checkpoint[];
  let token: string;
  const ids: Record<string, string> = {};

  before(async () => {
    supabase = as(guardId());
    dexie = new EagleEyeOfflineDB(`integration-${randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
    engine = new OfflineSyncEngine({
      db: dexie,
      getSupabase: () => supabase.client,
      locks: null,
      isOnline: () => online,
      sleep: () => new Promise<void>(() => undefined),
      checkStorage: async () => ({ persisted: true, usageBytes: 0, quotaBytes: 1_000_000_000, nearlyFull: false })
    });
    engine.setActiveUser(guardId());
    const identity = await loadIdentity(supabase.client, { id: guardId(), email: null });
    assert.equal(identity.kind, 'ok');
    if (identity.kind !== 'ok') return;
    site = identity.snapshot.sites[0];
    ctx = { userId: guardId(), organisationId: identity.snapshot.profile.organisationId, siteId: site.id };
    const secrets = await fetchCheckpointSecrets(fx.siteA1, { supabase: as(fx.users.adminA).client });
    token = secrets.find((s) => s.checkpointId === fx.checkpoints.cpA1)!.qrToken;
    // The admin allows Dawie's PLAAS-CP cards on this site (sites.allow_legacy_qr).
    const allow = await as(fx.users.adminA).from('sites').update({ allow_legacy_qr: true }).eq('id', fx.siteA1).select('id');
    assert.equal((allow.data as unknown[]).length, 1);
  });
  after(async () => {
    engine.dispose();
    dexie.close();
  });

  test('everything is recorded on the phone while offline (nothing is sent)', async () => {
    const store = createShiftStore({ db: dexie, engine });
    const schedule = determineShiftForClockIn(site, Date.now());
    const shift = await store.startShift({
      ctx,
      shiftType: schedule.shiftType,
      scheduledStart: new Date(schedule.scheduledStart).toISOString(),
      scheduledEnd: new Date(schedule.scheduledEnd).toISOString(),
      selfieBlob: photo(1),
      location: eventLocationFromFix(fixNorthOfCheckpoint(10, 8))
    });
    ids.shift = shift.shiftId;
    assert.equal((await store.getActiveShift(guardId()))?.shiftId, shift.shiftId);

    const loaded = await loadCheckpoints(site.id, { supabase: supabase.client, cache: memoryCache(), isOnline: () => true });
    checkpoints = loaded.checkpoints;

    // QR (secure token), 5 m from the checkpoint at ±4 m.
    const fixQr = fixNorthOfCheckpoint(5, 4);
    const qr = await resolveCheckpoint({ method: 'qr', raw: token }, checkpoints, { allowLegacyQr: site.allowLegacyQr });
    assert.ok(qr.ok);
    const proximity = assessCheckpointProximity(
      fixQr.status === 'ok' ? { latitude: fixQr.latitude, longitude: fixQr.longitude, accuracy: fixQr.accuracy } : null,
      qr.checkpoint
    );
    assert.equal(proximity.confidence, 'verified');
    ids.scanQr = await engine.enqueue('checkpoint_scan', ctx, {
      shiftId: shift.shiftId,
      checkpointId: qr.checkpoint.id,
      checkpointName: qr.checkpoint.name,
      method: 'qr',
      payloadType: qr.payloadType,
      rawPayload: token,
      distanceToCheckpointMeters: proximity.distanceMeters,
      gpsConfidence: proximity.confidence,
      isValidProximity: proximity.isValidProximity,
      ...eventLocationFromFix(fixQr)
    });

    // NFC (enrolled serial, as a reader reports it), 40 m away at ±15 m → likely.
    const nfc = await resolveCheckpoint({ method: 'nfc', raw: '04A23B1C5D8000' }, checkpoints);
    assert.ok(nfc.ok);
    ids.scanNfc = await engine.enqueue('checkpoint_scan', ctx, {
      shiftId: shift.shiftId,
      checkpointId: nfc.checkpoint.id,
      method: 'nfc',
      payloadType: 'nfc_uid',
      rawPayload: '04A23B1C5D8000',
      ...eventLocationFromFix(fixNorthOfCheckpoint(40, 15))
    });

    // Dawie's printed card, no GPS permission.
    const legacy = await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP1' }, checkpoints, { allowLegacyQr: true });
    assert.ok(legacy.ok);
    assert.equal(legacy.payloadType, 'legacy_qr');
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
      {
        shiftId: shift.shiftId,
        incidentType: 'fence',
        severity: 'high',
        description: 'Cut fence at the north boundary',
        ...eventLocationFromFix(fixNorthOfCheckpoint(30, 10))
      },
      [
        { field: 'photo', blob: photo(2) },
        { field: 'photo2', blob: photo(3) }
      ]
    );

    const entryTime = new Date().toISOString();
    ids.gateIn = await engine.enqueue(
      'gate_entry',
      ctx,
      {
        shiftId: shift.shiftId,
        direction: 'in',
        licensePlate: 'CA 123-456',
        makeModel: 'TOYOTA HILUX',
        isDiscScanned: true,
        discExpiryDate: '2027-03-31',
        entryTime,
        ...eventLocationFromFix(fixNorthOfCheckpoint(2, 5))
      },
      [{ field: 'photo', blob: photo(4) }]
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

    ids.panic = await engine.enqueue('panic', ctx, { shiftId: shift.shiftId, ...eventLocationFromFix(fixNorthOfCheckpoint(1, 3)) });

    // A colleague used this phone earlier: their queued event must never go out under this session.
    ids.otherUser = await engine.enqueue(
      'incident',
      { userId: fx.users.guardA2, organisationId: fx.orgA, siteId: fx.siteA1 },
      { shiftId: null, incidentType: 'other', severity: 'low', description: 'Recorded by a colleague' }
    );

    const ended = await store.endShift({ ctx, shiftId: shift.shiftId, selfieBlob: photo(5), location: eventLocationFromFix(fixNorthOfCheckpoint(3, 6)) });
    ids.shiftEnd = ended.eventId;
    assert.equal(await store.getActiveShift(guardId()), null);

    const summary = await engine.getSummary();
    // clock-in, 3 scans, incident, gate IN, gate OUT, SOS, clock-out
    assert.equal(summary.pendingCount, 9);
    assert.equal(summary.otherUserCount, 1);
    assert.equal(supabase.calls.filter((c) => c.kind !== 'select' && c.kind !== 'rpc').length, 0, 'nothing was sent while offline');
  });

  test('reconnecting delivers everything despite lost responses; replays are no-ops', async () => {
    // Responses lost on the way back: the server applied the request, the phone saw a network error.
    supabase.loseResponses((call) => call.kind === 'upsert' && call.target === 'patrol_scans');
    supabase.loseResponses((call) => call.kind === 'upload' && call.target.includes('/incident/'));
    supabase.loseResponses((call) => call.kind === 'update' && call.target === 'shifts');
    supabase.loseResponses((call) => call.kind === 'upsert' && call.target === 'gate_entries');
    online = true;

    const reports = [];
    for (let pass = 0; pass < 12; pass += 1) {
      reports.push(await engine.triggerSync({ force: true }));
      const summary = await engine.getSummary();
      if (summary.pendingCount === 0 && summary.syncingCount === 0) break;
    }
    const summary = await engine.getSummary();
    assert.equal(supabase.unconsumedLostResponses, 0, 'every scripted lost response was hit');
    assert.ok(reports.length > 1, 'the lost responses forced retries');
    assert.equal(summary.failedCount, 0, `dead-lettered: ${summary.lastError ?? ''}`);
    assert.equal(summary.pendingCount, 0, `still pending: ${summary.lastError ?? ''} (${JSON.stringify(reports)})`);
    assert.equal(summary.otherUserCount, 1, "the colleague's event stays queued on the phone");
    assert.equal((await dexie.syncQueue.get(ids.otherUser))?.syncState, 'pending');
    assert.equal(await dexie.mediaBlobs.count(), 0, 'photos are deleted from the phone only after delivery');
  });

  test('the server holds exactly one copy of each record, with server-computed proof', async () => {
    const shift = await asSuperuser<{
      status: string;
      actual_end: string | null;
      start_selfie_url: string;
      end_selfie_url: string;
    }>(db, `SELECT status, actual_end, start_selfie_url, end_selfie_url FROM shifts WHERE id = $1`, [ids.shift]);
    assert.equal(shift.rows[0].status, 'completed');
    assert.ok(shift.rows[0].actual_end);
    for (const path of [shift.rows[0].start_selfie_url, shift.rows[0].end_selfie_url]) {
      const parsed = parseEvidencePath(path);
      assert.ok(parsed, `selfie path ${path}`);
      assert.equal(parsed.category, 'selfie');
      assert.equal(parsed.userId, guardId());
    }
    assert.notEqual(shift.rows[0].start_selfie_url, shift.rows[0].end_selfie_url);

    const scans = await asSuperuser<{
      id: string;
      shift_id: string;
      site_id: string;
      gps_confidence: string;
      is_valid_proximity: boolean;
      payload_type: string;
      payload_verified: boolean;
      raw_payload: string | null;
      hash_chain: string | null;
    }>(
      db,
      `SELECT id, shift_id, site_id, gps_confidence, is_valid_proximity, payload_type, payload_verified, raw_payload, hash_chain
       FROM patrol_scans WHERE guard_id = $1 AND shift_id = $2`,
      [guardId(), ids.shift]
    );
    assert.equal(scans.rows.length, 3, 'one row per scan despite the lost response');
    const byId = new Map(scans.rows.map((row) => [row.id, row]));
    const qr = byId.get(ids.scanQr)!;
    assert.equal(qr.shift_id, ids.shift, 'the scan references the real active shift');
    assert.equal(qr.site_id, fx.siteA1);
    assert.equal(qr.gps_confidence, 'verified');
    assert.equal(qr.payload_verified, true);
    assert.match(qr.raw_payload ?? '', /^sha256:[0-9a-f]{64}$/, 'the token itself is not stored');
    assert.match(qr.hash_chain ?? '', /^[0-9a-f]{64}$/);
    const nfc = byId.get(ids.scanNfc)!;
    assert.equal(nfc.gps_confidence, 'likely');
    assert.equal(nfc.payload_verified, true);
    assert.match(nfc.raw_payload ?? '', /^sha256:/);
    const legacy = byId.get(ids.scanLegacy)!;
    assert.equal(legacy.gps_confidence, 'no_fix');
    assert.equal(legacy.payload_verified, false, 'public PLAAS-CP codes are never verified');

    const incident = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM incidents WHERE id = $1 AND status = 'reported'`, [ids.incident]);
    assert.equal(incident.rows[0].n, 1);
    const media = await asSuperuser<{ media_url: string; media_type: string }>(
      db,
      `SELECT media_url, media_type FROM incident_media WHERE incident_id = $1 ORDER BY media_url`,
      [ids.incident]
    );
    assert.equal(media.rows.length, 2);
    for (const row of media.rows) {
      assert.equal(parseEvidencePath(row.media_url)?.eventId, ids.incident);
      assert.equal(row.media_type, 'image/jpeg');
    }

    const gate = await asSuperuser<{ id: string; direction: string; linked_entry_id: string | null; dwell_duration_seconds: number | null; vehicle_photo_url: string | null }>(
      db,
      `SELECT id, direction, linked_entry_id, dwell_duration_seconds, vehicle_photo_url FROM gate_entries WHERE id IN ($1, $2)`,
      [ids.gateIn, ids.gateOut]
    );
    assert.equal(gate.rows.length, 2);
    const out = gate.rows.find((row) => row.direction === 'out')!;
    assert.equal(out.linked_entry_id, ids.gateIn);
    assert.equal(typeof out.dwell_duration_seconds, 'number');
    assert.equal(parseEvidencePath(gate.rows.find((row) => row.direction === 'in')!.vehicle_photo_url ?? '')?.category, 'vehicle');

    const panic = await asSuperuser<{ status: string; shift_id: string | null }>(db, `SELECT status, shift_id FROM panic_alerts WHERE id = $1`, [ids.panic]);
    assert.equal(panic.rows[0].status, 'active');
    // The SOS is delivered first, before its clock-in reached the server, so it goes without the
    // shift link (panic_alerts.shift_id is optional) and the phone records the dropped link.
    assert.equal(panic.rows[0].shift_id, null);
    assert.deepEqual((await dexie.syncQueue.get(ids.panic))?.droppedLinks, ['shift_id']);

    const objects = await asSuperuser<{ category: string; n: number }>(
      db,
      `SELECT split_part(name, '/', 3) AS category, count(*)::int AS n FROM storage.objects
       WHERE bucket_id = 'evidence-media' AND split_part(name, '/', 4) = $1::text GROUP BY 1 ORDER BY 1`,
      [guardId()]
    );
    assert.deepEqual(
      Object.fromEntries(objects.rows.map((row) => [row.category, row.n])),
      { incident: 2, selfie: 2, vehicle: 1 },
      'one object per photo despite the lost upload response'
    );

    const colleague = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM incidents WHERE id = $1`, [ids.otherUser]);
    assert.equal(colleague.rows[0].n, 0);
  });

  test('evidence is readable only as the storage policies allow (signed URLs per role)', async () => {
    const shift = await asSuperuser<{ start_selfie_url: string }>(db, `SELECT start_selfie_url FROM shifts WHERE id = $1`, [ids.shift]);
    const selfie = shift.rows[0].start_selfie_url;
    const incidentPhoto = (await asSuperuser<{ media_url: string }>(db, `SELECT media_url FROM incident_media WHERE incident_id = $1 LIMIT 1`, [ids.incident])).rows[0].media_url;

    assert.match(await getEvidenceSignedUrl(selfie, 300, as(guardId()).client), /^https:/, 'own selfie');
    assert.match(await getEvidenceSignedUrl(selfie, 300, as(fx.users.supA).client), /^https:/, 'supervisor of the site');
    assert.match(await getEvidenceSignedUrl(incidentPhoto, 300, as(fx.users.viewerA).client), /^https:/, 'client viewer: incident photo');
    await assert.rejects(getEvidenceSignedUrl(selfie, 300, as(fx.users.viewerA).client), /Could not open evidence/, 'client viewer: no selfies');
    await assert.rejects(getEvidenceSignedUrl(selfie, 300, as(fx.users.guardA2).client), /Could not open evidence/, 'colleague guard');
    await assert.rejects(getEvidenceSignedUrl(incidentPhoto, 300, as(fx.users.adminB).client), /Could not open evidence/, 'other organisation');
  });

  test('after delivery the checkpoint cannot be deleted (history), and the phone agrees with the server about the shift', async () => {
    const deleted = await as(fx.users.adminA).from('checkpoints').delete().eq('id', fx.checkpoints.cpA1);
    assert.equal(classifyCheckpointWriteError(deleted.error).problem, 'in_use');

    const store = createShiftStore({ db: dexie, engine });
    const reconciled = await store.reconcileWithServer(supabase.client, ctx);
    assert.deepEqual(reconciled, { status: 'unchanged' }, 'no running shift on the phone or the server');
  });
});
