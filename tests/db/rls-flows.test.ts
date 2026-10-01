/**
 * The legitimate day-to-day flows must keep working under the hardened policies,
 * using the same statements the app / sync engine issues (upserts with
 * ON CONFLICT DO NOTHING for immutable events, UPDATE ... RETURNING for clock-out).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, createTestDb, tryAsUser } from './harness';
import { pointNorthOf, seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertNoRows, assertRefused, startShiftAs } from './assertions';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

/** INSERT a scan the way the sync engine does (client values included, no RETURNING). */
async function insertScan(
  userId: string,
  values: {
    id?: string;
    shiftId: string;
    checkpointId: string;
    deviceTime?: string;
    latitude?: number | null;
    longitude?: number | null;
    accuracy?: number | null;
    clientDistance?: number | null;
    clientConfidence?: string | null;
    clientValid?: boolean;
    clientServerTime?: string | null;
    payloadType?: string;
    rawPayload?: string | null;
    method?: string;
  }
) {
  const id = values.id ?? randomUUID();
  const outcome = await tryAsUser(
    db,
    userId,
    `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, site_id, scan_timestamp_device,
                               latitude, longitude, accuracy_meters, distance_to_checkpoint_meters, gps_confidence,
                               is_valid_proximity, scan_timestamp_server, method, payload_type, raw_payload)
     VALUES ($1, $1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8, $9, $10, $11, $12,
             coalesce($13::timestamptz, now()), $14::scan_method_enum, $15, $16)
     ON CONFLICT (offline_uuid) DO NOTHING`,
    [
      id,
      values.shiftId,
      values.checkpointId,
      userId,
      fx.siteB1, // deliberately wrong: the trigger must take the site from the shift
      values.deviceTime ?? null,
      values.latitude ?? null,
      values.longitude ?? null,
      values.accuracy ?? null,
      values.clientDistance ?? null,
      values.clientConfidence ?? null,
      values.clientValid ?? false,
      values.clientServerTime ?? null,
      values.method ?? 'qr',
      values.payloadType ?? 'secure_token',
      values.rawPayload ?? null
    ]
  );
  return { id, outcome };
}

async function qrToken(checkpointId: string): Promise<string> {
  const r = await asSuperuser<{ qr_code_hash: string }>(db, `SELECT qr_code_hash FROM checkpoints WHERE id = $1`, [checkpointId]);
  return r.rows[0].qr_code_hash;
}

describe('guard: identity and site data the app loads', () => {
  test('guard reads own profile and roles, and only the sites and checkpoints they are assigned to', async () => {
    const g = fx.users.guardA;
    const profile = await asUser<{ id: string }>(db, g, `SELECT id FROM profiles`);
    assert.deepEqual(profile.rows, [{ id: g }]);
    const roles = await asUser<{ role: string }>(db, g, `SELECT role FROM user_roles`);
    assert.deepEqual(roles.rows, [{ role: 'guard' }]);
    const sites = await asUser<{ id: string }>(db, g, `SELECT id FROM sites`);
    assert.deepEqual(sites.rows, [{ id: fx.siteA1 }]);
    const cps = await asUser<{ site_id: string }>(db, g, `SELECT DISTINCT site_id FROM checkpoints`);
    assert.deepEqual(cps.rows, [{ site_id: fx.siteA1 }]);
    const org = await asUser<{ id: string }>(db, g, `SELECT id FROM organisations`);
    assert.deepEqual(org.rows, [{ id: fx.orgA }]);
  });

  test('guard can update their own display fields (phone, language); the name is admin-controlled', async () => {
    const g = fx.users.guardA;
    const r = await tryAsUser(db, g, `UPDATE profiles SET phone_number = '0821234567', preferred_language = 'zu' WHERE id = $1`, [g]);
    assertAllowed(r);
    assert.equal(r.affectedRows, 1);
    // A guard's name is a button on the patrol phone (20261001000200_patrol_devices.sql).
    assertRefused(await tryAsUser(db, g, `UPDATE profiles SET first_name = 'Sipho' WHERE id = $1`, [g]), '42501', 'own name');
  });
});

describe('guard: shift lifecycle', () => {
  test('guard starts their own shift on an assigned site (upsert on id, replay is a no-op)', async () => {
    const g = fx.users.guardA;
    const id = randomUUID();
    const sql = `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start,
                                     start_selfie_url, start_latitude, start_longitude, start_accuracy_meters, status)
                 VALUES ($1, $2, $3, 'night', now(), now() + interval '12 hours', now(), $4, -25.68, 27.81, 12, 'active')
                 ON CONFLICT (id) DO NOTHING`;
    const path = `${fx.orgA}/${fx.siteA1}/selfie/${g}/${id}-start_selfie.jpg`;
    const first = await tryAsUser(db, g, sql, [id, fx.siteA1, g, path]);
    assertAllowed(first);
    assert.equal(first.affectedRows, 1);
    const replay = await tryAsUser(db, g, sql, [id, fx.siteA1, g, path]);
    assertAllowed(replay);
    assert.equal(replay.affectedRows, 0);
    const mine = await asUser<{ id: string; start_selfie_url: string }>(db, g, `SELECT id, start_selfie_url FROM shifts WHERE id = $1`, [
      id
    ]);
    assert.deepEqual(mine.rows, [{ id, start_selfie_url: path }]);
  });

  test('guard ends their own shift exactly once (replay of the same clock-out is harmless, a second end is refused)', async () => {
    const g = fx.users.guardA;
    const shiftId = await startShiftAs(db, g, fx.siteA1, { actualStart: new Date(Date.now() - 3_600_000).toISOString() });
    const endAt = new Date(Date.now() - 60_000).toISOString();
    const endSql = `UPDATE shifts SET actual_end = $2, end_selfie_url = $3, end_latitude = -25.68, end_longitude = 27.81,
                                      end_accuracy_meters = 9, status = 'completed'
                    WHERE id = $1 AND guard_id = $4 AND actual_end IS NULL
                    RETURNING id`;
    const endPath = `${fx.orgA}/${fx.siteA1}/selfie/${g}/${randomUUID()}-end_selfie.jpg`;
    const first = await tryAsUser<{ id: string }>(db, g, endSql, [shiftId, endAt, endPath, g]);
    assertAllowed(first);
    assert.deepEqual(first.rows, [{ id: shiftId }]);

    // The sync engine's replay filter (actual_end IS NULL) matches nothing the second time.
    const replay = await tryAsUser(db, g, endSql, [shiftId, endAt, endPath, g]);
    assertNoRows(replay);

    // A different end time / status reversal is refused by the trigger.
    assertRefused(
      await tryAsUser(db, g, `UPDATE shifts SET actual_end = now() WHERE id = $1`, [shiftId]),
      '42501',
      'second clock-out'
    );
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET status = 'active', actual_end = NULL WHERE id = $1`, [shiftId]));
    const r = await asSuperuser<{ status: string; actual_end: Date }>(db, `SELECT status, actual_end FROM shifts WHERE id = $1`, [shiftId]);
    assert.equal(r.rows[0].status, 'completed');
    assert.equal(r.rows[0].actual_end.toISOString(), endAt);
  });

  test('clock-out before clock-in or in the future is refused', async () => {
    const g = fx.users.guardA;
    const shiftId = await startShiftAs(db, g, fx.siteA1);
    assertRefused(
      await tryAsUser(db, g, `UPDATE shifts SET actual_end = now() - interval '2 hours', status = 'completed' WHERE id = $1`, [shiftId]),
      '23514'
    );
    assertRefused(
      await tryAsUser(db, g, `UPDATE shifts SET actual_end = now() + interval '1 hour', status = 'completed' WHERE id = $1`, [shiftId]),
      '23514'
    );
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET status = 'completed' WHERE id = $1`, [shiftId]), '23514');
  });

  test('supervisor of the site can see and correct shifts of that site only', async () => {
    const s = fx.users.supA;
    const seen = await asUser<{ id: string }>(db, s, `SELECT id FROM shifts WHERE id IN ($1, $2, $3)`, [fx.shiftA2, fx.shiftA3, fx.shiftB]);
    assert.deepEqual(seen.rows, [{ id: fx.shiftA2 }]);
    const r = await tryAsUser(db, s, `UPDATE shifts SET notes = 'Guard phoned in sick at 02:00' WHERE id = $1`, [fx.shiftA2]);
    assertAllowed(r);
    assert.equal(r.affectedRows, 1);
  });
});

describe('guard: patrol scans', () => {
  let shiftId: string;

  before(async () => {
    shiftId = await startShiftAs(db, fx.users.guardA, fx.siteA1, {
      actualStart: new Date(Date.now() - 2 * 3_600_000).toISOString()
    });
  });

  test('guard scans an active checkpoint of their site during the shift; the server overwrites client distance, confidence, validity and time', async () => {
    const g = fx.users.guardA;
    const token = await qrToken(fx.checkpoints.cpA1);
    const far = pointNorthOf(fx.cpLat, fx.cpLng, 200);
    const { id, outcome } = await insertScan(g, {
      shiftId,
      checkpointId: fx.checkpoints.cpA1,
      latitude: far.latitude,
      longitude: far.longitude,
      accuracy: 20,
      clientDistance: 0,
      clientConfidence: 'verified',
      clientValid: true,
      clientServerTime: '2000-01-01T00:00:00Z',
      rawPayload: token
    });
    assertAllowed(outcome);
    assert.equal(outcome.affectedRows, 1);
    const r = await asUser<{
      site_id: string;
      distance_to_checkpoint_meters: number;
      gps_confidence: string;
      is_valid_proximity: boolean;
      checkpoint_radius_meters: number;
      server_age_s: number;
      payload_verified: boolean;
    }>(
      db,
      g,
      `SELECT site_id, distance_to_checkpoint_meters, gps_confidence, is_valid_proximity, checkpoint_radius_meters,
              extract(epoch FROM (now() - scan_timestamp_server))::float8 AS server_age_s, payload_verified
       FROM patrol_scans WHERE id = $1`,
      [id]
    );
    const row = r.rows[0];
    assert.equal(row.site_id, fx.siteA1);
    assert.ok(Math.abs(row.distance_to_checkpoint_meters - 200) < 0.01, `distance ${row.distance_to_checkpoint_meters}`);
    assert.equal(row.gps_confidence, 'outside');
    assert.equal(row.is_valid_proximity, false);
    assert.equal(row.checkpoint_radius_meters, 50);
    assert.ok(row.server_age_s >= 0 && row.server_age_s < 60, `server timestamp is ${row.server_age_s}s old`);
    assert.equal(row.payload_verified, true);
  });

  test('a replayed scan (same offline_uuid) is ignored, not duplicated', async () => {
    const g = fx.users.guardA;
    const first = await insertScan(g, { shiftId, checkpointId: fx.checkpoints.cpA1 });
    assertAllowed(first.outcome);
    const replay = await insertScan(g, { id: first.id, shiftId, checkpointId: fx.checkpoints.cpA1 });
    assertAllowed(replay.outcome);
    assert.equal(replay.outcome.affectedRows, 0);
    const n = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_scans WHERE offline_uuid = $1`, [first.id]);
    assert.equal(n.rows[0].n, 1);
  });

  test('a QR payload that does not match the checkpoint is stored as unverified', async () => {
    const g = fx.users.guardA;
    const { id, outcome } = await insertScan(g, {
      shiftId,
      checkpointId: fx.checkpoints.cpA1,
      rawPayload: 'EE-CP-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
    });
    assertAllowed(outcome);
    const r = await asSuperuser<{ payload_verified: boolean }>(db, `SELECT payload_verified FROM patrol_scans WHERE id = $1`, [id]);
    assert.equal(r.rows[0].payload_verified, false);
  });

  test("Dawie's legacy card (PLAAS-CP:<code>) is accepted but never counts as verified (its codes are public)", async () => {
    const g = fx.users.guardA;
    const { id, outcome } = await insertScan(g, {
      shiftId,
      checkpointId: fx.checkpoints.cpA1,
      payloadType: 'legacy_qr',
      rawPayload: 'PLAAS-CP:CP1'
    });
    assertAllowed(outcome);
    const r = await asSuperuser<{ payload_verified: boolean; payload_type: string; raw_payload: string }>(
      db,
      `SELECT payload_verified, payload_type, raw_payload FROM patrol_scans WHERE id = $1`,
      [id]
    );
    assert.deepEqual(r.rows[0], { payload_verified: false, payload_type: 'legacy_qr', raw_payload: 'PLAAS-CP:CP1' });
  });

  test('scan with a checkpoint from another site or organisation is denied (same answer for both)', async () => {
    const { outcome } = await insertScan(fx.users.guardA, { shiftId, checkpointId: fx.checkpoints.cpA2 });
    assertRefused(outcome, '42501');
    const { outcome: otherOrg } = await insertScan(fx.users.guardA, { shiftId, checkpointId: fx.checkpoints.cpB1 });
    assertRefused(otherOrg, '42501');
    assert.equal(!outcome.ok && !otherOrg.ok && outcome.message === otherOrg.message, true, 'identical error messages');
  });

  test('scan outside the shift time window is denied', async () => {
    const before = await insertScan(fx.users.guardA, {
      shiftId,
      checkpointId: fx.checkpoints.cpA1,
      deviceTime: new Date(Date.now() - 3 * 3_600_000).toISOString()
    });
    assertRefused(before.outcome, '23514', 'scan before clock-in');
    const future = await insertScan(fx.users.guardA, {
      shiftId,
      checkpointId: fx.checkpoints.cpA1,
      deviceTime: new Date(Date.now() + 3_600_000).toISOString()
    });
    assertRefused(future.outcome, '23514', 'scan in the future');
  });

  test('scan after the shift ended is denied', async () => {
    const g = fx.users.guardA;
    const ended = await startShiftAs(db, g, fx.siteA1, { actualStart: new Date(Date.now() - 5 * 3_600_000).toISOString() });
    await asUser(db, g, `UPDATE shifts SET actual_end = now() - interval '2 hours', status = 'completed' WHERE id = $1`, [ended]);
    const late = await insertScan(g, { shiftId: ended, checkpointId: fx.checkpoints.cpA1 });
    assertRefused(late.outcome, '23514');
    const during = await insertScan(g, {
      shiftId: ended,
      checkpointId: fx.checkpoints.cpA1,
      deviceTime: new Date(Date.now() - 3 * 3_600_000).toISOString()
    });
    assertAllowed(during.outcome, 'scan recorded offline during the shift and synced after clock-out');
  });

  test('scan on an inactive checkpoint is denied', async () => {
    const { outcome } = await insertScan(fx.users.guardA, { shiftId, checkpointId: fx.checkpoints.cpA1Inactive });
    assertRefused(outcome, '23514');
  });

  test('guard reads only their own scans; supervisor and client viewer of the site read them', async () => {
    const own = await asUser<{ guard_id: string }>(db, fx.users.guardA, `SELECT DISTINCT guard_id FROM patrol_scans`);
    assert.deepEqual(own.rows, [{ guard_id: fx.users.guardA }]);
    const sup = await asUser<{ n: number }>(db, fx.users.supA, `SELECT count(*)::int AS n FROM patrol_scans WHERE shift_id = $1`, [shiftId]);
    assert.ok(sup.rows[0].n > 0);
    const viewer = await asUser<{ n: number }>(db, fx.users.viewerA, `SELECT count(*)::int AS n FROM patrol_scans WHERE shift_id = $1`, [
      shiftId
    ]);
    assert.equal(viewer.rows[0].n, sup.rows[0].n);
    assertNoRows(await tryAsUser(db, fx.users.adminB, `SELECT * FROM patrol_scans WHERE shift_id = $1`, [shiftId]));
  });
});

describe('incidents, SOS and acknowledgement', () => {
  test('guard reports an incident, attaches a photo and a replay is ignored (idempotent sync)', async () => {
    const g = fx.users.guardA;
    const shiftId = await startShiftAs(db, g, fx.siteA1);
    const incidentId = randomUUID();
    const sql = `INSERT INTO incidents (id, offline_uuid, site_id, shift_id, guard_id, incident_type, severity, description,
                                        latitude, longitude, accuracy_meters, status, reported_at)
                 VALUES ($1, $1, $2, $3, $4, 'fence', 'high', 'Fence cut near CP6', -25.68, 27.81, 15, 'reported', now())
                 ON CONFLICT (offline_uuid) DO NOTHING`;
    const first = await tryAsUser(db, g, sql, [incidentId, fx.siteA1, shiftId, g]);
    assertAllowed(first);
    assert.equal(first.affectedRows, 1);
    const replay = await tryAsUser(db, g, sql, [incidentId, fx.siteA1, shiftId, g]);
    assertAllowed(replay);
    assert.equal(replay.affectedRows, 0);

    const mediaSql = `INSERT INTO incident_media (id, incident_id, media_url, media_type, file_size_bytes)
                      VALUES ($1, $2, $3, 'image/jpeg', 123456) ON CONFLICT (id) DO NOTHING`;
    const mediaId = randomUUID();
    const path = `${fx.orgA}/${fx.siteA1}/incident/${g}/${incidentId}-photo_1.jpg`;
    const media = await tryAsUser(db, g, mediaSql, [mediaId, incidentId, path]);
    assertAllowed(media, 'incident_media insert by the incident owner');
    assert.equal(media.affectedRows, 1);
    assertAllowed(await tryAsUser(db, g, mediaSql, [mediaId, incidentId, path]), 'incident_media replay');

    // Supervisor and client viewer of the site can see the photo link; a colleague cannot add photos.
    const sup = await asUser<{ media_url: string }>(db, fx.users.supA, `SELECT media_url FROM incident_media WHERE incident_id = $1`, [
      incidentId
    ]);
    assert.deepEqual(sup.rows, [{ media_url: path }]);
    const viewer = await asUser<{ n: number }>(db, fx.users.viewerA, `SELECT count(*)::int AS n FROM incident_media WHERE incident_id = $1`, [
      incidentId
    ]);
    assert.equal(viewer.rows[0].n, 1);
    assertRefused(await tryAsUser(db, fx.users.guardA2, mediaSql, [randomUUID(), incidentId, path]), '42501', 'colleague adds photo');
    assertNoRows(await tryAsUser(db, fx.users.guardA2, `SELECT * FROM incident_media WHERE incident_id = $1`, [incidentId]));
  });

  test('supervisor of the assigned site acknowledges an SOS as themselves; the server stamps the time', async () => {
    const g = fx.users.guardA;
    const s = fx.users.supA;
    const alertId = randomUUID();
    assertAllowed(
      await tryAsUser(
        db,
        g,
        `INSERT INTO panic_alerts (id, offline_uuid, site_id, guard_id, latitude, longitude, accuracy_meters, status, triggered_at)
         VALUES ($1, $1, $2, $3, -25.68, 27.81, 30, 'active', now()) ON CONFLICT (offline_uuid) DO NOTHING`,
        [alertId, fx.siteA1, g]
      ),
      'guard triggers SOS'
    );
    const seen = await asUser<{ id: string }>(db, s, `SELECT id FROM panic_alerts WHERE id = $1`, [alertId]);
    assert.equal(seen.rows.length, 1);

    const ack = await tryAsUser<{ acknowledged_by: string; age_s: number }>(
      db,
      s,
      `UPDATE panic_alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = '2000-01-01T00:00:00Z'
       WHERE id = $1
       RETURNING acknowledged_by, extract(epoch FROM (now() - acknowledged_at))::float8 AS age_s`,
      [alertId, s]
    );
    assertAllowed(ack);
    assert.equal(ack.rows[0].acknowledged_by, s);
    assert.ok(ack.rows[0].age_s >= 0 && ack.rows[0].age_s < 60, 'acknowledged_at is server time');

    const audit = await asSuperuser<{ action: string; actor_id: string }>(
      db,
      `SELECT action, actor_id FROM audit_logs WHERE resource_id = $1`,
      [alertId]
    );
    assert.deepEqual(audit.rows, [{ action: 'panic_alert.status_changed', actor_id: s }]);

    // The guard sees the acknowledgement on their own alert.
    const guardView = await asUser<{ status: string }>(db, g, `SELECT status FROM panic_alerts WHERE id = $1`, [alertId]);
    assert.deepEqual(guardView.rows, [{ status: 'acknowledged' }]);
  });

  test("supervisor cannot acknowledge in someone else's name or edit the guard's SOS / incident report", async () => {
    const s = fx.users.supA;
    const alertId = randomUUID();
    await asUser(
      db,
      fx.users.guardA,
      `INSERT INTO panic_alerts (id, offline_uuid, site_id, guard_id, latitude, longitude, triggered_at)
       VALUES ($1, $1, $2, $3, -25.68, 27.81, now())`,
      [alertId, fx.siteA1, fx.users.guardA]
    );
    assertRefused(
      await tryAsUser(db, s, `UPDATE panic_alerts SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1`, [alertId, fx.users.adminA])
    );
    assertRefused(await tryAsUser(db, s, `UPDATE panic_alerts SET latitude = -26.2 WHERE id = $1`, [alertId]));
    assertRefused(await tryAsUser(db, s, `UPDATE panic_alerts SET triggered_at = now() - interval '1 day' WHERE id = $1`, [alertId]));
    assertRefused(await tryAsUser(db, s, `UPDATE incidents SET description = 'nothing happened' WHERE id = $1`, [fx.incidentA2]));
    assertRefused(await tryAsUser(db, s, `UPDATE incidents SET severity = 'low' WHERE id = $1`, [fx.incidentA2]));
    assertRefused(await tryAsUser(db, s, `UPDATE incidents SET guard_id = $2 WHERE id = $1`, [fx.incidentA2, s]));

    const ok = await tryAsUser(
      db,
      s,
      `UPDATE incidents SET status = 'investigating', acknowledged_by = $2, supervisor_notes = 'Checked the fence' WHERE id = $1`,
      [fx.incidentA2, s]
    );
    assertAllowed(ok, 'supervisor updates status and notes');
    assert.equal(ok.affectedRows, 1);
    const r = await asSuperuser<{ description: string; status: string }>(db, `SELECT description, status FROM incidents WHERE id = $1`, [
      fx.incidentA2
    ]);
    assert.deepEqual(r.rows[0], { description: 'Cut fence at north boundary', status: 'investigating' });
  });

  test('client_viewer reads incidents, scans, shifts and gate entries of the assigned site but no SOS alerts', async () => {
    const v = fx.users.viewerA;
    const incidents = await asUser<{ id: string }>(db, v, `SELECT id FROM incidents WHERE id = $1`, [fx.incidentA2]);
    assert.equal(incidents.rows.length, 1);
    const scans = await asUser<{ id: string }>(db, v, `SELECT id FROM patrol_scans WHERE id = $1`, [fx.scanA2]);
    assert.equal(scans.rows.length, 1);
    const gate = await asUser<{ id: string }>(db, v, `SELECT id FROM gate_entries WHERE id = $1`, [fx.gateA2]);
    assert.equal(gate.rows.length, 1);
    const shifts = await asUser<{ id: string }>(db, v, `SELECT id FROM shifts WHERE id = $1`, [fx.shiftA2]);
    assert.equal(shifts.rows.length, 1);
    // Names only, through site_people(); never the profile rows (phone / employee numbers).
    const people = await asUser<{ user_id: string; first_name: string; last_name: string }>(
      db,
      v,
      `SELECT user_id, first_name, last_name FROM public.site_people($1)`,
      [fx.siteA1]
    );
    assert.ok(
      people.rows.some((p) => p.user_id === fx.users.guardA2 && p.last_name === 'guardA2'),
      'viewer sees names of guards on the shared site'
    );
    assert.deepEqual(Object.keys(people.rows[0]).sort(), ['first_name', 'last_name', 'user_id']);
    assertNoRows(await tryAsUser(db, v, `SELECT id FROM profiles WHERE id <> $1`, [v]), 'viewer reading colleague profiles');
    assertNoRows(await tryAsUser(db, v, `SELECT * FROM public.site_people($1)`, [fx.siteA2]), 'site_people of another site');
    assertNoRows(await tryAsUser(db, v, `SELECT * FROM panic_alerts`));
    assertNoRows(await tryAsUser(db, v, `SELECT * FROM incidents WHERE site_id IN ($1, $2)`, [fx.siteA2, fx.siteB1]));
    assertNoRows(await tryAsUser(db, v, `SELECT * FROM user_roles WHERE user_id <> $1`, [v]));
  });
});

describe('gate log', () => {
  test('guard reads the gate log of their own site across shifts (vehicles still on site)', async () => {
    const r = await asUser<{ id: string; guard_id: string }>(db, fx.users.guardA, `SELECT id, guard_id FROM gate_entries WHERE id = $1`, [
      fx.gateA2
    ]);
    assert.deepEqual(r.rows, [{ id: fx.gateA2, guard_id: fx.users.guardA2 }]);
  });

  test('vehicle exit is a new OUT row linked to the IN row of the same site; replays are ignored', async () => {
    const g = fx.users.guardA;
    const shiftId = await startShiftAs(db, g, fx.siteA1);
    const outId = randomUUID();
    const sql = `INSERT INTO gate_entries (id, offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time,
                                           exit_time, dwell_duration_seconds, linked_entry_id, latitude, longitude, accuracy_meters,
                                           register_number, vehicle_description, is_disc_scanned)
                 VALUES ($1, $1, $2, $3, $4, 'out', 'CA 123-456', now() - interval '20 minutes', now(), 1200, $5,
                         -25.68, 27.81, 11, 'ABC123X', 'Hatch back', true)
                 ON CONFLICT (offline_uuid) DO NOTHING`;
    const first = await tryAsUser(db, g, sql, [outId, fx.siteA1, shiftId, g, fx.gateA2]);
    assertAllowed(first);
    assert.equal(first.affectedRows, 1);
    const replay = await tryAsUser(db, g, sql, [outId, fx.siteA1, shiftId, g, fx.gateA2]);
    assertAllowed(replay);
    assert.equal(replay.affectedRows, 0);

    // Linking to an OUT row, or an IN row are refused.
    const bad = await tryAsUser(db, g, sql, [randomUUID(), fx.siteA1, shiftId, g, outId]);
    assertRefused(bad, '23514');
    const inWithLink = await tryAsUser(
      db,
      g,
      `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time, linked_entry_id)
       VALUES (gen_random_uuid(), $1, $2, 'in', 'X', now(), $3)`,
      [fx.siteA1, g, fx.gateA2]
    );
    assertRefused(inWithLink, '23514');
  });
});

describe('admin management', () => {
  test('admin grants and revokes roles for users of their organisation', async () => {
    const a = fx.users.adminA;
    const target = fx.users.guardA3;
    assertAllowed(await tryAsUser(db, a, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [target]), 'grant');
    const roles = await asUser<{ role: string }>(db, a, `SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`, [target]);
    assert.deepEqual(
      roles.rows.map((r) => r.role),
      ['supervisor', 'guard']
    );
    const revoke = await tryAsUser(db, a, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'supervisor'`, [target]);
    assertAllowed(revoke, 'revoke');
    assert.equal(revoke.affectedRows, 1);
  });

  test('super_admin can grant super_admin to another user of the organisation', async () => {
    const r = await tryAsUser(db, fx.users.superA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'super_admin')`, [fx.users.adminA]);
    assertAllowed(r);
    await asSuperuser(db, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'super_admin'`, [fx.users.adminA]);
  });

  test('admin assigns a guard to a site; the supervisor of that site sees the assignment', async () => {
    const a = fx.users.adminA;
    assertAllowed(
      await tryAsUser(db, a, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA1, fx.users.guardA3]),
      'assign'
    );
    const sup = await asUser<{ n: number }>(db, fx.users.supA, `SELECT count(*)::int AS n FROM site_assignments WHERE user_id = $1`, [
      fx.users.guardA3
    ]);
    assert.equal(sup.rows[0].n, 1, 'supervisor sees only the assignment on the site they manage');
    const del = await tryAsUser(db, a, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, fx.users.guardA3]);
    assertAllowed(del, 'unassign');
    assert.equal(del.affectedRows, 1);
  });

  test('admin deactivates a guard, who is then locked out; only a super_admin can deactivate a super_admin', async () => {
    const a = fx.users.adminA;
    const target = fx.users.guardA3;
    const off = await tryAsUser(db, a, `UPDATE profiles SET is_active = false WHERE id = $1`, [target]);
    assertAllowed(off);
    assert.equal(off.affectedRows, 1);
    assertNoRows(await tryAsUser(db, target, `SELECT * FROM shifts`));
    assertAllowed(await tryAsUser(db, a, `UPDATE profiles SET is_active = true WHERE id = $1`, [target]));
    const back = await asUser<{ n: number }>(db, target, `SELECT count(*)::int AS n FROM shifts`);
    assert.ok(back.rows[0].n >= 1);

    assertRefused(await tryAsUser(db, a, `UPDATE profiles SET is_active = false WHERE id = $1`, [fx.users.superA]));
    const audit = await asSuperuser<{ action: string }>(
      db,
      `SELECT action FROM audit_logs WHERE resource_id = $1 AND resource_type = 'profiles' ORDER BY created_at, action`,
      [target]
    );
    assert.deepEqual(
      audit.rows.map((r) => r.action).sort(),
      ['profile.deactivated', 'profile.reactivated']
    );
  });

  test('admin creates a site that is immediately readable (INSERT ... RETURNING)', async () => {
    const r = await tryAsUser<{ id: string }>(
      db,
      fx.users.adminA,
      `INSERT INTO sites (organisation_id, name, code) VALUES ($1, 'New farm', 'NF-1') RETURNING id`,
      [fx.orgA]
    );
    assertAllowed(r);
    assert.equal(r.rows.length, 1);
    assertRefused(
      await tryAsUser(db, fx.users.adminA, `INSERT INTO sites (organisation_id, name, code) VALUES ($1, 'Foreign', 'F-1')`, [fx.orgB])
    );
  });
});

describe('sync bookkeeping', () => {
  test('user logs their own sync run and cannot log one for somebody else', async () => {
    const g = fx.users.guardA;
    assertAllowed(
      await tryAsUser(
        db,
        g,
        `INSERT INTO sync_events (device_id, user_id, events_count, successful_count, failed_count, status)
         VALUES ('dev-1', $1, 3, 3, 0, 'completed')`,
        [g]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO sync_events (device_id, user_id, events_count, successful_count, failed_count, status)
         VALUES ('dev-1', $1, 3, 3, 0, 'completed')`,
        [fx.users.guardA2]
      )
    );
    const admin = await asUser<{ n: number }>(db, fx.users.adminA, `SELECT count(*)::int AS n FROM sync_events WHERE user_id = $1`, [g]);
    assert.equal(admin.rows[0].n, 1);
  });
});
