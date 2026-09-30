/**
 * Every privilege-escalation / cross-tenant attack the audit executed against the
 * original policies, replayed against the shipped migrations. Each must now be refused.
 * Statements run as the attacking user with PostgREST semantics (SET ROLE authenticated
 * + JWT claims); most use no RETURNING, like PostgREST's default return=minimal.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
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

async function roleCount(userId: string, role: string): Promise<number> {
  const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND role = $2`, [
    userId,
    role
  ]);
  return r.rows[0].n;
}

describe('role escalation', () => {
  test('supervisor cannot grant themselves super_admin', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.supA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'super_admin')`, [u.supA]));
    assertRefused(await tryAsUser(db, u.supA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [u.supA]));
    assert.equal(await roleCount(u.supA, 'super_admin'), 0);
    assert.equal(await roleCount(u.supA, 'admin'), 0);
  });

  test('org-A supervisor cannot grant a role to an org-B user', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.supA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [u.guardB]));
    assert.equal(await roleCount(u.guardB, 'admin'), 0);
  });

  test('org-A admin cannot grant, change or revoke roles of an org-B user', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [u.guardB]));
    assertNoRows(await tryAsUser(db, u.adminA, `DELETE FROM user_roles WHERE user_id = $1`, [u.guardB]));
    assertNoRows(await tryAsUser(db, u.adminA, `UPDATE user_roles SET role = 'client_viewer' WHERE user_id = $1`, [u.guardB]));
    assert.equal(await roleCount(u.guardB, 'guard'), 1);
  });

  test('admin cannot change their own roles', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'super_admin')`, [u.adminA]));
    assertRefused(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [u.adminA]));
    assertNoRows(await tryAsUser(db, u.adminA, `UPDATE user_roles SET role = 'super_admin' WHERE user_id = $1`, [u.adminA]));
    assertNoRows(await tryAsUser(db, u.adminA, `DELETE FROM user_roles WHERE user_id = $1`, [u.adminA]));
    assert.equal(await roleCount(u.adminA, 'admin'), 1);
    assert.equal(await roleCount(u.adminA, 'super_admin'), 0);
  });

  test('an admin who is not super_admin cannot grant or revoke super_admin', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.adminA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'super_admin')`, [u.guardA]));
    assertNoRows(await tryAsUser(db, u.adminA, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'super_admin'`, [u.superA]));
    assert.equal(await roleCount(u.superA, 'super_admin'), 1);
  });

  test('guard cannot grant roles or site assignments', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.guardA, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'supervisor')`, [u.guardA]));
    assertRefused(await tryAsUser(db, u.guardA, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA2, u.guardA]));
  });

  test('supervisor cannot manage sites, checkpoints or site assignments (admin only)', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.supA, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA2, u.supA]));
    assertNoRows(await tryAsUser(db, u.supA, `UPDATE sites SET name = 'hijacked' WHERE id = $1`, [fx.siteA1]));
    assertNoRows(await tryAsUser(db, u.supA, `DELETE FROM sites WHERE id = $1`, [fx.siteA1]));
    assertRefused(
      await tryAsUser(
        db,
        u.supA,
        `INSERT INTO checkpoints (site_id, name, qr_code_hash) VALUES ($1, 'rogue', 'EE-CP-00000000000000000000000000000000')`,
        [fx.siteA1]
      )
    );
    assertNoRows(await tryAsUser(db, u.supA, `UPDATE checkpoints SET nfc_uid = '04:11:22:33' WHERE id = $1`, [fx.checkpoints.cpA1]));
  });
});

describe('profile tampering and disabled accounts', () => {
  test('guard cannot change their own organisation_id (tenant hop)', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.guardA, `UPDATE profiles SET organisation_id = $1 WHERE id = $2`, [fx.orgB, u.guardA]));
    const r = await asSuperuser<{ organisation_id: string }>(db, `SELECT organisation_id FROM profiles WHERE id = $1`, [u.guardA]);
    assert.equal(r.rows[0].organisation_id, fx.orgA);
  });

  // The original audit's working exploit: an UPDATE with no WHERE clause references no
  // profiles column, so Postgres skips the SELECT-policy check on the new row
  // (a filtered `?id=eq.<me>` PATCH was already refused under the old policies).
  test('unfiltered UPDATE (no WHERE) cannot move a guard or an admin into another organisation', async () => {
    const u = fx.users;
    for (const attacker of [u.guardA, u.adminA]) {
      await tryAsUser(db, attacker, `UPDATE profiles SET organisation_id = $1`, [fx.orgB]);
      const r = await asSuperuser<{ organisation_id: string }>(db, `SELECT organisation_id FROM profiles WHERE id = $1`, [attacker]);
      assert.equal(r.rows[0].organisation_id, fx.orgA);
    }
    const moved = await asSuperuser<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM profiles WHERE organisation_id = $1 AND id = ANY($2::uuid[])`,
      [fx.orgB, [u.guardA, u.adminA, u.supA, u.viewerA]]
    );
    assert.equal(moved.rows[0].n, 0);
  });

  test('unfiltered UPDATE (no WHERE) cannot re-activate a disabled account', async () => {
    const u = fx.users;
    await tryAsUser(db, u.disabledGuardA, `UPDATE profiles SET is_active = true`);
    const r = await asSuperuser<{ is_active: boolean }>(db, `SELECT is_active FROM profiles WHERE id = $1`, [u.disabledGuardA]);
    assert.equal(r.rows[0].is_active, false);
  });

  test('no org-unscoped evidence-media storage policy survives the upgrade from the live phase-2 state', async () => {
    const r = await asSuperuser<{ policyname: string }>(
      db,
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND (coalesce(qual, '') ILIKE '%evidence-media%' OR coalesce(with_check, '') ILIKE '%evidence-media%')
        ORDER BY policyname`
    );
    assert.deepEqual(
      r.rows.map((x) => x.policyname),
      ['ee_evidence_insert', 'ee_evidence_select']
    );
  });

  test('guard cannot change their own is_active flag or employee number', async () => {
    const u = fx.users;
    assertRefused(await tryAsUser(db, u.guardA, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.guardA]));
    assertRefused(await tryAsUser(db, u.guardA, `UPDATE profiles SET employee_number = 'X1' WHERE id = $1`, [u.guardA]));
  });

  test('disabled guard cannot re-activate their own profile', async () => {
    const u = fx.users;
    assertNoRows(await tryAsUser(db, u.disabledGuardA, `UPDATE profiles SET is_active = true WHERE id = $1`, [u.disabledGuardA]));
    const r = await asSuperuser<{ is_active: boolean }>(db, `SELECT is_active FROM profiles WHERE id = $1`, [u.disabledGuardA]);
    assert.equal(r.rows[0].is_active, false);
  });

  test('disabled (is_active=false) user can read nothing except their own disabled profile row', async () => {
    const u = fx.users;
    for (const table of [
      'organisations',
      'sites',
      'user_roles',
      'site_assignments',
      'checkpoints',
      'shifts',
      'patrol_rounds',
      'patrol_scans',
      'incidents',
      'incident_media',
      'panic_alerts',
      'gate_entries',
      'audit_logs',
      'sync_events'
    ]) {
      // (every table has an id; SELECT * on checkpoints is refused for everyone, see the secrets tests)
      const r = await tryAsUser(db, u.disabledGuardA, `SELECT id FROM ${table}`);
      assertNoRows(r, `disabled user reading ${table}`);
    }
    const profiles = await tryAsUser<{ id: string; is_active: boolean }>(db, u.disabledGuardA, `SELECT id, is_active FROM profiles`);
    assertAllowed(profiles);
    assert.deepEqual(profiles.rows, [{ id: u.disabledGuardA, is_active: false }]);
    const storage = await tryAsUser(db, u.disabledGuardA, `SELECT * FROM storage.objects`);
    assertNoRows(storage, 'disabled user reading storage.objects');
  });

  test('disabled guard cannot write anything (shift, incident, SOS, gate entry, profile)', async () => {
    const u = fx.users;
    const g = u.disabledGuardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO shifts (site_id, guard_id, shift_type, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, 'day', now(), now() + interval '12 hours', 'active')`,
        [fx.siteA1, g]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at) VALUES (gen_random_uuid(), $1, $2, 'fire', now())`,
        [fx.siteA1, g]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at) VALUES (gen_random_uuid(), $1, $2, now())`,
        [fx.siteA1, g]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time)
         VALUES (gen_random_uuid(), $1, $2, 'in', 'ND 1', now())`,
        [fx.siteA1, g]
      )
    );
    assertNoRows(await tryAsUser(db, g, `UPDATE profiles SET first_name = 'Still here' WHERE id = $1`, [g]));
  });

  test('org-B admin cannot see or change anything of org A', async () => {
    const u = fx.users;
    assertNoRows(await tryAsUser(db, u.adminB, `SELECT * FROM sites WHERE organisation_id = $1`, [fx.orgA]));
    assertNoRows(await tryAsUser(db, u.adminB, `SELECT * FROM profiles WHERE organisation_id = $1`, [fx.orgA]));
    assertNoRows(await tryAsUser(db, u.adminB, `SELECT * FROM audit_logs WHERE organisation_id = $1`, [fx.orgA]));
    assertNoRows(await tryAsUser(db, u.adminB, `UPDATE profiles SET is_active = false WHERE id = $1`, [u.guardA]));
    assertNoRows(await tryAsUser(db, u.adminB, `UPDATE organisations SET name = 'pwned' WHERE id = $1`, [fx.orgA]));
    assertRefused(
      await tryAsUser(db, u.adminB, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA1, u.guardB])
    );
  });
});

describe('guard confidentiality', () => {
  test("guard cannot read a colleague's shifts, scans, incidents, SOS, profile or roles", async () => {
    const u = fx.users;
    const g = u.guardA;
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM shifts WHERE id = $1`, [fx.shiftA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM patrol_scans WHERE id = $1`, [fx.scanA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM incidents WHERE id = $1`, [fx.incidentA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM panic_alerts`));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM profiles WHERE id = $1`, [u.guardA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM user_roles WHERE user_id = $1`, [u.guardA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM site_assignments WHERE user_id = $1`, [u.guardA2]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM audit_logs`));
  });

  test('guard cannot see sites, checkpoints or gate log of a site they are not assigned to', async () => {
    const g = fx.users.guardA;
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM sites WHERE id IN ($1, $2)`, [fx.siteA2, fx.siteB1]));
    assertNoRows(await tryAsUser(db, g, `SELECT id, name FROM checkpoints WHERE site_id IN ($1, $2)`, [fx.siteA2, fx.siteB1]));
    assertNoRows(await tryAsUser(db, g, `SELECT * FROM gate_entries WHERE site_id IN ($1, $2)`, [fx.siteA2, fx.siteB1]));
  });

  test('supervisor cannot read or acknowledge the SOS alert of a site they are not assigned to', async () => {
    const s = fx.users.supA;
    assertNoRows(await tryAsUser(db, s, `SELECT * FROM panic_alerts WHERE id = $1`, [fx.panicA3]));
    assertNoRows(
      await tryAsUser(
        db,
        s,
        `UPDATE panic_alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`,
        [fx.panicA3, s]
      )
    );
    const r = await asSuperuser<{ status: string; acknowledged_by: string | null }>(
      db,
      `SELECT status, acknowledged_by FROM panic_alerts WHERE id = $1`,
      [fx.panicA3]
    );
    assert.deepEqual(r.rows[0], { status: 'active', acknowledged_by: null });
    assertNoRows(await tryAsUser(db, s, `SELECT * FROM shifts WHERE id = $1`, [fx.shiftA3]));
  });
});

describe('client_viewer is read-only', () => {
  test('client_viewer cannot start a shift', async () => {
    const v = fx.users.viewerA;
    assertRefused(
      await tryAsUser(
        db,
        v,
        `INSERT INTO shifts (site_id, guard_id, shift_type, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, 'day', now(), now() + interval '12 hours', 'active')`,
        [fx.siteA1, v]
      )
    );
  });

  test('client_viewer cannot insert a gate entry', async () => {
    const v = fx.users.viewerA;
    assertRefused(
      await tryAsUser(
        db,
        v,
        `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time)
         VALUES (gen_random_uuid(), $1, $2, 'in', 'FAKE 1 GP', now())`,
        [fx.siteA1, v]
      )
    );
  });

  test('client_viewer cannot insert a patrol scan', async () => {
    const v = fx.users.viewerA;
    assertRefused(
      await tryAsUser(
        db,
        v,
        `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [fx.shiftA2, fx.checkpoints.cpA1, v]
      )
    );
  });

  test('client_viewer cannot insert an incident or an SOS alert', async () => {
    const v = fx.users.viewerA;
    assertRefused(
      await tryAsUser(
        db,
        v,
        `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at) VALUES (gen_random_uuid(), $1, $2, 'fire', now())`,
        [fx.siteA1, v]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        v,
        `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at) VALUES (gen_random_uuid(), $1, $2, now())`,
        [fx.siteA1, v]
      )
    );
  });

  test('client_viewer cannot change or delete incidents, gate entries or shifts', async () => {
    const v = fx.users.viewerA;
    assertNoRows(await tryAsUser(db, v, `UPDATE incidents SET status = 'resolved' WHERE id = $1`, [fx.incidentA2]));
    assertRefused(await tryAsUser(db, v, `DELETE FROM gate_entries WHERE id = $1`, [fx.gateA2]));
    assertNoRows(await tryAsUser(db, v, `UPDATE shifts SET notes = 'x' WHERE id = $1`, [fx.shiftA2]));
  });
});

describe('append-only evidence tables', () => {
  test('guard cannot update or delete gate entries (own site, own or colleague)', async () => {
    const g = fx.users.guardA2;
    assertRefused(await tryAsUser(db, g, `UPDATE gate_entries SET license_plate = 'CHANGED' WHERE id = $1`, [fx.gateA2]));
    assertRefused(await tryAsUser(db, g, `DELETE FROM gate_entries WHERE id = $1`, [fx.gateA2]));
    assertRefused(await tryAsUser(db, fx.users.guardA, `DELETE FROM gate_entries`));
    const r = await asSuperuser<{ license_plate: string }>(db, `SELECT license_plate FROM gate_entries WHERE id = $1`, [fx.gateA2]);
    assert.equal(r.rows[0].license_plate, 'CA 123-456');
  });

  test('guard cannot update or delete patrol scans (not even their own)', async () => {
    const g = fx.users.guardA2;
    assertRefused(await tryAsUser(db, g, `UPDATE patrol_scans SET is_valid_proximity = true WHERE id = $1`, [fx.scanA2]));
    assertRefused(await tryAsUser(db, g, `DELETE FROM patrol_scans WHERE id = $1`, [fx.scanA2]));
    assertRefused(await tryAsUser(db, fx.users.adminA, `DELETE FROM patrol_scans WHERE id = $1`, [fx.scanA2]));
    const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM patrol_scans WHERE id = $1`, [fx.scanA2]);
    assert.equal(r.rows[0].n, 1);
  });

  test('nobody signed in can delete shifts, incidents or SOS alerts', async () => {
    const a = fx.users.adminA;
    assertRefused(await tryAsUser(db, a, `DELETE FROM shifts WHERE id = $1`, [fx.shiftA2]));
    assertRefused(await tryAsUser(db, a, `DELETE FROM incidents WHERE id = $1`, [fx.incidentA2]));
    assertRefused(await tryAsUser(db, a, `DELETE FROM panic_alerts WHERE id = $1`, [fx.panicA3]));
    assertRefused(await tryAsUser(db, a, `TRUNCATE gate_entries`));
  });

  test('a site with shift / incident / SOS / gate history cannot be deleted (evidence is kept)', async () => {
    const r = await tryAsUser(db, fx.users.adminA, `DELETE FROM sites WHERE id = $1`, [fx.siteA1]);
    assertRefused(r, '23001'); // restrict_violation (ON DELETE RESTRICT)
  });
});

describe('cross-tenant and cross-site injection', () => {
  test('org-A guard cannot inject an incident into an org-B site', async () => {
    const g = fx.users.guardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at) VALUES (gen_random_uuid(), $1, $2, 'fire', now())`,
        [fx.siteB1, g]
      )
    );
  });

  test('org-A guard cannot inject an SOS alert into an org-B site', async () => {
    const g = fx.users.guardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at) VALUES (gen_random_uuid(), $1, $2, now())`,
        [fx.siteB1, g]
      )
    );
  });

  test("org-A guard cannot inject a scan into an org-B guard's shift", async () => {
    const g = fx.users.guardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [fx.shiftB, fx.checkpoints.cpB1, g]
      )
    );
  });

  test("guard cannot attach an incident / SOS / gate entry to someone else's shift", async () => {
    const g = fx.users.guardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO incidents (offline_uuid, site_id, shift_id, guard_id, incident_type, reported_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'fire', now())`,
        [fx.siteA1, fx.shiftA2, g]
      )
    );
    // An SOS is never refused because of its shift link: it is stored, but NOT attached to
    // the foreign shift.
    const sosId = randomUUID();
    assertAllowed(
      await tryAsUser(
        db,
        g,
        `INSERT INTO panic_alerts (id, offline_uuid, site_id, shift_id, guard_id, triggered_at) VALUES ($1, $1, $2, $3, $4, now())`,
        [sosId, fx.siteA1, fx.shiftB, g]
      )
    );
    const sos = await asSuperuser<{ shift_id: string | null }>(db, `SELECT shift_id FROM panic_alerts WHERE id = $1`, [sosId]);
    assert.deepEqual(sos.rows, [{ shift_id: null }]);
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO gate_entries (offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time)
         VALUES (gen_random_uuid(), $1, $2, $3, 'in', 'ND 2', now())`,
        [fx.siteA1, fx.shiftA2, g]
      )
    );
  });

  test('org-A guard cannot write a gate entry for an org-B or unassigned site', async () => {
    const g = fx.users.guardA;
    for (const site of [fx.siteB1, fx.siteA2]) {
      assertRefused(
        await tryAsUser(
          db,
          g,
          `INSERT INTO gate_entries (offline_uuid, site_id, guard_id, direction, license_plate, entry_time)
           VALUES (gen_random_uuid(), $1, $2, 'in', 'ND 3', now())`,
          [site, g]
        )
      );
    }
  });

  test('guard cannot start a shift on a site they are not assigned to', async () => {
    const g = fx.users.guardA;
    for (const site of [fx.siteA2, fx.siteB1]) {
      assertRefused(
        await tryAsUser(
          db,
          g,
          `INSERT INTO shifts (site_id, guard_id, shift_type, scheduled_start, scheduled_end, status)
           VALUES ($1, $2, 'day', now(), now() + interval '12 hours', 'active')`,
          [site, g]
        )
      );
    }
  });

  test('guard cannot record anything in the name of a colleague (forged guard_id)', async () => {
    const u = fx.users;
    assertRefused(
      await tryAsUser(
        db,
        u.guardA,
        `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at) VALUES (gen_random_uuid(), $1, $2, 'fire', now())`,
        [fx.siteA1, u.guardA2]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        u.guardA,
        `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [fx.shiftA2, fx.checkpoints.cpA1, u.guardA2]
      )
    );
  });

  test('guard cannot forge an acknowledgement or resolution when reporting', async () => {
    const u = fx.users;
    assertRefused(
      await tryAsUser(
        db,
        u.guardA,
        `INSERT INTO incidents (offline_uuid, site_id, guard_id, incident_type, reported_at, status, acknowledged_by, acknowledged_at)
         VALUES (gen_random_uuid(), $1, $2, 'fire', now(), 'resolved', $3, now())`,
        [fx.siteA1, u.guardA, u.supA]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        u.guardA,
        `INSERT INTO panic_alerts (offline_uuid, site_id, guard_id, triggered_at, status, acknowledged_by)
         VALUES (gen_random_uuid(), $1, $2, now(), 'acknowledged', $3)`,
        [fx.siteA1, u.guardA, u.supA]
      )
    );
  });

  test('guard cannot acknowledge SOS alerts or incidents (supervisor action)', async () => {
    const u = fx.users;
    assertNoRows(
      await tryAsUser(db, u.guardA, `UPDATE incidents SET status = 'resolved', acknowledged_by = $2 WHERE id = $1`, [
        fx.incidentA2,
        u.guardA
      ])
    );
  });
});

describe('shift evidence is frozen after clock-in', () => {
  test('guard cannot edit start GPS, start selfie or actual_start of their own shift after insert', async () => {
    const g = fx.users.guardA;
    const shiftId = await startShiftAs(db, g, fx.siteA1, { latitude: -25.68, longitude: 27.81, accuracy: 8 });
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET start_latitude = -26.0 WHERE id = $1`, [shiftId]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET start_longitude = 28.0 WHERE id = $1`, [shiftId]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET start_accuracy_meters = 1 WHERE id = $1`, [shiftId]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET actual_start = now() - interval '3 hours' WHERE id = $1`, [shiftId]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET start_selfie_url = 'x/y.jpg' WHERE id = $1`, [shiftId]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET site_id = $2 WHERE id = $1`, [shiftId, fx.siteA2]));
    assertRefused(await tryAsUser(db, g, `UPDATE shifts SET guard_id = $2 WHERE id = $1`, [shiftId, fx.users.guardA2]));
    const r = await asSuperuser<{ start_latitude: number; start_accuracy_meters: number }>(
      db,
      `SELECT start_latitude, start_accuracy_meters FROM shifts WHERE id = $1`,
      [shiftId]
    );
    assert.deepEqual(r.rows[0], { start_latitude: -25.68, start_accuracy_meters: 8 });
  });

  test('guard cannot insert an already-completed shift or a clock-in in the future', async () => {
    const g = fx.users.guardA;
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, actual_end, status)
         VALUES ($1, $2, $3, 'day', now() - interval '12 hours', now(), now() - interval '12 hours', now(), 'active')`,
        [randomUUID(), fx.siteA1, g]
      ),
      '23514'
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, $3, 'day', now(), now() + interval '12 hours', 'completed')`,
        [randomUUID(), fx.siteA1, g]
      )
    );
    assertRefused(
      await tryAsUser(
        db,
        g,
        `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
         VALUES ($1, $2, $3, 'day', now(), now() + interval '12 hours', now() + interval '2 hours', 'active')`,
        [randomUUID(), fx.siteA1, g]
      ),
      '23514'
    );
  });

  test('guard cannot change a colleague shift', async () => {
    assertNoRows(
      await tryAsUser(db, fx.users.guardA, `UPDATE shifts SET actual_end = now(), status = 'completed' WHERE id = $1`, [fx.shiftA2])
    );
  });
});
