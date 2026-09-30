/**
 * Admin console data layer (./adminData.ts) and staff provisioning (POST /api/admin/users →
 * src/app/api/admin/users/provision.ts) against the REAL migrations, RLS policies and triggers,
 * using the PGlite harness and supabase-js stand-in from tests/db.
 *
 * What this proves: every admin write only reports success when the database returned the row
 * it stored; refusals (RLS, triggers, unique indexes) come back as errors, never as "saved".
 * What it does not prove: PostgREST / GoTrue / Storage over HTTP, or any real phone hardware.
 * The Auth admin API is replaced by a stand-in that writes auth.users like GoTrue would.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asSuperuser, createTestDb } from '../../../tests/db/harness';
import { seedTwoTenantFixture, type Fixture } from '../../../tests/db/fixtures';
import { PgSupabase } from '../../../tests/db/pgSupabase';
import { nfcSerialFingerprint } from '@/lib/data/checkpoints';
import { provisionStaffAccount, type ServiceClient } from '@/app/api/admin/users/provision';
import {
  createCheckpoint,
  createSite,
  deleteCheckpoint,
  enrolNfcTag,
  findCheckpointsByTag,
  loadAuditPage,
  loadCheckpointSecrets,
  loadOrgSites,
  loadSiteCheckpoints,
  loadStaff,
  moveNfcTag,
  redactAuditDetails,
  removeNfcTag,
  rotateCheckpointToken,
  setCheckpointActive,
  setStaffActive,
  setStaffRole,
  setStaffSite,
  updateCheckpoint,
  updateSite,
  type SiteSettingsInput
} from './adminData';
import { siteToFormValues, validateSiteForm } from './validation';

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
const signedOut = () => new PgSupabase(db, null);

/**
 * PgSupabase has no .range(); loadAuditPage asks for the first page only in these tests, where
 * range(0, n) is exactly limit(n + 1).
 */
function withFirstPageRange(client: PgSupabase): Pick<SupabaseClient, 'from'> {
  return {
    from: (table: string) => ({
      select: (columns: string) => {
        const request = client.from(table).select(columns) as unknown as {
          limit: (n: number) => unknown;
          range?: (from: number, to: number) => unknown;
        };
        request.range = (from: number, to: number) => {
          assert.equal(from, 0, 'test stand-in only serves the first page');
          return request.limit(to - from + 1);
        };
        return request;
      }
    })
  } as unknown as Pick<SupabaseClient, 'from'>;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

describe('sites', () => {
  test('an admin sees exactly the sites of their own organisation', async () => {
    const sites = await loadOrgSites(as(fx.users.adminA).client);
    assert.ok(sites.ok);
    assert.deepEqual(new Set(sites.value.map((s) => s.id)), new Set([fx.siteA1, fx.siteA2]));
    const other = await loadOrgSites(as(fx.users.adminB).client);
    assert.ok(other.ok);
    assert.deepEqual(other.value.map((s) => s.id), [fx.siteB1]);
  });

  test('saving site settings returns the stored row, and a reload shows the same values', async () => {
    const admin = as(fx.users.adminA).client;
    const before = (await loadOrgSites(admin)) as { ok: true; value: Array<{ id: string }> };
    const site = before.value.find((s) => s.id === fx.siteA1) as Parameters<typeof siteToFormValues>[0];
    const form = {
      ...siteToFormValues(site),
      name: 'Hoofplaas',
      address: 'Plaaspad 1',
      whatsapp: '082 123 4567',
      emergencyPhone: '082 555 0000',
      policePhone: '10111',
      dayStart: '05:30',
      dayEnd: '17:30',
      nightStart: '17:30',
      nightEnd: '05:30',
      roundInterval: '45',
      defaultRadius: '40',
      allowLegacyQr: true
    };
    const validated = validateSiteForm(form);
    assert.ok(validated.ok);
    const saved = await updateSite(admin, fx.siteA1, validated.value);
    assert.ok(saved.ok, JSON.stringify(!saved.ok && saved.error));
    assert.equal(saved.value.whatsappDispatchNumber, '+27821234567', 'stored as E.164');
    assert.equal(saved.value.dayShiftStart, '05:30');
    assert.equal(saved.value.roundIntervalMinutes, 45);
    assert.equal(saved.value.allowLegacyQr, true);

    const reloaded = await loadOrgSites(admin);
    assert.ok(reloaded.ok);
    const again = reloaded.value.find((s) => s.id === fx.siteA1);
    assert.deepEqual(again, saved.value, 'what "Saved" showed is what the database holds');
  });

  test('a supervisor cannot change site settings: the RLS-filtered update is reported as a failure', async () => {
    const site = ((await loadOrgSites(as(fx.users.adminA).client)) as { ok: true; value: Parameters<typeof siteToFormValues>[0][] }).value.find(
      (s) => s.id === fx.siteA1
    );
    assert.ok(site);
    const input = (validateSiteForm({ ...siteToFormValues(site), name: 'Hijacked' }) as { ok: true; value: SiteSettingsInput }).value;
    const result = await updateSite(as(fx.users.supA).client, fx.siteA1, input);
    assert.equal(result.ok, false);
    const stored = await asSuperuser<{ name: string }>(db, `SELECT name FROM sites WHERE id = $1`, [fx.siteA1]);
    assert.equal(stored.rows[0].name, 'Hoofplaas');
  });

  test('a new site has no phone numbers until an admin enters them; another organisation is refused', async () => {
    const created = await createSite(as(fx.users.adminA).client, fx.orgA, { name: 'Noordplaas', code: 'NP-01' });
    assert.ok(created.ok, JSON.stringify(!created.ok && created.error));
    assert.equal(created.value.policePhone, '');
    assert.equal(created.value.emergencyPhone, undefined);
    assert.equal(created.value.whatsappDispatchNumber, undefined);
    assert.equal(created.value.organisationId, fx.orgA);

    const duplicate = await createSite(as(fx.users.adminA).client, fx.orgA, { name: 'Again', code: 'NP-01' });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.kind, 'conflict');

    const foreign = await createSite(as(fx.users.adminA).client, fx.orgB, { name: 'Not mine', code: 'X-1' });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.error.kind, 'not_allowed');
  });
});

// ---------------------------------------------------------------------------
// Checkpoints, QR tokens and NFC tags
// ---------------------------------------------------------------------------

describe('checkpoints', () => {
  let newCheckpointId = '';

  test('create: a fresh 128-bit token is stored (strong) and only its fingerprint is readable', async () => {
    const admin = as(fx.users.adminA).client;
    const created = await createCheckpoint(admin, fx.siteA1, {
      name: 'Pomphuis',
      description: 'Behind the dam',
      permittedRadiusMeters: 30,
      orderIndex: 4,
      legacyCode: null,
      latitude: -25.6842,
      longitude: 27.8146
    });
    assert.ok(created.ok, JSON.stringify(!created.ok && created.error));
    newCheckpointId = created.value.id;
    assert.equal(created.value.qrTokenStrong, true);
    assert.match(created.value.qrTokenSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(created.value.nfcUidSha256, undefined);

    const secrets = await loadCheckpointSecrets(admin, fx.siteA1);
    assert.ok(secrets.ok);
    const secret = secrets.value.find((s) => s.checkpointId === newCheckpointId);
    assert.match(secret?.qrToken ?? '', /^EE-CP-[0-9A-F]{32}$/);

    const guardSecrets = await loadCheckpointSecrets(as(fx.users.guardA).client, fx.siteA1);
    assert.equal(guardSecrets.ok, false, 'guards never read raw tokens');
    if (!guardSecrets.ok) assert.equal(guardSecrets.error.kind, 'not_allowed');
  });

  test('a legacy card code already used on the site is refused with a specific problem', async () => {
    const result = await updateCheckpoint(as(fx.users.adminA).client, newCheckpointId, {
      name: 'Pomphuis',
      description: null,
      permittedRadiusMeters: 30,
      orderIndex: 4,
      legacyCode: 'CP1',
      latitude: null,
      longitude: null
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.problem, 'duplicate_legacy_code');
  });

  test('NFC: enrolment stores the normalised serial with a server time; a duplicate names the holder; move-here works', async () => {
    const admin = as(fx.users.adminA).client;
    const enrolled = await enrolNfcTag(admin, fx.checkpoints.cpA1NoCoords, '04A23B1C5D8001');
    assert.ok(enrolled.ok, JSON.stringify(!enrolled.ok && enrolled.error));
    assert.equal(enrolled.value.serial, '04:a2:3b:1c:5d:80:01');
    assert.ok(Date.parse(enrolled.value.enrolledAt) > 0, 'enrolment time read back from the database');
    assert.equal(enrolled.value.checkpoint.nfcEnrolledBy, fx.users.adminA);
    assert.equal(enrolled.value.checkpoint.nfcUidSha256, await nfcSerialFingerprint('04:a2:3b:1c:5d:80:01'));

    const duplicate = await enrolNfcTag(admin, newCheckpointId, '04:a2:3b:1c:5d:80:01');
    assert.equal(duplicate.ok, false);
    if (duplicate.ok) return;
    assert.equal(duplicate.error.problem, 'duplicate_tag');
    assert.deepEqual(
      duplicate.holders?.map((h) => h.id),
      [fx.checkpoints.cpA1NoCoords],
      'the admin is told which checkpoint holds the tag'
    );

    const moved = await moveNfcTag(admin, [fx.checkpoints.cpA1NoCoords], newCheckpointId, '04:a2:3b:1c:5d:80:01');
    assert.ok(moved.ok, JSON.stringify(!moved.ok && moved.error));
    assert.equal(moved.released?.id, fx.checkpoints.cpA1NoCoords);
    assert.equal(moved.released?.nfcUidSha256, undefined);
    const holders = await findCheckpointsByTag(admin, '04-A2-3B-1C-5D-80-01');
    assert.ok(holders.ok);
    assert.deepEqual(holders.value.map((h) => h.id), [newCheckpointId]);
  });

  test('NFC: an invalid serial is refused before anything is written; tags of another organisation stay invisible', async () => {
    const admin = as(fx.users.adminA).client;
    const invalid = await enrolNfcTag(admin, fx.checkpoints.cpA1NoCoords, '04:a2');
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.problem, 'invalid_tag_serial');
    const empty = await enrolNfcTag(admin, fx.checkpoints.cpA1NoCoords, '');
    assert.equal(empty.ok, false);

    const otherOrg = await findCheckpointsByTag(as(fx.users.adminB).client, '04:a2:3b:1c:5d:80:01');
    assert.ok(otherOrg.ok);
    assert.deepEqual(otherOrg.value, []);
  });

  test('NFC: remove tag revokes it; the audit entry never shows the raw serial once redacted', async () => {
    const admin = as(fx.users.adminA).client;
    const removed = await removeNfcTag(admin, newCheckpointId);
    assert.ok(removed.ok);
    assert.equal(removed.value.nfcUidSha256, undefined);
    const holders = await findCheckpointsByTag(admin, '04:a2:3b:1c:5d:80:01');
    assert.ok(holders.ok);
    assert.deepEqual(holders.value, []);

    const audit = await asSuperuser<{ details: Record<string, unknown> }>(
      db,
      `SELECT details FROM audit_logs WHERE action = 'checkpoint.nfc_enrolled' AND resource_id = $1`,
      [fx.checkpoints.cpA1NoCoords]
    );
    assert.ok(audit.rows.length >= 1);
    assert.ok(JSON.stringify(audit.rows[0].details).includes('04:a2:3b:1c:5d:80:01'), 'the trigger records the serial');
    assert.ok(!JSON.stringify(redactAuditDetails(audit.rows[0].details)).includes('04:a2:3b:1c:5d:80:01'));
  });

  test('rotating the QR token revokes the printed card (new token, new fingerprint)', async () => {
    const admin = as(fx.users.adminA).client;
    const before = ((await loadCheckpointSecrets(admin, fx.siteA1)) as { ok: true; value: Array<{ checkpointId: string; qrToken: string }> }).value.find(
      (s) => s.checkpointId === newCheckpointId
    );
    const rotated = await rotateCheckpointToken(admin, newCheckpointId);
    assert.ok(rotated.ok, JSON.stringify(!rotated.ok && rotated.error));
    const after = ((await loadCheckpointSecrets(admin, fx.siteA1)) as { ok: true; value: Array<{ checkpointId: string; qrToken: string }> }).value.find(
      (s) => s.checkpointId === newCheckpointId
    );
    assert.ok(before && after);
    assert.notEqual(after.qrToken, before.qrToken);
    assert.match(after.qrToken, /^EE-CP-[0-9A-F]{32}$/);

    const supervisor = await rotateCheckpointToken(as(fx.users.supA).client, newCheckpointId);
    assert.equal(supervisor.ok, false, 'a supervisor cannot rotate tokens (no fake success)');
  });

  test('a checkpoint with patrol history cannot be deleted (in_use) but can be deactivated; an unused one is deleted', async () => {
    const admin = as(fx.users.adminA).client;
    const refused = await deleteCheckpoint(admin, fx.checkpoints.cpA1);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(refused.error.problem === 'in_use' || refused.error.kind === 'in_use', JSON.stringify(refused.error));

    const deactivated = await setCheckpointActive(admin, fx.checkpoints.cpA1, false);
    assert.ok(deactivated.ok);
    assert.equal(deactivated.value.isActive, false);
    assert.ok(deactivated.value.deactivatedAt, 'server stamps deactivated_at');
    const reactivated = await setCheckpointActive(admin, fx.checkpoints.cpA1, true);
    assert.ok(reactivated.ok);
    assert.equal(reactivated.value.isActive, true);

    const deleted = await deleteCheckpoint(admin, newCheckpointId);
    assert.ok(deleted.ok, JSON.stringify(!deleted.ok && deleted.error));
    const list = await loadSiteCheckpoints(admin, fx.siteA1);
    assert.ok(list.ok);
    assert.ok(!list.value.some((c) => c.id === newCheckpointId));

    const notMine = await deleteCheckpoint(as(fx.users.adminB).client, fx.checkpoints.cpA1NoCoords);
    assert.equal(notMine.ok, false, 'another organisation deletes nothing and is told so');
  });
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

describe('staff', () => {
  test('the list holds the organisation’s people with roles and site assignments only', async () => {
    const staff = await loadStaff(as(fx.users.adminA).client);
    assert.ok(staff.ok);
    const ids = new Set(staff.value.map((m) => m.id));
    assert.ok(ids.has(fx.users.guardA) && ids.has(fx.users.superA) && ids.has(fx.users.disabledGuardA));
    assert.ok(!ids.has(fx.users.adminB) && !ids.has(fx.users.guardB));
    const guardA = staff.value.find((m) => m.id === fx.users.guardA);
    assert.deepEqual(guardA?.roles, ['guard']);
    assert.deepEqual(guardA?.siteIds, [fx.siteA1]);
    assert.equal(staff.value.find((m) => m.id === fx.users.disabledGuardA)?.isActive, false);
  });

  test('roles: granted and revoked with read-back; own roles and super_admin (by an admin) are refused', async () => {
    const admin = as(fx.users.adminA).client;
    const granted = await setStaffRole(admin, fx.users.guardA, 'supervisor', true);
    assert.ok(granted.ok);
    assert.deepEqual(granted.value.roles, ['supervisor', 'guard']);
    const revoked = await setStaffRole(admin, fx.users.guardA, 'supervisor', false);
    assert.ok(revoked.ok);
    assert.deepEqual(revoked.value.roles, ['guard']);

    const own = await setStaffRole(admin, fx.users.adminA, 'guard', true);
    assert.equal(own.ok, false);
    const ownRevoke = await setStaffRole(admin, fx.users.adminA, 'admin', false);
    assert.equal(ownRevoke.ok, false, 'removing one’s own admin role is refused, not reported as done');
    const superGrant = await setStaffRole(admin, fx.users.guardA, 'super_admin', true);
    assert.equal(superGrant.ok, false);
    const bySuper = await setStaffRole(as(fx.users.superA).client, fx.users.supA, 'admin', true);
    assert.ok(bySuper.ok);
    assert.deepEqual(bySuper.value.roles, ['admin', 'supervisor']);
    const undo = await setStaffRole(as(fx.users.superA).client, fx.users.supA, 'admin', false);
    assert.ok(undo.ok);
    assert.deepEqual(undo.value.roles, ['supervisor']);
  });

  test('site assignments: assign and unassign with read-back', async () => {
    const admin = as(fx.users.adminA).client;
    const assigned = await setStaffSite(admin, fx.users.guardA3, fx.siteA1, true);
    assert.ok(assigned.ok);
    assert.deepEqual(new Set(assigned.value.siteIds), new Set([fx.siteA1, fx.siteA2]));
    const unassigned = await setStaffSite(admin, fx.users.guardA3, fx.siteA1, false);
    assert.ok(unassigned.ok);
    assert.deepEqual(unassigned.value.siteIds, [fx.siteA2]);
    const foreign = await setStaffSite(admin, fx.users.guardA3, fx.siteB1, true);
    assert.equal(foreign.ok, false);
  });

  test('deactivate / reactivate an account; only a super admin may deactivate a super admin', async () => {
    const admin = as(fx.users.adminA).client;
    const off = await setStaffActive(admin, fx.users.guardA2, false);
    assert.ok(off.ok);
    assert.equal(off.value.isActive, false);
    const on = await setStaffActive(admin, fx.users.guardA2, true);
    assert.ok(on.ok);
    assert.equal(on.value.isActive, true);
    const superOff = await setStaffActive(admin, fx.users.superA, false);
    assert.equal(superOff.ok, false);
    const stored = await asSuperuser<{ is_active: boolean }>(db, `SELECT is_active FROM profiles WHERE id = $1`, [fx.users.superA]);
    assert.equal(stored.rows[0].is_active, true);
  });

  test('audit log: newest first, only the admin’s organisation', async () => {
    const page = await loadAuditPage(withFirstPageRange(as(fx.users.adminA)), 0, 10);
    assert.ok(page.ok, JSON.stringify(!page.ok && page.error));
    assert.equal(page.value.entries.length, 10);
    assert.equal(page.value.hasMore, true);
    const times = page.value.entries.map((e) => Date.parse(e.createdAt));
    assert.deepEqual([...times].sort((a, b) => b - a), times);
    const orgOf = await asSuperuser<{ organisation_id: string }>(
      db,
      `SELECT DISTINCT organisation_id FROM audit_logs WHERE id = ANY($1::uuid[])`,
      [page.value.entries.map((e) => e.id)]
    );
    assert.deepEqual(orgOf.rows.map((r) => r.organisation_id), [fx.orgA]);

    const guard = await loadAuditPage(withFirstPageRange(as(fx.users.guardA)), 0, 10);
    assert.ok(guard.ok);
    assert.deepEqual(guard.value.entries, [], 'guards read no audit rows');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users (provisioning logic)
// ---------------------------------------------------------------------------

interface FakeAuthAdmin {
  client: ServiceClient;
  created: Array<{ email: string; password: string; email_confirm: boolean }>;
  deleted: string[];
  instances: number;
}

/** Stand-in for the Supabase Auth admin API: writes auth.users like GoTrue (unique e-mail). */
function fakeAuthAdmin(): { factory: () => ServiceClient; state: FakeAuthAdmin } {
  const state: FakeAuthAdmin = { client: null as unknown as ServiceClient, created: [], deleted: [], instances: 0 };
  const client = {
    auth: {
      admin: {
        createUser: async (attrs: { email: string; password: string; email_confirm: boolean }) => {
          state.created.push({ email: attrs.email, password: attrs.password, email_confirm: attrs.email_confirm });
          const exists = await asSuperuser(db, `SELECT 1 FROM auth.users WHERE lower(email) = lower($1)`, [attrs.email]);
          if (exists.rows.length > 0) {
            return {
              data: { user: null },
              error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' }
            };
          }
          const id = randomUUID();
          await asSuperuser(db, `INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, attrs.email]);
          return { data: { user: { id, email: attrs.email } }, error: null };
        },
        deleteUser: async (id: string) => {
          state.deleted.push(id);
          await asSuperuser(db, `DELETE FROM auth.users WHERE id = $1`, [id]);
          return { data: {}, error: null };
        }
      }
    }
  } as unknown as ServiceClient;
  state.client = client;
  return {
    state,
    factory: () => {
      state.instances += 1;
      return client;
    }
  };
}

const PASSWORD = 'Lang-genoeg-42';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: 'Sipho',
    lastName: 'Khoza',
    role: 'guard',
    login: { kind: 'username', username: `wag${Math.floor(Math.random() * 1e6)}` },
    password: PASSWORD,
    employeeNumber: 'G-107',
    phoneNumber: '',
    preferredLanguage: 'zu',
    siteIds: [],
    ...overrides
  };
}

describe('POST /api/admin/users (provisionStaffAccount)', () => {
  test('an admin creates a guard: auth account (confirmed), profile in the admin’s org, role and site; no secret returned', async () => {
    const auth = fakeAuthAdmin();
    const body = request({ login: { kind: 'username', username: 'Wag7' }, siteIds: [fx.siteA1.toUpperCase()] });
    const outcome = await provisionStaffAccount(body, {
      caller: as(fx.users.adminA).client,
      getServiceClient: auth.factory,
      guardLoginDomain: 'Guards.Example.Test'
    });
    assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
    assert.ok(outcome.body.ok);
    const user = outcome.body.user;
    assert.equal(user.email, 'wag7@guards.example.test');
    assert.equal(user.login, 'wag7');
    assert.deepEqual(auth.state.created.map((c) => c.email_confirm), [true]);
    assert.ok(!JSON.stringify(outcome.body).includes(PASSWORD), 'the password is never echoed');

    const profile = await asSuperuser<{ organisation_id: string; is_active: boolean; preferred_language: string; employee_number: string }>(
      db,
      `SELECT organisation_id, is_active, preferred_language, employee_number FROM profiles WHERE id = $1`,
      [user.id]
    );
    assert.deepEqual(profile.rows[0], { organisation_id: fx.orgA, is_active: true, preferred_language: 'zu', employee_number: 'G-107' });
    const roles = await asSuperuser<{ role: string }>(db, `SELECT role FROM user_roles WHERE user_id = $1`, [user.id]);
    assert.deepEqual(roles.rows.map((r) => r.role), ['guard']);
    const sites = await asSuperuser<{ site_id: string }>(db, `SELECT site_id FROM site_assignments WHERE user_id = $1`, [user.id]);
    assert.deepEqual(sites.rows.map((r) => r.site_id), [fx.siteA1]);
    const audit = await asSuperuser<{ actor_id: string }>(
      db,
      `SELECT actor_id FROM audit_logs WHERE action = 'role.granted' AND details ->> 'user_id' = $1`,
      [user.id]
    );
    assert.deepEqual(audit.rows.map((r) => r.actor_id), [fx.users.adminA], 'the admin is recorded as the actor');

    const again = await provisionStaffAccount(body, {
      caller: as(fx.users.adminA).client,
      getServiceClient: auth.factory,
      guardLoginDomain: 'guards.example.test'
    });
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { ok: false, error: 'login_taken' });
  });

  test('callers who are not active admins are refused before the service key is touched', async () => {
    const cases: Array<[PgSupabase, number, string]> = [
      [signedOut(), 401, 'not_signed_in'],
      [as(fx.users.guardA), 403, 'forbidden'],
      [as(fx.users.supA), 403, 'forbidden'],
      [as(fx.users.disabledGuardA), 403, 'account_disabled'],
      [as(randomUUID()), 403, 'forbidden']
    ];
    for (const [caller, status, error] of cases) {
      const auth = fakeAuthAdmin();
      const outcome = await provisionStaffAccount(request({ role: 'admin' }), {
        caller: caller.client,
        getServiceClient: auth.factory,
        guardLoginDomain: 'guards.example.test'
      });
      assert.equal(outcome.status, status, error);
      assert.deepEqual(outcome.body, { ok: false, error });
      assert.equal(auth.state.instances, 0, `${error}: service client never created`);
    }
  });

  test('input is validated server-side: no organisation from the client, no foreign sites, super_admin only by a super admin', async () => {
    const auth = fakeAuthAdmin();
    const deps = { caller: as(fx.users.adminA).client, getServiceClient: auth.factory, guardLoginDomain: 'guards.example.test' };

    const withOrg = await provisionStaffAccount(request({ organisationId: fx.orgB }), deps);
    assert.equal(withOrg.status, 400);
    assert.equal(withOrg.body.ok === false && withOrg.body.error, 'invalid_input');

    const shortPassword = await provisionStaffAccount(request({ password: 'kort' }), deps);
    assert.equal(shortPassword.status, 400);
    assert.deepEqual(shortPassword.body.ok === false && shortPassword.body.fields, ['password']);

    const foreignSite = await provisionStaffAccount(request({ siteIds: [fx.siteB1] }), deps);
    assert.equal(foreignSite.status, 400);
    assert.equal(foreignSite.body.ok === false && foreignSite.body.error, 'invalid_sites');

    const superByAdmin = await provisionStaffAccount(request({ role: 'super_admin', login: { kind: 'email', email: 'baas@example.test' } }), deps);
    assert.equal(superByAdmin.status, 403);
    assert.equal(superByAdmin.body.ok === false && superByAdmin.body.error, 'super_admin_required');
    assert.equal(auth.state.created.length, 0, 'nothing reached the Auth service');

    const superBySuper = await provisionStaffAccount(request({ role: 'super_admin', login: { kind: 'email', email: 'baas@example.test' } }), {
      ...deps,
      caller: as(fx.users.superA).client
    });
    assert.equal(superBySuper.status, 201, JSON.stringify(superBySuper.body));
    assert.ok(superBySuper.body.ok && superBySuper.body.user.login === 'baas@example.test');
  });

  test('a failure after the auth account exists rolls the account back (nothing half-created remains)', async () => {
    const auth = fakeAuthAdmin();
    const caller = as(fx.users.adminA);
    // The role insert reaches the database but its answer is lost: the handler cannot confirm it.
    caller.loseResponses((call) => call.kind === 'insert' && call.target === 'user_roles');
    const outcome = await provisionStaffAccount(request({ login: { kind: 'username', username: 'halfway1' } }), {
      caller: caller.client,
      getServiceClient: auth.factory,
      guardLoginDomain: 'guards.example.test'
    });
    assert.equal(outcome.status, 500);
    assert.deepEqual(outcome.body, { ok: false, error: 'provisioning_failed', stage: 'role', rolledBack: true });
    assert.equal(auth.state.deleted.length, 1);
    const left = await asSuperuser<{ n: number }>(
      db,
      `SELECT (SELECT count(*) FROM auth.users WHERE email = 'halfway1@guards.example.test')::int
            + (SELECT count(*) FROM profiles WHERE id = $1)::int
            + (SELECT count(*) FROM user_roles WHERE user_id = $1)::int AS n`,
      [auth.state.deleted[0]]
    );
    assert.equal(left.rows[0].n, 0);
  });
});
