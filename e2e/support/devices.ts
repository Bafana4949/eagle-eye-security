/**
 * Patrol-phone ("enrolled device") helpers for the E2E specs.
 *
 *  - Locators for the login page's "Guard duty" / "Admin & supervisor" tabs, the guard roster and
 *    the Patrol phones panel. They use the `device-*` data-testid hooks first and fall back to
 *    the English wording / ARIA roles, so a renamed hook fails with a readable locator error.
 *  - The phone's local enrolment (localStorage 'ee.patrolDevice', see src/lib/auth/patrolDevice.ts).
 *  - Server-side set-up through the fake Supabase control API (enrolment via the real RPC as a
 *    signed-in supervisor, an extra site + guard of the same organisation).
 *  - Raw calls of the device API routes (what an attacker without the phone could send).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse, BrowserContextOptions, Dialog, Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { FAKE_SUPABASE_URL, GUARD_LOGIN_DOMAIN, TEST_ANON_KEY } from '../../tests/e2e-support/constants';
import { retryFetch } from '../../tests/e2e-support/netRetry';
import { devicesTranslations } from '../../src/lib/i18n/areas/devices';
import type { E2EFixture, E2EUser, FakeSupabaseControl } from './fakeSupabase';

export const PATROL_DEVICE_STORAGE_KEY = 'ee.patrolDevice';
export const DEVICE_ROSTER_PATH = '/api/auth/device-roster';
export const DEVICE_LOGIN_PATH = '/api/auth/device-login';
export const DEVICE_SECRET_PATTERN = /^EED-[0-9a-f]{64}$/;

/** What the phone keeps (contract of src/lib/auth/patrolDevice.ts). */
export interface LocalEnrolment {
  deviceId: string;
  secret: string;
  siteId: string;
  siteName: string;
  label: string;
  enrolledAt: string;
}

/** What public.enrol_patrol_device returns. */
export interface EnrolledDevice {
  device_id: string;
  device_secret: string;
  site_id: string;
  site_name: string;
  label: string;
}

// ------------------------------------------------------------------------------------ utilities

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A well-formed device secret that no phone was ever given. */
export function randomDeviceSecret(): string {
  return `EED-${randomBytes(32).toString('hex')}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "Thabo Guard" as a whitespace-tolerant, case-insensitive pattern. */
export function personName(user: Pick<E2EUser, 'firstName' | 'lastName'>): RegExp {
  return new RegExp(`${escapeRegExp(user.firstName)}\\s+${escapeRegExp(user.lastName)}`, 'i');
}

/**
 * Options of the running project's browser context (phone viewport, touch, locale, GPS ...), for a
 * SECOND phone in the same test (browser.newContext does not apply the project's `use` options).
 */
export function phoneContextOptions(testInfo: TestInfo): BrowserContextOptions {
  const use = testInfo.project.use;
  return {
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    deviceScaleFactor: use.deviceScaleFactor,
    locale: use.locale,
    timezoneId: use.timezoneId,
    permissions: use.permissions,
    geolocation: use.geolocation,
    serviceWorkers: use.serviceWorkers
  };
}

// ------------------------------------------------------------------------ local enrolment

export async function readLocalEnrolment(page: Page): Promise<LocalEnrolment | null> {
  const raw = await page.evaluate((key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }, PATROL_DEVICE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalEnrolment;
  } catch {
    return null;
  }
}

/**
 * Stores an enrolment on this phone exactly as enrolThisPhone would (the page must already be
 * on the app's origin). Reload afterwards so the app picks it up.
 */
export async function writeLocalEnrolment(page: Page, device: EnrolledDevice): Promise<LocalEnrolment> {
  const local: LocalEnrolment = {
    deviceId: device.device_id,
    secret: device.device_secret,
    siteId: device.site_id,
    siteName: device.site_name,
    label: device.label,
    enrolledAt: new Date().toISOString()
  };
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [PATROL_DEVICE_STORAGE_KEY, JSON.stringify(local)] as const
  );
  return local;
}

// ------------------------------------------------------------------ server-side set-up / checks

/** Enrols a phone through the real RPC, executed exactly like a PostgREST call of `userId`. */
export async function enrolDeviceAs(fake: FakeSupabaseControl, userId: string, siteId: string, label: string): Promise<EnrolledDevice> {
  const rows = await fake.sqlAs<{ result: EnrolledDevice }>(userId, `SELECT public.enrol_patrol_device($1::uuid, $2::text) AS result`, [
    siteId,
    label
  ]);
  const device = rows[0]?.result;
  if (!device || !DEVICE_SECRET_PATTERN.test(device.device_secret)) throw new Error(`enrol_patrol_device returned ${JSON.stringify(rows)}`);
  return device;
}

export interface PatrolDeviceRow {
  id: string;
  organisation_id: string;
  site_id: string;
  label: string;
  secret_sha256: string;
  enrolled_by: string | null;
  last_used_at: string | null;
  last_guard_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export async function patrolDeviceRows(fake: FakeSupabaseControl): Promise<PatrolDeviceRow[]> {
  return fake.sql<PatrolDeviceRow>(
    `SELECT id, organisation_id, site_id, label, secret_sha256, enrolled_by, last_used_at, last_guard_id, revoked_at, revoked_by
       FROM public.patrol_devices ORDER BY enrolled_at, id`
  );
}

export interface DeviceAuditRow {
  action: string;
  actor_id: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
}

export async function deviceAuditRows(fake: FakeSupabaseControl): Promise<DeviceAuditRow[]> {
  return fake.sql<DeviceAuditRow>(
    `SELECT action, actor_id, resource_id, details FROM public.audit_logs WHERE action LIKE 'patrol_device.%' ORDER BY created_at, action`
  );
}

export interface ExtraSite {
  site: { id: string; name: string };
  guard: Pick<E2EUser, 'id' | 'email' | 'firstName' | 'lastName'>;
}

/**
 * A second site of organisation A with its own active guard (assigned ONLY there): a patrol phone
 * of site A must neither list nor sign in this guard. Provisioned like an operator would (Auth
 * admin API + SQL).
 */
export async function addSiteWithGuard(fake: FakeSupabaseControl, fixture: E2EFixture): Promise<ExtraSite> {
  const site = { id: '', name: 'Kliprivier Plot (E2E)' };
  const rows = await fake.sql<{ id: string }>(
    `INSERT INTO public.sites (organisation_id, name, code, default_radius_meters, day_shift_start, day_shift_end,
                               night_shift_start, night_shift_end, round_interval_minutes)
     VALUES ($1, $2, 'E2E-C', 50, '06:00', '18:00', '18:00', '06:00', 60) RETURNING id`,
    [fixture.orgA.id, site.name]
  );
  site.id = rows[0].id;
  const guard = { id: '', email: `guardc@${GUARD_LOGIN_DOMAIN}`, firstName: 'Cedric', lastName: 'Elsewhere' };
  guard.id = await fake.createAuthUser(guard.email, `GuardC-e2e-${randomBytes(6).toString('hex')}`);
  await fake.sql(
    `INSERT INTO public.profiles (id, organisation_id, first_name, last_name, employee_number, is_active)
     VALUES ($1, $2, $3, $4, 'GUARDC', true)`,
    [guard.id, fixture.orgA.id, guard.firstName, guard.lastName]
  );
  await fake.sql(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'guard')`, [guard.id]);
  await fake.sql(`INSERT INTO public.site_assignments (site_id, user_id) VALUES ($1, $2)`, [site.id, guard.id]);
  return { site, guard };
}

/** Exchanges a device-login token hash with the fake Auth server (what verifyOtp does). */
export async function verifyTokenHash(tokenHash: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await retryFetch(`${FAKE_SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: TEST_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ token_hash: tokenHash, type: 'magiclink' })
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty body
  }
  return { status: res.status, body };
}

// ------------------------------------------------------------------------------ device API

export interface DeviceApiAnswer {
  status: number;
  /** Parsed JSON (null when the body was not JSON). */
  body: Record<string, unknown> | null;
  text: string;
  cacheControl: string | null;
}

async function answer(response: APIResponse): Promise<DeviceApiAnswer> {
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: response.status(), body, text, cacheControl: response.headers()['cache-control'] ?? null };
}

/**
 * POSTs to a device route. `payload` objects are sent as JSON; a string is sent verbatim with
 * `contentType` (default application/json); `undefined` sends no body at all.
 */
export async function postDeviceApi(
  request: APIRequestContext,
  path: string,
  payload?: unknown,
  options: { contentType?: string | null } = {}
): Promise<DeviceApiAnswer> {
  const headers: Record<string, string> = {};
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (payload !== undefined && contentType) headers['content-type'] = contentType;
  const data = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return answer(await request.post(path, { headers, data, failOnStatusCode: false, maxRedirects: 0 }));
    } catch (error) {
      // Only a TCP connect that never happened is repeated (the request cannot have reached the
      // app); seen on the Windows dev machine under load. See tests/e2e-support/netRetry.ts.
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 4 || !/\bconnect (?:ETIMEDOUT|ECONNREFUSED|EADDRNOTAVAIL)\b/.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

/** The token hash in a device-login success body (the e-mail is never part of it). */
export function tokenHashOf(body: Record<string, unknown> | null): string | null {
  const value = body?.tokenHash ?? body?.token_hash;
  return typeof value === 'string' && value ? value : null;
}

// ------------------------------------------------------------------------------ UI wording

export type AppLanguage = 'af' | 'en' | 'zu';
export type DeviceTextKey = keyof typeof devicesTranslations.en;

/** The language the app currently shows (it defaults to Afrikaans; a profile may prefer another). */
export async function pageLanguage(page: Page): Promise<AppLanguage> {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return lang === 'en' || lang === 'zu' ? lang : 'af';
}

/** A patrol-phone string exactly as the app renders it (its own tables, {0}… filled in). */
export function deviceText(language: AppLanguage, key: DeviceTextKey, ...args: Array<string | number>): string {
  const table = devicesTranslations[language] as Record<string, string>;
  let text = table[key] || (devicesTranslations.en as Record<string, string>)[key];
  args.forEach((arg, index) => {
    text = text.split(`{${index}}`).join(String(arg));
  });
  return text;
}

/** Waits until `locator` shows the app's wording for `key` in the language on screen. */
export async function expectDeviceText(page: Page, locator: Locator, key: DeviceTextKey, ...args: Array<string | number>): Promise<void> {
  await expect(async () => {
    const expected = deviceText(await pageLanguage(page), key, ...args);
    await expect(locator).toContainText(expected, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

// ------------------------------------------------------------------------------- UI locators

/** Buttons of the guard roster: device-guard-button (also device-roster-guard[-<id>], device-guard[-<id>]). */
const ROSTER_BUTTON_TEST_ID = /^device-(?:roster-)?guard(?:-button)?(?:-[0-9a-f-]{36})?$/;

export interface LoginTabs {
  guardTab: Locator;
  adminTab: Locator;
}

export function loginTabs(page: Page): LoginTabs {
  return {
    guardTab: page
      .getByTestId('device-tab-guard')
      .or(page.getByRole('tab', { name: /guard duty/i }))
      .first(),
    adminTab: page
      .getByTestId('device-tab-staff')
      .or(page.getByTestId('device-tab-admin'))
      .or(page.getByRole('tab', { name: /admin/i }))
      .first()
  };
}

export interface GuardDutyView {
  /** Every guard button of the roster. */
  guardButtons: Locator;
  /** The roster button of one person (whatever else the button says). */
  guardButton(user: Pick<E2EUser, 'firstName' | 'lastName'>): Locator;
  /**
   * "This phone is not set up for guard duty — a supervisor must sign in and enrol it" (or, after
   * a revocation, "... no longer set up for guard duty ...").
   */
  notEnrolled: Locator;
  /** The way from the not-enrolled explanation to the e-mail / password form. */
  passwordSignInLink: Locator;
  /** Shared phone, somebody still signed in: "Signed in on this phone: <name>" + hand-over note. */
  handOver: Locator;
}

export function guardDuty(page: Page): GuardDutyView {
  const guardButtons = page.getByTestId(ROSTER_BUTTON_TEST_ID);
  return {
    guardButtons,
    guardButton: (user) =>
      guardButtons
        .filter({ hasText: personName(user) })
        .or(page.getByRole('button', { name: personName(user) }))
        .first(),
    notEnrolled: page
      .getByTestId('device-not-enrolled')
      .or(page.getByText(/(?:not|no longer) set up for guard duty/i))
      .first(),
    passwordSignInLink: page
      .getByTestId('device-use-password')
      .or(page.getByTestId('device-not-enrolled-password-link'))
      .or(page.getByTestId('device-not-enrolled').getByRole('button'))
      .or(page.getByTestId('device-not-enrolled').getByRole('link'))
      .first(),
    handOver: page
      .getByTestId('device-signed-in')
      .or(page.getByText(/signed in on this phone/i))
      .first()
  };
}

/** Shows the "Guard duty" tab of /login (clicks it unless the roster / explanation is already shown). */
export async function openGuardDuty(page: Page): Promise<GuardDutyView> {
  const view = guardDuty(page);
  const tabs = loginTabs(page);
  const shown = view.guardButtons.first().or(view.notEnrolled);
  await expect(async () => {
    if (!(await shown.first().isVisible())) {
      if (await tabs.guardTab.isVisible()) await tabs.guardTab.click();
    }
    await expect(shown.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return view;
}

export interface PatrolPhonesPanel {
  root: Locator;
  /** "Enrol this phone as a patrol phone" / "Enrol again": opens the (collapsed) enrol form. */
  enrolOpenButton: Locator;
  siteSelect: Locator;
  labelInput: Locator;
  /** Submits the form; a confirmation dialog follows (enrolConfirmButton). */
  enrolButton: Locator;
  /** "Enrol and sign out" in the confirmation that says what an enrolled phone is. */
  enrolConfirmButton: Locator;
  /** What is waiting to upload on this phone ("This phone" card). */
  thisPhoneQueued: Locator;
  message: Locator;
  rows: Locator;
  row(label: string): Locator;
  revokeButton(row: Locator): Locator;
  thisPhoneBadge(row: Locator): Locator;
  forgetButton: Locator;
}

export function patrolPhonesPanel(page: Page): PatrolPhonesPanel {
  const root = page
    .getByTestId('device-panel')
    .or(page.getByRole('region', { name: /patrol phones/i }))
    .first();
  const rows = root
    .getByTestId(/^device-row(?:-[0-9a-f-]{36})?$/)
    .or(root.getByRole('listitem'))
    .or(root.getByRole('row'));
  return {
    root,
    enrolOpenButton: root.getByTestId('device-enrol-open').first(),
    siteSelect: root.getByTestId('device-enrol-site').or(root.getByRole('combobox')).first(),
    labelInput: root.getByTestId('device-enrol-label').or(root.getByRole('textbox')).first(),
    enrolButton: root
      .getByTestId('device-enrol-submit')
      .or(root.getByRole('button', { name: /enrol this phone/i }))
      .first(),
    enrolConfirmButton: page
      .getByTestId('device-enrol-confirm-dialog-confirm')
      .or(page.getByRole('dialog').getByRole('button', { name: /enrol and sign out/i }))
      .first(),
    thisPhoneQueued: root.getByTestId('device-this-phone-queued'),
    message: root
      .getByTestId('device-enrol-message')
      .or(root.getByText(/is now a patrol phone for/i))
      .first(),
    rows,
    row: (label) => rows.filter({ hasText: label }).first(),
    revokeButton: (row) => row.getByTestId('device-revoke').or(row.getByRole('button', { name: /revoke/i })).first(),
    // Exact wording only: "Remove enrolment from this phone" is not the badge.
    thisPhoneBadge: (row) => row.getByTestId('device-this-phone').or(row.getByText(/^\s*this phone\s*$/i)).first(),
    forgetButton: root
      .getByTestId('device-forget-local')
      .or(root.getByRole('button', { name: /remove enrolment from this phone/i }))
      .first()
  };
}

/**
 * Opens the Patrol phones panel of the current portal page (a section of the supervisor
 * dashboard; a tab of the admin console — clicked when the panel is not shown yet).
 */
export async function openPatrolPhones(page: Page): Promise<PatrolPhonesPanel> {
  const panel = patrolPhonesPanel(page);
  const opener = page
    .getByTestId('device-panel-open')
    .or(page.getByRole('tab', { name: /^\s*(?:patrol )?phones\s*$/i }))
    .or(page.getByRole('button', { name: /^\s*(?:patrol )?phones\s*$/i }))
    .or(page.getByRole('link', { name: /^\s*(?:patrol )?phones\s*$/i }))
    .first();
  await expect(async () => {
    if (!(await panel.root.isVisible()) && (await opener.isVisible())) await opener.click();
    await expect(panel.root).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await panel.root.scrollIntoViewIfNeeded();
  return panel;
}

/** Opens the enrol form (collapsed behind a button) and picks the site (by id, else by visible name). */
export async function chooseEnrolSite(panel: PatrolPhonesPanel, site: { id: string; name: string }): Promise<void> {
  // The button appears once the manageable sites have loaded; the form opens on a tap.
  await expect(async () => {
    if (!(await panel.labelInput.isVisible()) && (await panel.enrolOpenButton.isVisible())) await panel.enrolOpenButton.click();
    await expect(panel.labelInput).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  if (!(await panel.siteSelect.isVisible())) return; // only one manageable site: nothing to choose
  const values = await panel.siteSelect.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value)
  );
  if (values.includes(site.id)) await panel.siteSelect.selectOption(site.id);
  else await panel.siteSelect.selectOption({ label: site.name });
}

/**
 * Confirms a destructive action whichever way the UI asks: a native confirm() (accepted by the
 * dialog handler installed before the click) or an in-page dialog with a confirm button.
 */
export async function clickAndConfirm(page: Page, trigger: Locator, confirmName: RegExp = /revoke|confirm|yes/i): Promise<void> {
  const acceptNative = (dialog: Dialog) => void dialog.accept().catch(() => undefined);
  page.on('dialog', acceptNative);
  try {
    await trigger.click();
    const confirm = page
      .getByTestId('device-revoke-dialog-confirm')
      .or(page.getByTestId('device-revoke-confirm'))
      .or(page.getByRole('dialog').getByRole('button', { name: confirmName }))
      .or(page.getByRole('alertdialog').getByRole('button', { name: confirmName }))
      .first();
    try {
      await confirm.waitFor({ state: 'visible', timeout: 3_000 });
      await confirm.click();
    } catch {
      // No in-page confirmation: a native confirm() (already accepted) or none at all.
    }
  } finally {
    // Give an asynchronous native dialog a moment before the handler goes away.
    await page.waitForTimeout(250);
    page.off('dialog', acceptNative);
  }
}

// ------------------------------------------------------------------------------- sign-out

/**
 * Signs whoever is signed in out through the app (header button of the portals, or the guard
 * app's "More" page) and waits for /login. Pending-record dialogs (and, on a patrol phone, the
 * "before you sign out" check) are answered "sign out anyway".
 */
export async function signOutThroughApp(page: Page): Promise<void> {
  const header = page.getByTestId('chrome-header-signout');
  const guardMore = page.getByTestId('more-signout');
  let button: Locator = header;
  if (!(await header.isVisible())) {
    if (new URL(page.url()).pathname !== '/guard/more') await page.goto('/guard/more');
    button = guardMore;
  }
  await button.click();
  const force = page.getByTestId('chrome-signout-force');
  const patrolForce = page.getByTestId('chrome-signout-patrol-force');
  await expect(async () => {
    if (await patrolForce.isVisible()) await patrolForce.click();
    if (await force.isVisible()) await force.click();
    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
