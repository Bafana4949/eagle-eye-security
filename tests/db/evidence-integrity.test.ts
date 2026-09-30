/**
 * Evidence integrity: server-controlled timestamps and time bounds, one open shift per
 * guard, compliance schedules taken from the site configuration (checked against the
 * production shift calculator), and evidence photo paths bound to their own event.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, cloneTestDb, createTestDb, tryAsUser, type QueryOutcome } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertRefused, startShiftAs } from './assertions';
import { determineShiftForClockIn, type SiteShiftConfig } from '@/features/shifts/shiftCalculator';
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

function assertRefusedWithHint(outcome: QueryOutcome<unknown>, code: string, hint: string, label: string): void {
  assertRefused(outcome, code, label);
  if (!outcome.ok) assert.equal(outcome.hint, hint, `${label}: hint`);
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('evidence timestamps', () => {
  test('created_at is server time on scans, incidents, SOS, gate entries and shifts (client values ignored)', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1);
      const age = async (sql: string, params: unknown[]) => {
        const r = await asUser<{ age_s: number }>(db, g, sql, params);
        return r.rows[0].age_s;
      };
      const RETURNING = `RETURNING extract(epoch FROM now() - created_at)::float8 AS age_s`;
      for (const [label, sql, params] of [
        [
          'scan',
          `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now(), 'qr', 'secure_token', '2020-01-01') ${RETURNING}`,
          [shift, fx.checkpoints.cpA1, g]
        ],
        [
          'incident',
          `INSERT INTO incidents (offline_uuid, site_id, shift_id, guard_id, incident_type, reported_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'fence', now(), '2020-01-01') ${RETURNING}`,
          [fx.siteA1, shift, g]
        ],
        [
          'sos',
          `INSERT INTO panic_alerts (offline_uuid, site_id, shift_id, guard_id, triggered_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now(), '2019-06-01') ${RETURNING}`,
          [fx.siteA1, shift, g]
        ],
        [
          'gate',
          `INSERT INTO gate_entries (offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'in', 'X 1', now(), '2001-01-01') ${RETURNING}`,
          [fx.siteA1, shift, g]
        ]
      ] as const) {
        const a = await age(sql, [...params]);
        assert.ok(a >= 0 && a < 60, `${label} created_at is ${a}s old`);
      }
    }));

  test('device times ahead of the server (phone clock wrong) are refused with hint device_clock_ahead; an SOS is clamped instead', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
           VALUES (gen_random_uuid(), $1, $2, 'day', now(), now() + interval '12 hours', now() + interval '11 minutes', 'active')`,
          [fx.siteA1, g]
        ),
        '23514',
        'device_clock_ahead',
        'clock-in 11 minutes ahead'
      );
      const shift = await startShiftAs(db, g, fx.siteA1);
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type)
           VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '11 minutes', 'qr', 'secure_token')`,
          [shift, fx.checkpoints.cpA1, g]
        ),
        '23514',
        'device_clock_ahead',
        'scan ahead'
      );
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at)
           VALUES (gen_random_uuid(), $1, $2, 'fence', now() + interval '30 days')`,
          [fx.siteA1, g]
        ),
        '23514',
        'device_clock_ahead',
        'incident 30 days ahead'
      );
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time)
           VALUES (gen_random_uuid(), $1, $2, 'in', 'X 2', now() + interval '1 day')`,
          [fx.siteA1, g]
        ),
        '23514',
        'device_clock_ahead',
        'gate entry ahead'
      );
      const sos = await asUser<{ ahead_s: number }>(
        db,
        g,
        `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '5 days')
         RETURNING extract(epoch FROM triggered_at - now())::float8 AS ahead_s`,
        [fx.siteA1, g]
      );
      assert.ok(Math.abs(sos.rows[0].ahead_s) < 1, 'an SOS from a phone with a fast clock is stored at server time');
    }));

  test('evidence older than the offline limit (7 days) is refused with hint device_time_too_old, including backdated shifts', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
           VALUES (gen_random_uuid(), $1, $2, 'day', now() - interval '365 days', now(), now() - interval '365 days', 'active')`,
          [fx.siteA1, g]
        ),
        '23514',
        'device_time_too_old',
        'shift backdated by a year'
      );
      for (const [label, sql] of [
        ['incident', `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at) VALUES (gen_random_uuid(), $1, $2, 'x', now() - interval '8 days')`],
        ['sos', `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at) VALUES (gen_random_uuid(), $1, $2, '2019-06-01')`],
        ['gate', `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time) VALUES (gen_random_uuid(), $1, $2, 'in', 'X', '2001-01-01')`]
      ] as const) {
        assertRefusedWithHint(await tryAsUser(db, g, sql, [fx.siteA1, g]), '23514', 'device_time_too_old', label);
      }
      // A shift six days old (phone offline for most of a week) still syncs.
      const old = await tryAsUser(
        db,
        g,
        `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
         VALUES (gen_random_uuid(), $1, $2, 'night', now() - interval '6 days', now() - interval '6 days' + interval '12 hours',
                 now() - interval '6 days', 'active')`,
        [fx.siteA1, g]
      );
      assertAllowed(old, 'six-day-old clock-in');
    }));

  test('evidence linked to a shift must fall inside it (a scan 200 days before an old clock-in is refused)', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1, { actualStart: hoursAgo(3) });
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO incidents (offline_uuid, site_id, shift_id, guard_id, incident_type, reported_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'x', now() - interval '4 hours')`,
          [fx.siteA1, shift, g]
        ),
        '23514',
        'outside_shift_window',
        'incident an hour before clock-in'
      );
      assertRefusedWithHint(
        await tryAsUser(
          db,
          g,
          `INSERT INTO gate_entries (offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time)
           VALUES (gen_random_uuid(), $1, $2, $3, 'in', 'X', now() - interval '4 hours')`,
          [fx.siteA1, shift, g]
        ),
        '23514',
        'outside_shift_window',
        'gate entry an hour before clock-in'
      );
    }));

  test('gate log: exit before entry is refused and dwell time is computed by the server', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      assertRefused(
        await tryAsUser(
          db,
          g,
          `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time, exit_time)
           VALUES (gen_random_uuid(), $1, $2, 'out', 'X', now() - interval '1 hour', now() - interval '2 hours')`,
          [fx.siteA1, g]
        ),
        '23514'
      );
      const r = await asUser<{ dwell_duration_seconds: number }>(
        db,
        g,
        `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time, exit_time,
                                   dwell_duration_seconds, linked_entry_id)
         VALUES (gen_random_uuid(), $1, $2, 'out', 'CA 123-456', now() - interval '20 minutes', now() - interval '5 minutes', -5, $3)
         RETURNING dwell_duration_seconds`,
        [fx.siteA1, g, fx.gateA2]
      );
      assert.equal(r.rows[0].dwell_duration_seconds, 900);
    }));
});

describe('one open shift per guard', () => {
  test('a new clock-in closes the older open shift (audited); a late older clock-in is stored as superseded; queued clock-outs still land', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const s1 = await startShiftAs(db, g, fx.siteA1, { actualStart: hoursAgo(3) });
      const s2 = await startShiftAs(db, g, fx.siteA1, { actualStart: hoursAgo(1) });
      const late = await startShiftAs(db, g, fx.siteA1, { actualStart: hoursAgo(5) });
      const status = async () =>
        Object.fromEntries(
          (await asSuperuser<{ id: string; status: string }>(db, `SELECT id, status FROM shifts WHERE guard_id = $1`, [g])).rows.map(
            (row) => [row.id, row.status]
          )
        );
      assert.deepEqual(await status(), { [s1]: 'abandoned', [s2]: 'active', [late]: 'abandoned' });

      const audit = await asSuperuser<{ action: string; actor_id: string }>(
        db,
        `SELECT action, actor_id FROM audit_logs WHERE resource_id = $1 AND resource_type = 'shifts' AND action = 'shift.status_changed'`,
        [s1]
      );
      assert.deepEqual(audit.rows, [{ action: 'shift.status_changed', actor_id: g }]);

      // The clock-out of s1 recorded offline before s2 started still completes it.
      const out = await tryAsUser(
        db,
        g,
        `UPDATE shifts SET actual_end = $2, status = 'completed' WHERE id = $1 AND guard_id = $3 AND actual_end IS NULL RETURNING id`,
        [s1, hoursAgo(1.5), g]
      );
      assertAllowed(out);
      assert.equal(out.rows.length, 1);
      const open = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM shifts WHERE guard_id = $1 AND status = 'active'`, [g]);
      assert.equal(open.rows[0].n, 1);
    }));
});

describe('shift schedule comes from the site configuration', () => {
  async function siteConfig(db: PGlite, siteId: string): Promise<SiteShiftConfig> {
    const r = await asSuperuser<{ ds: string; de: string; ns: string; ne: string }>(
      db,
      `SELECT day_shift_start::text AS ds, day_shift_end::text AS de, night_shift_start::text AS ns, night_shift_end::text AS ne
       FROM sites WHERE id = $1`,
      [siteId]
    );
    const row = r.rows[0];
    return { dayShiftStart: row.ds, dayShiftEnd: row.de, nightShiftStart: row.ns, nightShiftEnd: row.ne };
  }

  async function clockIn(db: PGlite, at: Date, type: string, start: Date, end: Date) {
    const id = randomUUID();
    await asUser(
      db,
      fx.users.guardA,
      `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
       VALUES ($1, $2, $3, $4::shift_type_enum, $5, $6, $7, 'active')`,
      [id, fx.siteA1, fx.users.guardA, type, start.toISOString(), end.toISOString(), at.toISOString()]
    );
    const r = await asSuperuser<{ shift_type: string; s: Date; e: Date; corrected: number }>(
      db,
      `SELECT shift_type, scheduled_start AS s, scheduled_end AS e,
              (SELECT count(*)::int FROM audit_logs WHERE resource_id = $1 AND action = 'shift.schedule_corrected') AS corrected
       FROM shifts WHERE id = $1`,
      [id]
    );
    const row = r.rows[0];
    return { type: row.shift_type, start: row.s.getTime(), end: row.e.getTime(), corrected: row.corrected };
  }

  // Default site times and a site with gaps between its shifts.
  for (const [label, times] of [
    ['06:00-18:00 / 18:00-06:00', null],
    ['07:00-15:00 / 19:00-05:00 (gaps)', ['07:00', '15:00', '19:00', '05:00']]
  ] as const) {
    test(`the app's own schedule choice is kept and a forged 1-minute schedule is replaced by the same choice (${label})`, () =>
      withCopy(async (db) => {
        if (times) {
          await asSuperuser(
            db,
            `UPDATE sites SET day_shift_start = $2, day_shift_end = $3, night_shift_start = $4, night_shift_end = $5 WHERE id = $1`,
            [fx.siteA1, ...times]
          );
        }
        const config = await siteConfig(db, fx.siteA1);
        // Clock-in instants every 50 minutes over the last 40 hours (all SAST times of day).
        for (let minutesAgo = 5; minutesAgo < 40 * 60; minutesAgo += 50) {
          const at = new Date(Date.now() - minutesAgo * 60_000);
          const choice = determineShiftForClockIn(config, at.getTime());
          const kept = await clockIn(db, at, choice.shiftType, new Date(choice.scheduledStart), new Date(choice.scheduledEnd));
          assert.deepEqual(
            kept,
            { type: choice.shiftType, start: choice.scheduledStart, end: choice.scheduledEnd, corrected: 0 },
            `app choice at ${at.toISOString()}`
          );
          if (choice.alternative) {
            const alt = choice.alternative;
            const altKept = await clockIn(db, at, alt.shiftType, new Date(alt.scheduledStart), new Date(alt.scheduledEnd));
            assert.deepEqual(altKept, { type: alt.shiftType, start: alt.scheduledStart, end: alt.scheduledEnd, corrected: 0 });
          }
          const forged = await clockIn(db, at, 'custom', at, new Date(at.getTime() + 60_000));
          assert.deepEqual(
            forged,
            { type: choice.shiftType, start: choice.scheduledStart, end: choice.scheduledEnd, corrected: 1 },
            `forged schedule at ${at.toISOString()}`
          );
        }
      }));
  }
});

describe('evidence photo paths are bound to their own event', () => {
  test('a clock-in / clock-out selfie must be a new object in the guard\'s own folder for this site', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const g = u.guardA;
      const selfie = (owner: string, site: string, org: string = fx.orgA, eventId: string = randomUUID()) =>
        buildEvidencePath({ organisationId: org, siteId: site, category: 'selfie', userId: owner, eventId, field: 'selfie' });
      const clockIn = (path: string) =>
        tryAsUser(
          db,
          g,
          `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, start_selfie_url, status)
           VALUES (gen_random_uuid(), $1, $2, 'night', now(), now() + interval '12 hours', now(), $3, 'active')`,
          [fx.siteA1, g, path]
        );
      // guardA2's real clock-in selfie.
      await asSuperuser(db, `UPDATE shifts SET start_selfie_url = $2 WHERE id = $1`, [
        fx.shiftA2,
        selfie(u.guardA2, fx.siteA1, fx.orgA, fx.shiftA2)
      ]);
      assertRefused(await clockIn(selfie(u.guardA2, fx.siteA1, fx.orgA, fx.shiftA2)), '23514', "colleague's selfie");
      assertRefused(await clockIn(selfie(g, fx.siteB1, fx.orgB)), '23514', 'foreign organisation folder');
      assertRefused(await clockIn(selfie(g, fx.siteA2)), '23514', 'other site folder');
      assertRefused(await clockIn('https://example.test/selfie.jpg'), '23514', 'a URL instead of a storage path');
      assertRefused(
        await clockIn(buildEvidencePath({ organisationId: fx.orgA, siteId: fx.siteA1, category: 'incident', userId: g, eventId: randomUUID(), field: 'selfie' })),
        '23514',
        'wrong category'
      );

      const first = selfie(g, fx.siteA1);
      assertAllowed(await clockIn(first), 'own new selfie');
      assertRefused(await clockIn(first), '23514', "replaying yesterday's selfie on a new clock-in");

      const shift = await asSuperuser<{ id: string }>(db, `SELECT id FROM shifts WHERE start_selfie_url = $1`, [first]);
      const clockOut = (path: string) =>
        tryAsUser(db, g, `UPDATE shifts SET actual_end = now(), status = 'completed', end_selfie_url = $2 WHERE id = $1`, [
          shift.rows[0].id,
          path
        ]);
      assertRefused(await clockOut(first), '23514', 'clock-out with the clock-in selfie');
      assertAllowed(await clockOut(selfie(g, fx.siteA1)), 'new clock-out selfie');
    }));

  test('incident photos must be the incident\'s own upload (right incident, organisation, site, guard, type and size)', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const media = (incidentId: string, path: string, type = 'image/jpeg', size: number | null = 1234) =>
        tryAsUser(
          db,
          u.guardA2,
          `INSERT INTO incident_media (id, incident_id, media_url, media_type, file_size_bytes) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [incidentId, path, type, size]
        );
      const path = (over: Partial<Parameters<typeof buildEvidencePath>[0]> = {}) =>
        buildEvidencePath({
          organisationId: fx.orgA,
          siteId: fx.siteA1,
          category: 'incident',
          userId: u.guardA2,
          eventId: fx.incidentA2,
          field: 'photo_1',
          ...over
        });
      assertRefused(await media(fx.incidentA2, path({ organisationId: fx.orgB, siteId: fx.siteB1, userId: u.guardB })), '23514', 'org B path');
      assertRefused(await media(fx.incidentA2, path({ eventId: randomUUID() })), '23514', 'another event');
      assertRefused(await media(fx.incidentA2, path({ userId: u.guardA })), '23514', "a colleague's folder");
      assertRefused(await media(fx.incidentA2, path({ category: 'selfie' })), '23514', 'a selfie');
      assertRefused(await media(fx.incidentA2, path(), 'text/html'), '23514', 'not an image');
      assertRefused(await media(fx.incidentA2, path(), 'image/jpeg', 50 * 1024 * 1024), '23514', 'too large');
      assertRefused(await media(fx.incidentB, path()), '42501', "someone else's incident");
      assertAllowed(await media(fx.incidentA2, path()), 'own photo of own incident');
    }));

  test('a vehicle photo must be uploaded for this very gate entry', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const id = randomUUID();
      const gate = (entryId: string, photoEventId: string) =>
        tryAsUser(
          db,
          g,
          `INSERT INTO gate_entries (id, offline_uuid, site_id, guard_id, direction, license_plate, entry_time, vehicle_photo_url)
           VALUES ($1, $1, $2, $3, 'in', 'CA 1', now(), $4)`,
          [
            entryId,
            fx.siteA1,
            g,
            buildEvidencePath({ organisationId: fx.orgA, siteId: fx.siteA1, category: 'vehicle', userId: g, eventId: photoEventId, field: 'photo' })
          ]
        );
      assertRefused(await gate(id, randomUUID()), '23514', 'photo of another event');
      assertAllowed(await gate(id, id), 'photo of this entry');
    }));
});
