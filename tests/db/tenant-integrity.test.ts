/**
 * Regression tests for the second security review of the hardening migration: tenant hops
 * by admins, shift reassignment / evidence rewrites by managers, super_admin removal,
 * acknowledgement forgery, existence oracles and inconsistent scan records. Each test runs
 * the attack exactly as the reviewer did (as the attacking user, PostgREST semantics) on its
 * own copy of the two-tenant fixture.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asServiceRole, asSuperuser, asUser, cloneTestDb, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertNoRows, assertRefused, startShiftAs } from './assertions';

let base: PGlite;
let fx: Fixture;

before(async () => {
  base = await createTestDb();
  fx = await seedTwoTenantFixture(base);
});
after(async () => {
  await base.close();
});

/** Runs `fn` on a private copy of the fixture database. */
async function withCopy(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await cloneTestDb(base);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

describe('organisation hops', () => {
  test('an org admin or super_admin cannot move their own profile into another organisation', () =>
    withCopy(async (db) => {
      const u = fx.users;
      for (const who of [u.adminA, u.superA]) {
        assertRefused(
          await tryAsUser(db, who, `UPDATE profiles SET organisation_id = $1 WHERE id = $2`, [fx.orgB, who]),
          '42501',
          `hop by ${who}`
        );
        const r = await asSuperuser<{ organisation_id: string }>(db, `SELECT organisation_id FROM profiles WHERE id = $1`, [who]);
        assert.equal(r.rows[0].organisation_id, fx.orgA);
      }
      // ... nor move a colleague, and org B stays invisible and untouchable.
      assertRefused(await tryAsUser(db, u.adminA, `UPDATE profiles SET organisation_id = $1 WHERE id = $2`, [fx.orgB, u.guardA]));
      assertNoRows(await tryAsUser(db, u.adminA, `SELECT id FROM incidents WHERE id = $1`, [fx.incidentB]));
      assertRefused(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [u.guardB]));
      assertNoRows(await tryAsUser(db, u.adminA, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.adminB]));
      const audit = await asSuperuser<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'profile.organisation_changed'`
      );
      assert.equal(audit.rows[0].n, 0);
    }));

  test('only the service role moves a user between organisations, and the move is audited in both', () =>
    withCopy(async (db) => {
      const u = fx.users;
      await asServiceRole(db, `UPDATE profiles SET organisation_id = $1 WHERE id = $2`, [fx.orgB, u.guardA3]);
      const r = await asSuperuser<{ organisation_id: string; action: string }>(
        db,
        `SELECT organisation_id, action FROM audit_logs WHERE resource_id = $1 AND action = 'profile.organisation_changed'
         ORDER BY organisation_id`,
        [u.guardA3]
      );
      assert.deepEqual(r.rows.map((row) => row.organisation_id).sort(), [fx.orgA, fx.orgB].sort());
    }));
});

describe('managers cannot rewrite or reassign shifts', () => {
  test('supervisor and admin cannot hand a shift to another guard (same or other organisation), move it or rewrite its clock-in evidence', () =>
    withCopy(async (db) => {
      const u = fx.users;
      for (const manager of [u.supA, u.adminA]) {
        for (const [assignment, params] of [
          [`guard_id = $2`, [u.guardB]],
          [`guard_id = $2`, [u.guardA]],
          [`site_id = $2`, [fx.siteA2]],
          [`actual_start = now() - interval '6 hours'`, []],
          [`start_latitude = 1, start_longitude = 2`, []],
          [`start_accuracy_meters = 1`, []],
          [`start_selfie_url = 'x/y/z'`, []],
          [`scheduled_end = now()`, []],
          [`shift_type = 'day'`, []]
        ] as const) {
          assertRefused(
            await tryAsUser(db, manager, `UPDATE shifts SET ${assignment} WHERE id = $1`, [fx.shiftA2, ...params]),
            '42501',
            `${manager}: ${assignment}`
          );
        }
        // The clock-out is the guard's own evidence.
        assertRefused(
          await tryAsUser(db, manager, `UPDATE shifts SET actual_end = now(), status = 'completed' WHERE id = $1`, [fx.shiftA2]),
          '42501',
          `${manager} writes the clock-out`
        );
      }
      assertNoRows(await tryAsUser(db, u.guardB, `SELECT id FROM shifts WHERE id = $1`, [fx.shiftA2]));
      const r = await asSuperuser<{ guard_id: string; site_id: string; status: string }>(
        db,
        `SELECT guard_id, site_id, status FROM shifts WHERE id = $1`,
        [fx.shiftA2]
      );
      assert.deepEqual(r.rows[0], { guard_id: u.guardA2, site_id: fx.siteA1, status: 'active' });
    }));

  test('a supervisor may only mark an open shift abandoned (or undo that) and add notes; every change is audited with old and new values', () =>
    withCopy(async (db) => {
      const s = fx.users.supA;
      const abandon = await tryAsUser(
        db,
        s,
        `UPDATE shifts SET status = 'abandoned', notes = 'Guard left the site at 02:00' WHERE id = $1`,
        [fx.shiftA2]
      );
      assertAllowed(abandon);
      assert.equal(abandon.affectedRows, 1);
      assertAllowed(await tryAsUser(db, s, `UPDATE shifts SET status = 'active' WHERE id = $1`, [fx.shiftA2]), 'undo');
      assertRefused(await tryAsUser(db, s, `UPDATE shifts SET status = 'completed' WHERE id = $1`, [fx.shiftA2]), '23514');

      const audit = await asSuperuser<{ action: string; actor_id: string; details: { from: string; to: string; changes: Record<string, unknown> } }>(
        db,
        `SELECT action, actor_id, details FROM audit_logs WHERE resource_id = $1 AND resource_type = 'shifts' ORDER BY created_at, id`,
        [fx.shiftA2]
      );
      assert.equal(audit.rows.length, 2);
      assert.deepEqual(
        audit.rows.map((row) => [row.action, row.actor_id, row.details.from, row.details.to]).sort(),
        [
          ['shift.status_changed', s, 'abandoned', 'active'],
          ['shift.status_changed', s, 'active', 'abandoned']
        ].sort()
      );
      assert.ok(audit.rows.some((row) => 'notes' in row.details.changes), 'the note is part of the audited change');
    }));
});

describe('super_admin protection and user deletion', () => {
  test('an org admin can neither deactivate nor delete a super_admin', () =>
    withCopy(async (db) => {
      const u = fx.users;
      assertRefused(await tryAsUser(db, u.adminA, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.superA]));
      assertNoRows(await tryAsUser(db, u.adminA, `DELETE FROM profiles WHERE id = $1`, [u.superA]));
      const roles = await asSuperuser<{ role: string }>(db, `SELECT role FROM user_roles WHERE user_id = $1`, [u.superA]);
      assert.deepEqual(roles.rows, [{ role: 'super_admin' }]);
    }));

  test('a deleted profile leaves an audit row naming the roles and site assignments that went with it', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const del = await tryAsUser(db, u.adminA, `DELETE FROM profiles WHERE id = $1`, [u.viewerA]);
      assertAllowed(del);
      assert.equal(del.affectedRows, 1);
      const r = await asUser<{ action: string; actor_id: string; details: Record<string, unknown> }>(
        db,
        u.adminA,
        `SELECT action, actor_id, details FROM audit_logs WHERE resource_id = $1 AND action = 'profile.deleted'`,
        [u.viewerA]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].actor_id, u.adminA);
      assert.deepEqual(r.rows[0].details.roles_removed, ['client_viewer']);
      assert.deepEqual(r.rows[0].details.site_assignments_removed, [fx.siteA1]);
    }));

  test('a super_admin (or the operator deleting the auth user) can delete an admin who has audit history; attribution survives', () =>
    withCopy(async (db) => {
      const u = fx.users;
      assertAllowed(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [u.guardA3]));
      const before = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1`, [u.adminA]);
      assert.ok(before.rows[0].n > 0);

      const del = await tryAsUser(db, u.superA, `DELETE FROM profiles WHERE id = $1`, [u.adminA]);
      assertAllowed(del, 'super_admin deletes an admin with audit history');
      assert.equal(del.affectedRows, 1);
      const kept = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1`, [u.adminA]);
      assert.equal(kept.rows[0].n, before.rows[0].n, 'audit rows keep the deleted actor id');

      // Supabase Dashboard "Delete user" (auth.users cascade) for another admin with history.
      assertAllowed(await tryAsUser(db, u.adminB, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [u.guardB]));
      await asSuperuser(db, `DELETE FROM auth.users WHERE id = $1`, [u.adminB]);
      const gone = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM profiles WHERE id = $1`, [u.adminB]);
      assert.equal(gone.rows[0].n, 0);
    }));
});

describe('acknowledgements are written once, by the acknowledging user, at server time', () => {
  async function sos(db: PGlite, triggeredAgo = '2 hours'): Promise<string> {
    const id = randomUUID();
    await asSuperuser(
      db,
      `INSERT INTO panic_alerts (id, offline_uuid, site_id, shift_id, guard_id, triggered_at)
       VALUES ($1, $1, $2, $3, $4, now() - $5::interval)`,
      [id, fx.siteA1, fx.shiftA2, fx.users.guardA2, triggeredAgo]
    );
    return id;
  }

  test('a supervisor cannot backdate, clear or take over an acknowledgement', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const id = await sos(db);
      assertAllowed(
        await tryAsUser(db, u.supA, `UPDATE panic_alerts SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1`, [id, u.supA])
      );
      const stored = async () =>
        (
          await asSuperuser<{ acknowledged_by: string; ack_age_s: number; status: string }>(
            db,
            `SELECT acknowledged_by, status, extract(epoch FROM now() - acknowledged_at)::float8 AS ack_age_s
             FROM panic_alerts WHERE id = $1`,
            [id]
          )
        ).rows[0];
      const first = await stored();
      assert.equal(first.acknowledged_by, u.supA);
      assert.ok(first.ack_age_s >= 0 && first.ack_age_s < 60);

      // acknowledged_at is server-controlled: backdating it (or setting it without acknowledging) is refused.
      assertRefused(
        await tryAsUser(db, u.supA, `UPDATE panic_alerts SET acknowledged_at = triggered_at + interval '15 seconds' WHERE id = $1`, [id])
      );
      const afterBackdate = await stored();
      assert.ok(afterBackdate.ack_age_s < 60, `acknowledged_at was moved: ${afterBackdate.ack_age_s}s ago`);
      const other = await sos(db, '30 minutes');
      assertRefused(await tryAsUser(db, u.supA, `UPDATE panic_alerts SET acknowledged_at = now() WHERE id = $1`, [other]));

      assertRefused(await tryAsUser(db, u.supA, `UPDATE panic_alerts SET acknowledged_by = NULL, acknowledged_at = NULL WHERE id = $1`, [id]));
      assertRefused(await tryAsUser(db, u.adminA, `UPDATE panic_alerts SET acknowledged_by = $2 WHERE id = $1`, [id, u.adminA]));
      assertRefused(await tryAsUser(db, u.supA, `UPDATE panic_alerts SET status = 'active' WHERE id = $1`, [id]));
      assert.deepEqual(await stored().then((s) => [s.acknowledged_by, s.status]), [u.supA, 'acknowledged']);
    }));

  test('resolving an unacknowledged alert acknowledges it in the resolver\'s name; notes changes are audited', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const id = await sos(db, '10 minutes');
      assertAllowed(
        await tryAsUser(db, u.supA, `UPDATE panic_alerts SET status = 'resolved', resolution_notes = 'False alarm, checked' WHERE id = $1`, [id])
      );
      const r = await asSuperuser<{ acknowledged_by: string; has_ack_time: boolean }>(
        db,
        `SELECT acknowledged_by, acknowledged_at IS NOT NULL AS has_ack_time FROM panic_alerts WHERE id = $1`,
        [id]
      );
      assert.deepEqual(r.rows[0], { acknowledged_by: u.supA, has_ack_time: true });

      assertAllowed(await tryAsUser(db, u.supA, `UPDATE panic_alerts SET resolution_notes = 'Rewritten later' WHERE id = $1`, [id]));
      const audit = await asSuperuser<{ action: string; acknowledged_at: string | null }>(
        db,
        `SELECT action, details ->> 'acknowledged_at' AS acknowledged_at FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action`,
        [id]
      );
      assert.deepEqual(
        audit.rows.map((row) => row.action).sort(),
        ['panic_alert.notes_changed', 'panic_alert.status_changed']
      );
      for (const row of audit.rows) assert.ok(row.acknowledged_at, 'acknowledged_at is recorded in the audit details');
    }));
});

describe('no existence oracles through SECURITY DEFINER triggers', () => {
  test('a foreign shift / checkpoint / site gets exactly the same refusal as a random id', () =>
    withCopy(async (db) => {
      const u = fx.users;
      const own = await startShiftAs(db, u.guardA, fx.siteA1);
      const scan = (shiftId: string, checkpointId: string) =>
        tryAsUser(
          db,
          u.guardA,
          `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method)
           VALUES (gen_random_uuid(), $1, $2, $3, now(), 'qr')`,
          [shiftId, checkpointId, u.guardA]
        );
      const same = (a: Awaited<ReturnType<typeof scan>>, b: Awaited<ReturnType<typeof scan>>, label: string) => {
        assertRefused(a, '42501', label);
        assertRefused(b, '42501', label);
        if (!a.ok && !b.ok) assert.equal(a.message, b.message, label);
      };
      same(await scan(fx.shiftB, fx.checkpoints.cpA1), await scan(randomUUID(), fx.checkpoints.cpA1), 'shift');
      same(await scan(own, fx.checkpoints.cpB1), await scan(own, randomUUID()), 'checkpoint');

      const checkpoint = (siteId: string) =>
        tryAsUser(
          db,
          u.adminA,
          `INSERT INTO checkpoints (site_id, name, qr_code_hash) VALUES ($1, 'x', 'EE-CP-' || upper(replace(gen_random_uuid()::text, '-', '')))`,
          [siteId]
        );
      same(await checkpoint(fx.siteB1), await checkpoint(randomUUID()), 'site');
    }));
});

describe('scan records are internally consistent', () => {
  test('the scan method must match the payload type (an NFC scan cannot carry a QR card code)', () =>
    withCopy(async (db) => {
      const g = fx.users.guardA;
      const shift = await startShiftAs(db, g, fx.siteA1);
      for (const [method, payloadType] of [
        ['nfc', 'legacy_qr'],
        ['nfc', 'secure_token'],
        ['qr', 'nfc_uid'],
        ['manual', 'secure_token']
      ]) {
        assertRefused(
          await tryAsUser(
            db,
            g,
            `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type, raw_payload)
             VALUES (gen_random_uuid(), $1, $2, $3, now(), $4::scan_method_enum, $5, 'PLAAS-CP:CP1')`,
            [shift, fx.checkpoints.cpA1, g, method, payloadType]
          ),
          '23514',
          `${method} + ${payloadType}`
        );
      }
    }));
});
