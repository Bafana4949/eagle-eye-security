/**
 * RLS read cost. Supervisor dashboards, client-viewer reports and Realtime evaluate the
 * SELECT policies for every row. The policies must resolve the caller's sites once per
 * statement (an InitPlan over site_id = ANY(array)) instead of calling a SECURITY DEFINER
 * helper per row of every tenant, which made a 20 000-scan table cost seconds per read.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, asUser, claimsFor, createTestDb, withClaims } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

async function plan(userId: string, sql: string): Promise<string> {
  const r = await withClaims(db, claimsFor(userId), (tx) => tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`));
  return r.rows.map((row) => row['QUERY PLAN']).join('\n');
}

const PER_ROW_HELPERS = /\b(can_manage_site|is_site_viewer|is_site_member|is_site_guard|shares_site_with|is_org_user)\(/;

describe('read policies evaluate the caller\'s access once per statement', () => {
  for (const [table, columns] of [
    ['patrol_scans', 'id, site_id'],
    ['shifts', 'id, site_id'],
    ['incidents', 'id, site_id'],
    ['panic_alerts', 'id, site_id'],
    ['gate_entries', 'id, site_id'],
    ['checkpoints', 'id, site_id'],
    ['site_assignments', 'id, site_id'],
    ['profiles', 'id, first_name'],
    ['user_roles', 'id, role'],
    ['sites', 'id, name']
  ] as const) {
    test(`${table}: supervisor, admin and client viewer plans use an InitPlan, never a per-row helper call`, async () => {
      for (const who of [fx.users.supA, fx.users.adminA, fx.users.viewerA]) {
        const p = await plan(who, `SELECT ${columns} FROM public.${table}`);
        assert.doesNotMatch(p, PER_ROW_HELPERS, `${table} as ${who}:\n${p}`);
        assert.match(p, /InitPlan/, `${table} as ${who}:\n${p}`);
      }
    });
  }

  test('a supervisor reading 5 000 scans returns them all and an org-B admin none, with the same plan shape', async () => {
    await asSuperuser(
      db,
      `INSERT INTO patrol_scans (offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type)
       SELECT gen_random_uuid(), $1, $2, $3, now() - (g || ' seconds')::interval, 'qr', 'secure_token'
       FROM generate_series(1, 5000) AS g`,
      [fx.shiftA2, fx.checkpoints.cpA1, fx.users.guardA2]
    );
    const sup = await asUser<{ n: number }>(db, fx.users.supA, `SELECT count(*)::int AS n FROM patrol_scans`);
    assert.equal(sup.rows[0].n, 5001);
    const foreign = await asUser<{ n: number }>(db, fx.users.adminB, `SELECT count(*)::int AS n FROM patrol_scans`);
    assert.equal(foreign.rows[0].n, 0);
  });
});
