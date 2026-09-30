/**
 * The supervisor dashboard's and client viewer portal's PRODUCTION queries and writes
 * (./queries.ts) run against the real migrations (RLS, column privileges, triggers) through the
 * PGlite-backed supabase-js stand-in of tests/db/pgSupabase.ts, as each role:
 *
 *   - every selected column exists and is readable by the role (a missing column or a column
 *     privilege would fail the whole load);
 *   - rows of sites the caller is not assigned to never arrive, even when the page asks for them;
 *   - supervisors read guard names from profiles, client viewers through site_people() and never
 *     receive SOS alerts or selfie paths;
 *   - acknowledge / investigating / resolve write only status and notes, the server stamps who
 *     and when, and a write RLS filters away is reported as NOT saved.
 *
 * No network: the database is in-process. Fixture rows are inserted as the operator would.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, createTestDb } from '../../../../tests/db/harness';
import { seedTwoTenantFixture, type Fixture } from '../../../../tests/db/fixtures';
import { PgSupabase } from '../../../../tests/db/pgSupabase';
import { loadIdentity } from '@/lib/auth/identity';
import type { Site } from '@/types/models';
import { buildShiftReports, sitesById, splitPanicAlerts, vehiclePresence } from './derive';
import { loadSupervisorSnapshot, loadViewerSnapshot, updateIncident, updatePanicAlert } from './queries';

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

/** The sites the app would show this user (same query as AuthProvider). */
async function visibleSites(userId: string): Promise<Site[]> {
  const result = await loadIdentity(as(userId).client, { id: userId, email: null });
  assert.equal(result.kind, 'ok', `identity of ${userId} should load`);
  return result.kind === 'ok' ? result.snapshot.sites : [];
}

/** A new incident at site A1 by guardA2 (operator insert: the guard flow is covered elsewhere). */
async function newIncident(description: string): Promise<string> {
  const id = randomUUID();
  await asSuperuser(
    db,
    `INSERT INTO incidents (id, offline_uuid, site_id, shift_id, guard_id, incident_type, severity, description, reported_at)
     VALUES ($1, $1, $2, $3, $4, 'person', 'high', $5, now() - interval '3 minutes')`,
    [id, fx.siteA1, fx.shiftA2, fx.users.guardA2, description]
  );
  return id;
}

async function incidentRow(id: string) {
  const result = await asSuperuser<{ status: string; acknowledged_by: string | null; supervisor_notes: string | null }>(
    db,
    `SELECT status::text AS status, acknowledged_by, supervisor_notes FROM incidents WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

async function panicRow(id: string) {
  const result = await asSuperuser<{ status: string; acknowledged_by: string | null; resolution_notes: string | null }>(
    db,
    `SELECT status::text AS status, acknowledged_by, resolution_notes FROM panic_alerts WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

describe('supervisor snapshot (loadSupervisorSnapshot) under real RLS', () => {
  test('a supervisor gets the rows of the assigned site, with guard names, and nothing from other sites', async () => {
    const sites = await visibleSites(fx.users.supA);
    assert.deepEqual(sites.map((s) => s.id), [fx.siteA1]);

    const snap = await loadSupervisorSnapshot(as(fx.users.supA).client, [fx.siteA1]);
    assert.deepEqual(snap.partial, []);
    assert.ok(snap.shifts.some((s) => s.id === fx.shiftA2), 'the colleague shift at A1 is listed');
    assert.ok(snap.shifts.every((s) => s.site_id === fx.siteA1));
    const scan = snap.scans.find((s) => s.id === fx.scanA2);
    assert.ok(scan, 'the scan of shift A2 is listed');
    assert.equal(scan.site_id, fx.siteA1, 'site_id is set by the server');
    assert.equal(scan.payload_type, 'secure_token');
    assert.equal(scan.payload_verified, false, 'no raw payload was sent, so the server did not verify it');
    assert.equal(scan.gps_confidence, 'no_fix', 'no position was sent: the server classifies it, not the page');
    assert.ok(snap.checkpoints.some((c) => c.id === fx.checkpoints.cpA1 && c.name === 'Main gate'));
    assert.ok(snap.checkpoints.every((c) => !('qr_code_hash' in c) && !('nfc_uid' in c)), 'no checkpoint secrets');
    assert.ok(snap.incidents.some((i) => i.id === fx.incidentA2 && i.status === 'reported'));
    assert.ok(snap.gateEntries.some((g) => g.id === fx.gateA2 && g.direction === 'in'));
    assert.deepEqual(snap.panicAlerts, [], 'the only SOS is at site A2, which is not assigned to this supervisor');
    assert.deepEqual(
      { first: snap.people[fx.users.guardA2]?.firstName, last: snap.people[fx.users.guardA2]?.lastName },
      { first: 'Guard', last: 'guardA2' }
    );

    const reports = buildShiftReports(snap, sitesById(sites), Date.now());
    const report = reports.find((r) => r.shift.id === fx.shiftA2);
    assert.ok(report);
    assert.equal(report.problem, null);
    assert.ok(report.stats, 'patrol stats are computed from the site configuration in the database');
    assert.ok(report.isOpen);
  });

  test('asking for a site the supervisor is not assigned to returns none of its rows (RLS, not the page, decides)', async () => {
    const snap = await loadSupervisorSnapshot(as(fx.users.supA).client, [fx.siteA1, fx.siteA2, fx.siteB1]);
    assert.ok(!snap.shifts.some((s) => s.id === fx.shiftA3 || s.id === fx.shiftB));
    assert.ok(!snap.incidents.some((i) => i.id === fx.incidentB));
    assert.deepEqual(snap.panicAlerts, []);
    assert.ok(!snap.checkpoints.some((c) => c.site_id !== fx.siteA1));
    assert.equal(snap.people[fx.users.guardA3], undefined, 'no name of a guard on an unassigned site');
    assert.equal(snap.people[fx.users.guardB], undefined, 'no name from another organisation');
  });

  test('an org admin sees every site of the organisation, including an SOS stored without its shift link', async () => {
    const orphanSos = randomUUID();
    await asSuperuser(
      db,
      `INSERT INTO panic_alerts (id, offline_uuid, site_id, shift_id, guard_id, triggered_at)
       VALUES ($1, $1, $2, NULL, $3, now() - interval '1 minute')`,
      [orphanSos, fx.siteA1, fx.users.guardA]
    );
    const sites = await visibleSites(fx.users.adminA);
    assert.deepEqual(new Set(sites.map((s) => s.id)), new Set([fx.siteA1, fx.siteA2]));
    const snap = await loadSupervisorSnapshot(
      as(fx.users.adminA).client,
      sites.map((s) => s.id)
    );
    const active = splitPanicAlerts(snap.panicAlerts).active.map((p) => p.id);
    assert.ok(active.includes(fx.panicA3));
    assert.ok(active.includes(orphanSos), 'an SOS with shift_id NULL is still shown');
    assert.equal(snap.panicAlerts.find((p) => p.id === orphanSos)?.shift_id, null);
    assert.equal(snap.people[fx.users.guardA3]?.lastName, 'guardA3');
    assert.ok(!snap.incidents.some((i) => i.id === fx.incidentB), 'nothing from organisation B');
  });

  test('a vehicle whose exit is linked to its entry is no longer on the premises', async () => {
    const inId = randomUUID();
    const outId = randomUUID();
    await asSuperuser(
      db,
      `INSERT INTO gate_entries (id, offline_uuid, site_id, guard_id, direction, license_plate, entry_time)
       VALUES ($1, $1, $2, $3, 'in', 'ND 55-12', now() - interval '2 hours')`,
      [inId, fx.siteA1, fx.users.guardA2]
    );
    await asSuperuser(
      db,
      `INSERT INTO gate_entries (id, offline_uuid, site_id, guard_id, direction, license_plate, entry_time, exit_time, linked_entry_id)
       VALUES ($1, $1, $2, $3, 'out', 'ND 55-12', now() - interval '2 hours', now() - interval '30 minutes', $4)`,
      [outId, fx.siteA1, fx.users.guardA2, inId]
    );
    const snap = await loadSupervisorSnapshot(as(fx.users.supA).client, [fx.siteA1]);
    const out = snap.gateEntries.find((g) => g.id === outId);
    assert.equal(out?.linked_entry_id, inId);
    assert.equal(out?.dwell_duration_seconds, 5400, 'dwell time is computed by the server');
    const presence = vehiclePresence(snap.gateEntries, Date.now());
    assert.ok(!presence.onSite.some((v) => v.entry.id === inId), 'the linked IN is not on site any more');
    assert.ok(presence.onSite.some((v) => v.entry.id === fx.gateA2), 'the IN without an exit is still on site');
  });
});

describe('supervisor writes (updateIncident / updatePanicAlert)', () => {
  test('acknowledge → investigating → resolve with notes; the server records who acknowledged and when', async () => {
    const id = await newIncident('Person at the north fence');
    const client = as(fx.users.supA).client;

    const ack = await updateIncident(client, id, { status: 'acknowledged' });
    assert.ok(ack.ok, ack.ok ? '' : ack.message);
    assert.equal(ack.row.status, 'acknowledged');
    assert.equal(ack.row.acknowledged_by, fx.users.supA, 'acknowledged_by is stamped by the server');
    assert.ok(ack.row.acknowledged_at, 'acknowledged_at is server time');

    const investigating = await updateIncident(client, id, { status: 'investigating' });
    assert.ok(investigating.ok);
    assert.equal(investigating.row.acknowledged_at, ack.row.acknowledged_at, 'the acknowledgement is not moved');

    const resolved = await updateIncident(client, id, { status: 'resolved', supervisorNotes: 'Reaction unit found nobody.' });
    assert.ok(resolved.ok);
    assert.equal(resolved.row.status, 'resolved');
    assert.equal(resolved.row.supervisor_notes, 'Reaction unit found nobody.');
    assert.equal(resolved.row.description, 'Person at the north fence', "the guard's report is unchanged");

    const note = await updateIncident(client, id, { supervisorNotes: 'Fence checked again at 04:00.' });
    assert.ok(note.ok, 'a note can be edited after resolving');
    assert.deepEqual(await incidentRow(id), {
      status: 'resolved',
      acknowledged_by: fx.users.supA,
      supervisor_notes: 'Fence checked again at 04:00.'
    });

    const snap = await loadSupervisorSnapshot(client, [fx.siteA1]);
    assert.equal(snap.incidents.find((i) => i.id === id)?.status, 'resolved', 'resolved incidents stay in the 7-day history');
  });

  test('a write RLS filters away is reported as not saved (supervisor on another site, viewer, guard)', async () => {
    const sosOnA2 = await updatePanicAlert(as(fx.users.supA).client, fx.panicA3, { status: 'acknowledged' });
    assert.deepEqual(sosOnA2.ok ? 'saved' : sosOnA2.problem, 'no_rows');
    assert.equal((await panicRow(fx.panicA3)).status, 'active', 'the SOS on the unassigned site was not touched');

    const id = await newIncident('Gate chain cut');
    for (const userId of [fx.users.viewerA, fx.users.guardA2]) {
      const result = await updateIncident(as(userId).client, id, { status: 'acknowledged', supervisorNotes: 'x' });
      assert.equal(result.ok, false, `${userId} must not be able to handle incidents`);
    }
    assert.deepEqual(await incidentRow(id), { status: 'reported', acknowledged_by: null, supervisor_notes: null });
  });

  test('an admin acknowledges and then resolves an SOS with notes', async () => {
    const client = as(fx.users.adminA).client;
    const ack = await updatePanicAlert(client, fx.panicA3, { status: 'acknowledged' });
    assert.ok(ack.ok, ack.ok ? '' : ack.message);
    assert.equal(ack.row.acknowledged_by, fx.users.adminA);
    assert.ok(ack.row.acknowledged_at);

    const resolved = await updatePanicAlert(client, fx.panicA3, { status: 'resolved', resolutionNotes: 'Guard safe, false alarm.' });
    assert.ok(resolved.ok);
    assert.deepEqual(await panicRow(fx.panicA3), {
      status: 'resolved',
      acknowledged_by: fx.users.adminA,
      resolution_notes: 'Guard safe, false alarm.'
    });
  });
});

describe('client viewer snapshot (loadViewerSnapshot)', () => {
  test('read-only report of the assigned site: names via site_people, no SOS, no selfie paths or phone numbers', async () => {
    const sites = await visibleSites(fx.users.viewerA);
    assert.deepEqual(sites.map((s) => s.id), [fx.siteA1]);
    const snap = await loadViewerSnapshot(as(fx.users.viewerA).client, [fx.siteA1]);
    assert.ok(snap.shifts.some((s) => s.id === fx.shiftA2));
    assert.ok(snap.shifts.every((s) => !('start_selfie_url' in s) && !('end_selfie_url' in s)));
    assert.ok(snap.scans.some((s) => s.id === fx.scanA2));
    assert.ok(snap.incidents.some((i) => i.id === fx.incidentA2));
    assert.ok(snap.gateEntries.some((g) => g.id === fx.gateA2));
    assert.deepEqual(snap.panicAlerts, []);
    const guard = snap.people[fx.users.guardA2];
    assert.deepEqual({ first: guard?.firstName, last: guard?.lastName, phone: guard?.phone }, {
      first: 'Guard',
      last: 'guardA2',
      phone: undefined
    });
    assert.ok(!snap.partial.includes('people'), 'every name was found through site_people()');
  });

  test('even the supervisor loader returns no SOS alerts to a client viewer (RLS), and names still resolve', async () => {
    const snap = await loadSupervisorSnapshot(as(fx.users.viewerA).client, [fx.siteA1]);
    assert.deepEqual(snap.panicAlerts, []);
    assert.equal(snap.people[fx.users.guardA2]?.lastName, 'guardA2', 'profiles are not readable; site_people() is used');
    assert.equal(snap.people[fx.users.guardA2]?.phone, undefined);
  });
});
