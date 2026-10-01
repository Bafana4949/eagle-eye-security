/**
 * Patrol phones: guards sign in WITHOUT typing an e-mail or password, but only on a phone a
 * supervisor (or org admin) enrolled for one site.
 *
 *  1. A supervisor signs in, opens "Patrol phones", confirms that THIS phone is a shared patrol
 *     phone for site A, and is signed out at once (a manager session never stays on a patrol
 *     phone). The login page's "Guard duty" tab then lists ONLY site A's active guards (no
 *     disabled guard, no managers, nobody of another site or organisation) - the first name within
 *     the first screen even at 320 x 640; tapping a name opens /guard as that guard with a real
 *     Supabase session (service-role RPC → magic link → verifyOtp) and a "not you?" check, and the
 *     next guard can take over the shared phone after a sign-out or by tapping their own name.
 *  2. A phone that was never enrolled explains why and lists nobody.
 *  3. The device API refuses anything but an enrolled phone asking for one of its own guards:
 *     missing / malformed / unknown secrets, managers, guards of other sites or organisations,
 *     disabled guards, any `email` field, oversized or non-JSON bodies. No refused request mints
 *     a magic link, and nothing ever returns an e-mail address.
 *  4. Revoking the phone (supervisor, on another phone) locks it out: its roster request gets 401,
 *     the phone forgets its enrolment and shows the not-enrolled explanation.
 *  5. A manager on a patrol phone: a warning banner in the portal, the phone marked "This phone",
 *     and on /login only "Sign out" (never "Continue as"). A wrong password typed on the
 *     Admin & supervisor tab leaves the guard on duty signed in. Signing out without signal
 *     warns first ("nobody can sign in until there is signal") and defaults to staying signed in.
 *
 * The selfie + GPS at clock-in are attendance evidence for supervisors, not identity checks;
 * nothing here depends on them.
 */
import { randomUUID } from 'node:crypto';
import { login, pathPattern, showPasswordForm, storedSession } from './support/auth';
import { goOffline, goOnline } from './support/network';
import {
  DEVICE_LOGIN_PATH,
  DEVICE_ROSTER_PATH,
  DEVICE_SECRET_PATTERN,
  addSiteWithGuard,
  chooseEnrolSite,
  clickAndConfirm,
  deviceAuditRows,
  enrolDeviceAs,
  expectDeviceText,
  guardDuty,
  openGuardDuty,
  openPatrolPhones,
  patrolDeviceRows,
  personName,
  phoneContextOptions,
  postDeviceApi,
  randomDeviceSecret,
  readLocalEnrolment,
  sha256Hex,
  signOutThroughApp,
  tokenHashOf,
  verifyTokenHash,
  writeLocalEnrolment,
  type DeviceApiAnswer
} from './support/devices';
import type { E2EFixture, FakeSupabaseControl } from './support/fakeSupabase';
import { expect, test } from './support/test';

const PHONE_LABEL = 'Gate phone (E2E)';

/** Everybody who must never appear on site A's patrol-phone roster. */
function notOnSiteARoster(fixture: E2EFixture) {
  const u = fixture.users;
  return [u.disabledGuard, u.supervisor, u.admin, u.viewer, u.guardB];
}

async function generateLinkCount(fake: FakeSupabaseControl, since: number): Promise<number> {
  const { entries } = await fake.requests(since);
  return entries.filter((e) => e.method === 'POST' && e.path.startsWith('/auth/v1/admin/generate_link')).length;
}

function expectRefused(result: DeviceApiAnswer, status: number, error: string, what: string): void {
  expect(result.status, `${what}: HTTP status (body ${result.text})`).toBe(status);
  expect(result.body?.error, `${what}: error code`).toBe(error);
  expect(result.text, `${what}: no e-mail address in the answer`).not.toContain('@');
  expect(tokenHashOf(result.body), `${what}: no token`).toBeNull();
  expect(result.cacheControl ?? '', `${what}: Cache-Control`).toContain('no-store');
}

test.describe('patrol phone guard sign-in', () => {
  test('a supervisor enrols this phone; site A guards tap their name and reach /guard', async ({ page, fake, fixture }) => {
    const { supervisor, guard, guard2 } = fixture.users;
    const extra = await addSiteWithGuard(fake, fixture);

    // --- The supervisor enrols the shared phone for site A.
    await login(page, supervisor);
    const panel = await openPatrolPhones(page);
    // The enrol form is closed until asked for, and enrolling needs a confirmation that says what
    // an enrolled phone is (a shared key to the site's guard accounts - never a personal phone).
    await expect(panel.labelInput).toBeHidden();
    await chooseEnrolSite(panel, fixture.siteA);
    await expect(page.getByTestId('device-enrol-warning')).toBeVisible();
    await panel.labelInput.fill(PHONE_LABEL);
    await panel.enrolButton.click();
    const confirm = page.getByTestId('device-enrol-confirm-dialog');
    await expect(confirm).toBeVisible();
    expect(await patrolDeviceRows(fake), 'nothing is enrolled before the confirmation').toEqual([]);
    await panel.enrolConfirmButton.click();

    // The supervisor is signed out on the patrol phone at once and lands on the Guard duty tab.
    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/, { timeout: 30_000 });
    await expectDeviceText(page, page.getByTestId('auth-login-notice'), 'pdevEnrolledSignedOut', fixture.siteA.name);
    await expect.poll(async () => (await storedSession(page.context()))?.user.id ?? null).toBeNull();

    const local = await readLocalEnrolment(page);
    expect(local).not.toBeNull();
    expect(local!.secret).toMatch(DEVICE_SECRET_PATTERN);
    expect(local).toMatchObject({ siteId: fixture.siteA.id, siteName: fixture.siteA.name, label: PHONE_LABEL });

    // The server keeps only the SHA-256 of the secret; the audit trail never contains it.
    const devices = await patrolDeviceRows(fake);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: local!.deviceId,
      organisation_id: fixture.orgA.id,
      site_id: fixture.siteA.id,
      label: PHONE_LABEL,
      enrolled_by: supervisor.id,
      revoked_at: null,
      secret_sha256: sha256Hex(local!.secret)
    });
    const enrolAudit = await deviceAuditRows(fake);
    expect(enrolAudit.map((a) => [a.action, a.actor_id])).toEqual([['patrol_device.enrolled', supervisor.id]]);
    expect(enrolAudit[0].details).toMatchObject({ device_id: local!.deviceId, site_id: fixture.siteA.id, label: PHONE_LABEL });
    expect(JSON.stringify(enrolAudit)).not.toContain(local!.secret);

    // --- The phone is with the guards.
    const duty = await openGuardDuty(page);
    await expect(duty.guardButtons).toHaveCount(2);
    // With gloves on a 320 x 640 screen the first name must be on the first screen (no scrolling).
    const viewport = page.viewportSize();
    const first = await duty.guardButtons.first().boundingBox();
    expect(first && viewport ? first.y + first.height : Infinity).toBeLessThanOrEqual(viewport?.height ?? 0);
    // Active site-A guards only, in first-name order (Pieter Second, Thabo Guard).
    await expect(duty.guardButtons.nth(0)).toContainText(personName(guard2));
    await expect(duty.guardButtons.nth(1)).toContainText(personName(guard));
    for (const nobody of [...notOnSiteARoster(fixture), extra.guard]) {
      await expect(page.getByText(personName(nobody)), `${nobody.firstName} ${nobody.lastName} must not be listed`).toHaveCount(0);
    }
    await expect(page.getByText(fixture.siteA.name).first()).toBeVisible();
    await expect(page.getByText(PHONE_LABEL).first()).toBeVisible();
    // Big, full-width touch targets (gloves): at least 56 px high.
    for (const button of await duty.guardButtons.all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    }

    // The roster the phone received: names only (no e-mail, phone or employee numbers).
    const roster = await postDeviceApi(page.request, DEVICE_ROSTER_PATH, { deviceSecret: local!.secret });
    expect(roster.status).toBe(200);
    expect(roster.cacheControl ?? '').toContain('no-store');
    expect(roster.text).not.toContain('@');
    expect(roster.text).not.toMatch(/GUARD1|GUARD2|082 000/);

    // --- Thabo taps his name.
    const since = await fake.lastSeq();
    await duty.guardButton(guard).click();
    await expect(page).toHaveURL(pathPattern('/guard'), { timeout: 30_000 });
    await expect(page.getByTestId('chrome-guard-name')).toHaveText(personName(guard));
    await expect(page.getByTestId('chrome-site-name')).toHaveText(fixture.siteA.name);
    expect((await storedSession(page.context()))?.user.id).toBe(guard.id);
    // A gloved mis-tap is caught before clock-in: "Signed in as Thabo Guard - not you?".
    const check = page.getByTestId('device-signed-in-check');
    await expect(check).toBeVisible();
    await expect(check).toContainText(personName(guard));
    await page.getByTestId('device-signed-in-confirm').click();
    await expect(check).toHaveCount(0);

    // How it happened: the Next server asked the database AS THE SERVICE ROLE, minted a magic
    // link, and the phone exchanged the token hash for a session (no password grant at all).
    // (POSTs only: the browser's CORS preflights are logged too.)
    const entries = (await fake.requests(since)).entries.filter((e) => e.method === 'POST');
    const rpc = entries.filter((e) => e.path.startsWith('/rest/v1/rpc/device_guard_login'));
    expect(rpc.map((e) => [e.role, e.status])).toEqual([['service_role', 200]]);
    expect(entries.filter((e) => e.path.startsWith('/auth/v1/admin/generate_link')).map((e) => e.status)).toEqual([200]);
    expect(entries.filter((e) => e.path.startsWith('/auth/v1/verify')).map((e) => e.status)).toEqual([200]);
    expect(entries.some((e) => e.path.startsWith('/auth/v1/token?grant_type=password'))).toBe(false);
    const sessions = (await fake.sessions()).filter((s) => s.userId === guard.id && !s.revoked);
    expect(sessions.map((s) => s.amr[0]?.method)).toEqual(['magiclink']);
    expect((await fake.magicLinks()).map((l) => [l.userId, l.used])).toEqual([[guard.id, true]]);

    const [used] = await patrolDeviceRows(fake);
    expect(used.last_guard_id).toBe(guard.id);
    expect(used.last_used_at).not.toBeNull();
    const signInAudit = (await deviceAuditRows(fake)).filter((a) => a.action === 'patrol_device.guard_signed_in');
    expect(signInAudit.map((a) => a.actor_id)).toEqual([guard.id]);

    // --- Next guard on the same phone, after a sign-out: Thabo signs out, Pieter taps his name.
    await signOutThroughApp(page);
    const again = await openGuardDuty(page);
    await expect(again.guardButtons).toHaveCount(2);
    await again.guardButton(guard2).click();
    await expect(page).toHaveURL(pathPattern('/guard'), { timeout: 30_000 });
    await expect(page.getByTestId('chrome-guard-name')).toHaveText(personName(guard2));
    expect((await storedSession(page.context()))?.user.id).toBe(guard2.id);

    // --- Hand-over WITHOUT a sign-out: Pieter left the phone signed in; Thabo opens the login
    // page, sees who is still signed in, and taps his own name. Thabo's session is created first;
    // then Pieter is forgotten on this phone and his old session is ended on the server (his
    // queued records would stay on the phone).
    await page.goto('/login');
    const handOver = await openGuardDuty(page);
    await expect(handOver.handOver).toBeVisible();
    await expect(handOver.handOver).toContainText(personName(guard2));
    await handOver.guardButton(guard).click();
    await expect(page).toHaveURL(pathPattern('/guard'), { timeout: 30_000 });
    await expect(page.getByTestId('chrome-guard-name')).toHaveText(personName(guard));
    expect((await storedSession(page.context()))?.user.id).toBe(guard.id);
    await expect
      .poll(async () => (await fake.sessions()).filter((s) => s.userId === guard2.id).map((s) => s.revoked))
      .toEqual([true]);
    const signIns = (await deviceAuditRows(fake)).filter((a) => a.action === 'patrol_device.guard_signed_in');
    expect(signIns.map((a) => a.actor_id)).toEqual([guard.id, guard2.id, guard.id]);

    await signOutThroughApp(page);
    await expect((await openGuardDuty(page)).guardButtons).toHaveCount(2);
    // Signing guards out never forgets the phone's enrolment.
    expect(await readLocalEnrolment(page)).toMatchObject({ deviceId: local!.deviceId, secret: local!.secret });
  });

  test('a phone that is not enrolled explains why and lists no guards', async ({ page, fake, fixture }) => {
    const since = await fake.lastSeq();
    await page.goto('/login');
    const duty = await openGuardDuty(page);
    await expect(duty.notEnrolled).toBeVisible();
    await expectDeviceText(page, duty.notEnrolled, 'pdevNotEnrolled');
    await expect(duty.guardButtons).toHaveCount(0);
    for (const user of Object.values(fixture.users).filter((u) => u.firstName)) {
      await expect(page.getByText(personName(user))).toHaveCount(0);
    }
    expect(await readLocalEnrolment(page)).toBeNull();

    // The way out is the ordinary e-mail / password form.
    await duty.passwordSignInLink.click();
    const form = await showPasswordForm(page);
    await expect(form.password).toBeVisible();

    // Nothing was minted or signed in on the way.
    expect(await generateLinkCount(fake, since)).toBe(0);
    expect(await fake.magicLinks()).toEqual([]);
  });

  test('the device API refuses forged, foreign and malformed requests', async ({ page, fake, fixture }) => {
    const { supervisor, admin, guard, disabledGuard, guardB } = fixture.users;
    const extra = await addSiteWithGuard(fake, fixture);
    const device = await enrolDeviceAs(fake, supervisor.id, fixture.siteA.id, 'API phone');
    const secret = device.device_secret;
    const api = page.request; // the (signed-out) browser context's request client, baseURL = the app
    const since = await fake.lastSeq();

    // No body, wrong content type, malformed JSON, missing fields.
    expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH), 400, 'invalid_request', 'login without a body');
    expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH, {}), 400, 'invalid_request', 'login with {}');
    expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH, '{"deviceSecret":'), 400, 'invalid_request', 'login with broken JSON');
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, JSON.stringify({ deviceSecret: secret, guardId: guard.id }), { contentType: 'text/plain' }),
      400,
      'invalid_request',
      'login as a text/plain (form-style cross-site) request'
    );
    expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret }), 400, 'invalid_request', 'login without guardId');
    expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH, { guardId: guard.id }), 400, 'invalid_request', 'login without secret');
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: 'EED-not-a-secret', guardId: guard.id }),
      400,
      'invalid_request',
      'login with a malformed secret'
    );
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: `EED-${secret.slice(4).toUpperCase()}`, guardId: guard.id }),
      400,
      'invalid_request',
      'login with an upper-case secret'
    );
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: 'guard1' }),
      400,
      'invalid_request',
      'login with a non-uuid guard id'
    );

    // Any identity besides the roster id is refused outright — even with a valid secret + guard.
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: guard.id, email: admin.email }),
      400,
      'invalid_request',
      'login with an extra email field'
    );
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: guard.id, email: guard.email }),
      400,
      'invalid_request',
      "login with the guard's own email"
    );
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: guard.id, password: 'x' }),
      400,
      'invalid_request',
      'login with an extra password field'
    );

    // Oversized body (> 2 KB) even though the JSON itself is valid.
    const padded = `{"deviceSecret":"${secret}","guardId":"${guard.id}"${' '.repeat(2100)}}`;
    const oversized = await postDeviceApi(api, DEVICE_LOGIN_PATH, padded);
    expect([400, 413], `oversized body: ${oversized.text}`).toContain(oversized.status);
    expect(tokenHashOf(oversized.body)).toBeNull();

    // A well-formed secret that no phone holds.
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: randomDeviceSecret(), guardId: guard.id }),
      401,
      'device_not_enrolled',
      'login with an unknown secret'
    );

    // The real phone's secret, but somebody who must not get a session through it.
    const outsiders: Array<[string, string]> = [
      ['the org admin', admin.id],
      ['the supervisor', supervisor.id],
      ['a disabled guard of site A', disabledGuard.id],
      ['a guard of another site of the same organisation', extra.guard.id],
      ['a guard of another organisation', guardB.id],
      ['an id nobody has', randomUUID()]
    ];
    for (const [who, id] of outsiders) {
      expectRefused(await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: id }), 403, 'guard_not_allowed', `login for ${who}`);
    }
    // A site-A guard who also holds a manager role is refused too (no manager session via a kiosk).
    await fake.sql(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'supervisor')`, [guard.id]);
    expectRefused(
      await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: guard.id }),
      403,
      'guard_not_allowed',
      'login for a guard who is also a supervisor'
    );
    await fake.sql(`DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'supervisor'`, [guard.id]);

    // Roster: the same checks.
    expectRefused(await postDeviceApi(api, DEVICE_ROSTER_PATH), 400, 'invalid_request', 'roster without a body');
    expectRefused(await postDeviceApi(api, DEVICE_ROSTER_PATH, { deviceSecret: 'nope' }), 400, 'invalid_request', 'roster with a malformed secret');
    expectRefused(
      await postDeviceApi(api, DEVICE_ROSTER_PATH, { deviceSecret: secret, email: guard.email }),
      400,
      'invalid_request',
      'roster with an extra email field'
    );
    expectRefused(
      await postDeviceApi(api, DEVICE_ROSTER_PATH, { deviceSecret: randomDeviceSecret() }),
      401,
      'device_not_enrolled',
      'roster with an unknown secret'
    );
    const methodNotAllowed = await api.get(DEVICE_ROSTER_PATH, { failOnStatusCode: false, maxRedirects: 0 });
    expect(methodNotAllowed.status()).toBe(405);

    // Not a single refused request reached the magic-link step or left a sign-in trace.
    expect(await generateLinkCount(fake, since)).toBe(0);
    expect(await fake.magicLinks()).toEqual([]);
    expect((await deviceAuditRows(fake)).filter((a) => a.action === 'patrol_device.guard_signed_in')).toEqual([]);
    const [unused] = await patrolDeviceRows(fake);
    expect(unused).toMatchObject({ last_used_at: null, last_guard_id: null });

    // The legitimate request works — and its token is single-use.
    const roster = await postDeviceApi(api, DEVICE_ROSTER_PATH, { deviceSecret: secret });
    expect(roster.status).toBe(200);
    expect(roster.text).not.toContain('@');
    const ok = await postDeviceApi(api, DEVICE_LOGIN_PATH, { deviceSecret: secret, guardId: guard.id });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).not.toContain('@');
    expect(ok.cacheControl ?? '').toContain('no-store');
    const tokenHash = tokenHashOf(ok.body);
    expect(tokenHash).toBeTruthy();
    const first = await verifyTokenHash(tokenHash!);
    expect(first.status).toBe(200);
    expect((first.body.user as { id?: string } | undefined)?.id).toBe(guard.id);
    const replay = await verifyTokenHash(tokenHash!);
    expect(replay.status).toBe(403);
    expect(replay.body.error_code ?? replay.body.code).toBe('otp_expired');
  });

  test('a manager is never left signed in on a patrol phone; a wrong password or no signal never strands the guard', async ({
    page,
    fake,
    fixture
  }) => {
    const { supervisor, guard } = fixture.users;
    const device = await enrolDeviceAs(fake, supervisor.id, fixture.siteA.id, PHONE_LABEL);
    await page.goto('/login');
    await writeLocalEnrolment(page, device);

    // --- A supervisor signs in on the patrol phone (e.g. to check the list).
    await login(page, supervisor);
    await expect(page.getByTestId('device-manager-banner')).toBeVisible();
    const panel = await openPatrolPhones(page);
    const row = panel.row(PHONE_LABEL);
    await expect(row).toBeVisible();
    await expect(panel.thisPhoneBadge(row)).toBeVisible();
    await expect(panel.thisPhoneQueued).toBeVisible();

    // On /login the phone offers only "Sign out" for a manager, never "Continue as".
    await page.goto('/login');
    const duty = await openGuardDuty(page);
    await expect(duty.handOver).toBeVisible();
    await expect(page.getByTestId('device-manager-on-phone')).toBeVisible();
    await expect(page.getByTestId('device-continue')).toHaveCount(0);
    await page.getByTestId('device-manager-signout').click();
    await expect(duty.handOver).toHaveCount(0);
    await expect.poll(async () => (await storedSession(page.context()))?.user.id ?? null).toBeNull();

    // --- Thabo goes on duty.
    await duty.guardButton(guard).click();
    await expect(page).toHaveURL(pathPattern('/guard'), { timeout: 30_000 });
    expect((await storedSession(page.context()))?.user.id).toBe(guard.id);

    // A wrong password on the Admin & supervisor tab does not sign Thabo out.
    await page.goto('/login');
    await openGuardDuty(page);
    const form = await showPasswordForm(page);
    await form.username.fill(supervisor.login);
    await form.password.fill('definitely-not-the-password');
    await form.submit.click();
    await expect(form.error).not.toBeEmpty();
    expect((await storedSession(page.context()))?.user.id).toBe(guard.id);
    await expect(guardDuty(page).handOver).toContainText(personName(guard));

    // No signal: signing out warns that nobody can sign in again until there is signal, and the
    // default is to stay signed in.
    await page.goto('/guard/more');
    await goOffline(page.context());
    try {
      await page.getByTestId('more-signout').click();
      const warning = page.getByTestId('chrome-signout-patrol-dialog');
      await expect(warning).toBeVisible();
      await expect(page.getByTestId('chrome-signout-patrol-offline')).toBeVisible();
      await expect(page.getByTestId('chrome-signout-patrol-stay')).toBeFocused();
      await page.getByTestId('chrome-signout-patrol-stay').click();
      await expect(warning).toBeHidden();
      await expect(page).toHaveURL(pathPattern('/guard/more'));
    } finally {
      await goOnline(page.context());
    }
    expect((await storedSession(page.context()))?.user.id).toBe(guard.id);
  });

  test('revoking the phone locks it out: roster 401 and the not-enrolled explanation', async ({ page, browser, fake, fixture }, testInfo) => {
    const { supervisor, guard } = fixture.users;
    const device = await enrolDeviceAs(fake, supervisor.id, fixture.siteA.id, PHONE_LABEL);

    // The patrol phone holds the enrolment and shows its roster.
    await page.goto('/login');
    await writeLocalEnrolment(page, device);
    await page.reload();
    const duty = await openGuardDuty(page);
    await expect(duty.guardButton(guard)).toBeVisible();

    // The supervisor revokes it from their own phone.
    const supervisorPhone = await browser.newContext(phoneContextOptions(testInfo));
    try {
      const own = await supervisorPhone.newPage();
      await login(own, supervisor);
      const panel = await openPatrolPhones(own);
      const row = panel.row(PHONE_LABEL);
      await expect(row).toBeVisible();
      await expect(panel.thisPhoneBadge(row)).toHaveCount(0); // it is not the supervisor's phone
      await clickAndConfirm(own, panel.revokeButton(row));
      await expect
        .poll(async () => (await patrolDeviceRows(fake))[0]?.revoked_at ?? null, { timeout: 15_000 })
        .not.toBeNull();
    } finally {
      await supervisorPhone.close();
    }
    const [revoked] = await patrolDeviceRows(fake);
    expect(revoked.revoked_by).toBe(supervisor.id);
    expect((await deviceAuditRows(fake)).map((a) => [a.action, a.actor_id])).toEqual([
      ['patrol_device.enrolled', supervisor.id],
      ['patrol_device.revoked', supervisor.id]
    ]);

    // The patrol phone's next roster request is refused and it falls back to "not enrolled".
    const rosterAnswer = page.waitForResponse(
      (response) => new URL(response.url()).pathname === DEVICE_ROSTER_PATH && response.request().method() === 'POST'
    );
    await page.reload();
    const lockedOut = await openGuardDuty(page);
    const refused = await rosterAnswer;
    expect(refused.status()).toBe(401);
    await expect(lockedOut.notEnrolled).toBeVisible();
    await expectDeviceText(page, lockedOut.notEnrolled, 'pdevEnrolmentRemoved');
    await expect(lockedOut.guardButtons).toHaveCount(0);
    await expect.poll(() => readLocalEnrolment(page)).toBeNull();

    // And the old secret no longer opens anything.
    const login401 = await postDeviceApi(page.request, DEVICE_LOGIN_PATH, { deviceSecret: device.device_secret, guardId: guard.id });
    expect(login401.status).toBe(401);
    expect(await fake.magicLinks()).toEqual([]);
    await expect(guardDuty(page).guardButton(guard)).toHaveCount(0);
  });
});
