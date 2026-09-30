/**
 * Audit trail: written only by the SECURITY DEFINER trigger, readable only by org admins
 * of the same organisation, immutable for everyone.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, createTestDb, describeError, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertNoRows, assertRefused } from './assertions';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

describe('audit trail', () => {
  test('audit_logs rows are written on role grant / revoke and site assignment changes, attributed to the admin', async () => {
    const a = fx.users.adminA;
    const target = fx.users.guardA2;
    assertAllowed(await tryAsUser(db, a, `INSERT INTO user_roles (user_id, role) VALUES ($1, 'client_viewer')`, [target]));
    assertAllowed(await tryAsUser(db, a, `DELETE FROM user_roles WHERE user_id = $1 AND role = 'client_viewer'`, [target]));
    assertAllowed(await tryAsUser(db, a, `INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [fx.siteA2, target]));
    const r = await asUser<{ action: string; actor_id: string; organisation_id: string; role: string | null }>(
      db,
      a,
      `SELECT action, actor_id, organisation_id, details ->> 'role' AS role
       FROM audit_logs
       WHERE actor_id = $1 AND (details ->> 'user_id') = $2::text
       ORDER BY created_at, action`,
      [a, target]
    );
    assert.deepEqual(
      r.rows.map((row) => [row.action, row.role]),
      [
        ['role.granted', 'client_viewer'],
        ['role.revoked', 'client_viewer'],
        ['site_assignment.added', null]
      ]
    );
    for (const row of r.rows) assert.equal(row.organisation_id, fx.orgA);
  });

  test('audit_logs are not writable, updatable or deletable by any signed-in user', async () => {
    for (const user of [fx.users.guardA, fx.users.adminA, fx.users.superA]) {
      assertRefused(
        await tryAsUser(db, user, `INSERT INTO audit_logs (organisation_id, action, resource_type) VALUES ($1, 'forged', 'x')`, [fx.orgA]),
        '42501',
        `insert by ${user}`
      );
      assertRefused(await tryAsUser(db, user, `UPDATE audit_logs SET action = 'tampered'`), '42501', `update by ${user}`);
      assertRefused(await tryAsUser(db, user, `DELETE FROM audit_logs`), '42501', `delete by ${user}`);
      assertRefused(await tryAsUser(db, user, `TRUNCATE audit_logs`), '42501', `truncate by ${user}`);
    }
  });

  test('audit_logs stay immutable even for the database owner (UPDATE, DELETE and TRUNCATE are blocked)', async () => {
    for (const sql of [`UPDATE audit_logs SET action = 'tampered'`, `DELETE FROM audit_logs`, `TRUNCATE audit_logs`]) {
      await assert.rejects(asSuperuser(db, sql), (error: unknown) => {
        assert.match(describeError(error).message, /immutable/i, sql);
        return true;
      });
    }
  });

  test('only org admins read the audit trail, and only their own organisation', async () => {
    const own = await asUser<{ n: number; foreign: number }>(
      db,
      fx.users.adminA,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE organisation_id <> $1)::int AS foreign FROM audit_logs`,
      [fx.orgA]
    );
    assert.ok(own.rows[0].n > 0);
    assert.equal(own.rows[0].foreign, 0);
    assertNoRows(await tryAsUser(db, fx.users.supA, `SELECT * FROM audit_logs`));
    assertNoRows(await tryAsUser(db, fx.users.guardA, `SELECT * FROM audit_logs`));
    assertNoRows(await tryAsUser(db, fx.users.viewerA, `SELECT * FROM audit_logs`));
    assertNoRows(await tryAsUser(db, fx.users.adminB, `SELECT * FROM audit_logs WHERE organisation_id = $1`, [fx.orgA]));
  });

  test('site changes and incident status changes are audited', async () => {
    const a = fx.users.adminA;
    assertAllowed(await tryAsUser(db, a, `UPDATE sites SET round_interval_minutes = 45 WHERE id = $1`, [fx.siteA1]));
    assertAllowed(await tryAsUser(db, fx.users.supA, `UPDATE incidents SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1`, [
      fx.incidentA2,
      fx.users.supA
    ]));
    const r = await asUser<{ action: string; resource_id: string; details: Record<string, unknown> }>(
      db,
      a,
      `SELECT action, resource_id, details FROM audit_logs WHERE resource_id IN ($1, $2) AND action IN ('site.updated', 'incident.status_changed')
       ORDER BY action`,
      [fx.siteA1, fx.incidentA2]
    );
    assert.deepEqual(
      r.rows.map((row) => row.action),
      ['incident.status_changed', 'site.updated']
    );
    const incident = r.rows[0].details;
    assert.equal(incident.from, 'reported');
    assert.equal(incident.to, 'acknowledged');
    const site = r.rows[1].details as { changes: Record<string, { old: unknown; new: unknown }> };
    assert.deepEqual(site.changes.round_interval_minutes, { old: 60, new: 45 });
  });
});
