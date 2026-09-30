/**
 * Offline sync against the database: the sync engine re-sends events after a lost response
 * and uploads events captured hours earlier. A replay of a stored event must be a no-op
 * whatever changed since, and evidence captured under the rules of its time must still be
 * accepted after a later change (checkpoint deactivated, shift abandoned by a supervisor,
 * guard unassigned). Statements are the sync engine's own (INSERT ... ON CONFLICT DO NOTHING,
 * clock-out UPDATE ... WHERE actual_end IS NULL RETURNING id).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, cloneTestDb, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertRefused, startShiftAs } from './assertions';
import { buildEvidencePath } from '@/lib/storage/evidence';

let base: PGlite;
let fx: Fixture;

before(async () => {
  base = await createTestDb();
  fx = await seedTwoTenantFixture(base);
});
after(async () => {
  await base.close();
});

async function withCopy(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await cloneTestDb(base);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The sync engine's scan upsert (id = offline_uuid = queue item id). */
function syncScan(db: PGlite, guardId: string, id: string, shiftId: string, checkpointId: string, deviceTime: string) {
  return tryAsUser(
    db,
    guardId,
    `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type)
     VALUES ($1, $1, $2, $3, $4, $5, 'qr', 'secure_token')
     ON CONFLICT (offline_uuid) DO NOTHING`,
    [id, shiftId, checkpointId, guardId, deviceTime]
  );
}

function syncIncident(db: PGlite, guardId: string, id: string, shiftId: string | null, reportedAt: string) {
  return tryAsUser(
    db,
    guardId,
    `INSERT INTO incidents (id, offline_uuid, site_id, shift_id, guard_id, incident_type, description, status, reported_at)
     VALUES ($1, $1, $2, $3, $4, 'fence', 'Cut fence', 'reported', $5)
     ON CONFLICT (offline_uuid) DO NOTHING`,
    [id, fx.siteA1, shiftId, guardId, reportedAt]
  );
}

function syncPanic(db: PGlite, guardId: string, id: string, shiftId: string | null, triggeredAt: string) {
  return tryAsUser(
    db,
    guardId,
    `INSERT INTO panic_alerts (id, offline_uuid, site_id, shift_id, guard_id, status, triggered_at)
     VALUES ($1, $1, $2, $3, $4, 'active', $5)
     ON CONFLICT (offline_uuid) DO NOTHING`,
    [id, fx.siteA1, shiftId, guardId, triggeredAt]
  );
}

function syncGate(db: PGlite, guardId: string, id: string, shiftId: string | null, entryTime: string) {
  return tryAsUser(
    db,
    guardId,
    `INSERT INTO gate_entries (id, offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time)
     VALUES ($1, $1, $2, $3, $4, 'in', 'ND 123-456', $5)
     ON CONFLICT (offline_uuid) DO NOTHING`,
    [id, fx.siteA1, shiftId, guardId, entryTime]
  );
}

function syncClockOut(db: PGlite, guardId: string, shiftId: string, endedAt: string) {
  return tryAsUser<{ id: string }>(
    db,
    guardId,
    `UPDATE shifts SET actual_end = $2, status = 'completed', end_latitude = -25.68, end_longitude = 27.81
     WHERE id = $1 AND guard_id = $3 AND actual_end IS NULL
     RETURNING id`,
    [shiftId, endedAt, guardId]
  );
}

async function count(db: PGlite, table: string, id: string): Promise<number> {
  const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id]);
  return r.rows[0].n;
}

describe('replays of stored events are no-ops, whatever changed since', () => {
  test('scan replay after the checkpoint was deactivated and after the guard was unassigned', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1, { actualStart: minutesAgo(120) });
      const scanId = randomUUID();
      assertAllowed(await syncScan(db, g, scanId, shift, fx.checkpoints.cpA1, minutesAgo(30)));

      await asUser(db, fx.users.adminA, `UPDATE checkpoints SET is_active = false WHERE id = $1`, [fx.checkpoints.cpA1]);
      const afterDeactivation = await syncScan(db, g, scanId, shift, fx.checkpoints.cpA1, minutesAgo(30));
      assertAllowed(afterDeactivation, 'replay after deactivation');
      assert.equal(afterDeactivation.affectedRows, 0);

      await asUser(db, fx.users.adminA, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, g]);
      const afterUnassign = await syncScan(db, g, scanId, shift, fx.checkpoints.cpA1, minutesAgo(30));
      assertAllowed(afterUnassign, 'replay after unassignment');
      assert.equal(afterUnassign.affectedRows, 0);
      assert.equal(await count(db, 'patrol_scans', scanId), 1);
    }));

  test('clock-in, incident, SOS, gate entry and incident photo replays after the guard was unassigned and the shift completed', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shiftId = randomUUID();
      const clockInSql = `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
                          VALUES ($1, $2, $3, 'night', now() - interval '2 hours', now() + interval '10 hours', $4, 'active')
                          ON CONFLICT (id) DO NOTHING`;
      assertAllowed(await tryAsUser(db, g, clockInSql, [shiftId, fx.siteA1, g, minutesAgo(90)]));
      const incidentId = randomUUID();
      const panicId = randomUUID();
      const gateId = randomUUID();
      assertAllowed(await syncIncident(db, g, incidentId, shiftId, minutesAgo(60)));
      assertAllowed(await syncPanic(db, g, panicId, shiftId, minutesAgo(50)));
      assertAllowed(await syncGate(db, g, gateId, shiftId, minutesAgo(40)));
      const photo = buildEvidencePath({
        organisationId: fx.orgA,
        siteId: fx.siteA1,
        category: 'incident',
        userId: g,
        eventId: incidentId,
        field: 'photo_1'
      });
      const mediaId = randomUUID();
      const mediaSql = `INSERT INTO incident_media (id, incident_id, media_url, media_type) VALUES ($1, $2, $3, 'image/jpeg')
                        ON CONFLICT (id) DO NOTHING`;
      assertAllowed(await tryAsUser(db, g, mediaSql, [mediaId, incidentId, photo]));
      assertAllowed(await syncClockOut(db, g, shiftId, minutesAgo(10)));

      await asUser(db, fx.users.adminA, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, g]);

      for (const [label, outcome] of [
        ['clock-in', await tryAsUser(db, g, clockInSql, [shiftId, fx.siteA1, g, minutesAgo(90)])],
        ['incident', await syncIncident(db, g, incidentId, shiftId, minutesAgo(60))],
        ['sos', await syncPanic(db, g, panicId, shiftId, minutesAgo(50))],
        ['gate', await syncGate(db, g, gateId, shiftId, minutesAgo(40))],
        ['photo', await tryAsUser(db, g, mediaSql, [mediaId, incidentId, photo])]
      ] as const) {
        assertAllowed(outcome, `${label} replay`);
        assert.equal(outcome.affectedRows, 0, `${label} replay wrote a row`);
      }
      // The clock-out replay matches nothing (actual_end is set) and the engine then sees its own end time.
      const replayOut = await syncClockOut(db, g, shiftId, minutesAgo(10));
      assertAllowed(replayOut);
      assert.equal(replayOut.rows.length, 0);
    }));
});

describe('queued evidence captured before a change still syncs', () => {
  test('a scan captured before its checkpoint was deactivated is accepted; one captured after is refused', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1, { actualStart: minutesAgo(120) });
      await asUser(db, fx.users.adminA, `UPDATE checkpoints SET is_active = false WHERE id = $1`, [fx.checkpoints.cpA1]);
      assertAllowed(await syncScan(db, g, randomUUID(), shift, fx.checkpoints.cpA1, minutesAgo(15)), 'captured before');
      assertRefused(await syncScan(db, g, randomUUID(), shift, fx.checkpoints.cpA1, minutesAgo(-1)), '23514', 'captured after');
      // The deactivation time is the server's, not the admin's.
      const r = await asSuperuser<{ age_s: number }>(
        db,
        `SELECT extract(epoch FROM now() - deactivated_at)::float8 AS age_s FROM checkpoints WHERE id = $1`,
        [fx.checkpoints.cpA1]
      );
      assert.ok(r.rows[0].age_s >= 0 && r.rows[0].age_s < 60);
      await asUser(db, fx.users.adminA, `UPDATE checkpoints SET deactivated_at = now() + interval '1 year' WHERE id = $1`, [
        fx.checkpoints.cpA1
      ]);
      const forged = await asSuperuser<{ age_s: number }>(
        db,
        `SELECT extract(epoch FROM now() - deactivated_at)::float8 AS age_s FROM checkpoints WHERE id = $1`,
        [fx.checkpoints.cpA1]
      );
      assert.ok(forged.rows[0].age_s >= 0, 'deactivated_at cannot be moved by a client');
    }));

  test('after a supervisor marks the shift abandoned, the guard\'s queued scans and clock-out still land', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1, { actualStart: minutesAgo(180) });
      assertAllowed(
        await tryAsUser(db, fx.users.supA, `UPDATE shifts SET status = 'abandoned', notes = 'No answer on the radio' WHERE id = $1`, [shift])
      );
      assertAllowed(await syncScan(db, g, randomUUID(), shift, fx.checkpoints.cpA1, minutesAgo(60)), 'queued scan');
      const out = await syncClockOut(db, g, shift, minutesAgo(5));
      assertAllowed(out, 'queued clock-out');
      assert.deepEqual(out.rows, [{ id: shift }]);
      const r = await asSuperuser<{ status: string; notes: string }>(db, `SELECT status, notes FROM shifts WHERE id = $1`, [shift]);
      assert.deepEqual(r.rows[0], { status: 'completed', notes: 'No answer on the radio' });
    }));

  test('an unassigned guard still syncs evidence tied to their own shift at the site, but cannot start anything new there', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1, { actualStart: minutesAgo(240) });
      await asUser(db, fx.users.adminA, `DELETE FROM site_assignments WHERE site_id = $1 AND user_id = $2`, [fx.siteA1, g]);

      assertAllowed(await syncScan(db, g, randomUUID(), shift, fx.checkpoints.cpA1, minutesAgo(200)), 'queued scan');
      const incidentId = randomUUID();
      assertAllowed(await syncIncident(db, g, incidentId, shift, minutesAgo(190)), 'queued incident');
      assertAllowed(await syncPanic(db, g, randomUUID(), shift, minutesAgo(185)), 'queued SOS');
      assertAllowed(await syncGate(db, g, randomUUID(), shift, minutesAgo(180)), 'queued gate entry');
      // Its photo upload is still allowed (recent shift at the site) ...
      const upload = await tryAsUser(
        db,
        g,
        `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('evidence-media', $1, $2)`,
        [
          buildEvidencePath({ organisationId: fx.orgA, siteId: fx.siteA1, category: 'incident', userId: g, eventId: incidentId, field: 'photo_1' }),
          g
        ]
      );
      assertAllowed(upload, 'queued photo upload');
      assertAllowed(await syncClockOut(db, g, shift, minutesAgo(1)), 'queued clock-out');

      // ... but nothing new without a shift, and no new shift.
      assertRefused(await syncIncident(db, g, randomUUID(), null, minutesAgo(1)), '42501', 'new incident without a shift');
      assertRefused(await syncPanic(db, g, randomUUID(), null, minutesAgo(1)), '42501', 'new SOS without a shift');
      assertRefused(await syncGate(db, g, randomUUID(), null, minutesAgo(1)), '42501', 'new gate entry without a shift');
      assertRefused(
        await tryAsUser(
          db,
          g,
          `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, status)
           VALUES (gen_random_uuid(), $1, $2, 'day', now(), now() + interval '12 hours', 'active')`,
          [fx.siteA1, g]
        ),
        '42501',
        'new clock-in'
      );
      assertRefused(
        await tryAsUser(db, g, `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('evidence-media', $1, $2)`, [
          buildEvidencePath({ organisationId: fx.orgA, siteId: fx.siteA2, category: 'incident', userId: g, eventId: randomUUID(), field: 'photo_1' }),
          g
        ]),
        '42501',
        'upload for a site without a shift'
      );
    }));

  test('an SOS whose clock-in is not on the server yet is stored without the shift link instead of being refused', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const panicId = randomUUID();
      const r = await syncPanic(db, g, panicId, randomUUID(), minutesAgo(2));
      assertAllowed(r, 'SOS with an unsynced shift id');
      assert.equal(r.affectedRows, 1);
      const row = await asSuperuser<{ shift_id: string | null; status: string }>(
        db,
        `SELECT shift_id, status FROM panic_alerts WHERE id = $1`,
        [panicId]
      );
      assert.deepEqual(row.rows[0], { shift_id: null, status: 'active' });
      const sup = await asUser<{ id: string }>(db, fx.users.supA, `SELECT id FROM panic_alerts WHERE id = $1`, [panicId]);
      assert.equal(sup.rows.length, 1, 'the site supervisor sees it');
    }));

  test('a disabled guard\'s replay is a no-op, but nothing new is accepted from a disabled account', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const incidentId = randomUUID();
      assertAllowed(await syncIncident(db, g, incidentId, null, minutesAgo(5)));
      await asUser(db, fx.users.adminA, `UPDATE profiles SET is_active = false WHERE id = $1`, [g]);
      const replay = await syncIncident(db, g, incidentId, null, minutesAgo(5));
      assertAllowed(replay);
      assert.equal(replay.affectedRows, 0);
      assertRefused(await syncIncident(db, g, randomUUID(), null, minutesAgo(1)), '42501');
    }));
});
