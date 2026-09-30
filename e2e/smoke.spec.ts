/**
 * Smoke test of the E2E stack: the fake Supabase server (real migrations + RLS) is healthy, the
 * production build serves the login page, a wrong password is rejected BY THE AUTH SERVER and
 * shown to the user, and a guard signs in with the short guard login and lands on /guard with a
 * real session that the proxy accepts. The last test checks that the helpers later specs rely on
 * (API sign-in, fake Web NFC, offline switch) work against the real app.
 */
import { AUTH_COOKIE_NAME } from '../tests/e2e-support/constants';
import { homeFor, login, loginForm, loginViaApi, pathPattern, storedSession } from './support/auth';
import { goOffline, goOnline, isBrowserOnline } from './support/network';
import { installFakeNfc, nfcActiveReaders } from './support/nfc';
import { expect, test } from './support/test';

test.describe('smoke', () => {
  test('fake Supabase server is healthy and runs every migration', async ({ fake }) => {
    const health = await fake.health();
    expect(health.ok).toBe(true);
    expect(health.service).toBe('eagle-eye-fake-supabase');
    expect(health.migrations).toContain('20261001000000_security_audit_hardening.sql');
    const fixture = await fake.reset();
    expect(fixture.users.guard.email).toBe('guard1@guards.test');
    // RLS is real: the guard cannot read another organisation's site.
    const visible = await fake.sqlAs<{ id: string }>(fixture.users.guard.id, 'SELECT id FROM sites ORDER BY name');
    expect(visible.map((row) => row.id)).toEqual([fixture.siteA.id]);
  });

  test('login page renders; protected pages send signed-out visitors to it', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBe(200);
    const form = loginForm(page);
    await expect(form.username).toBeVisible();
    await expect(form.password).toBeVisible();
    await expect(form.submit).toBeVisible();
    await expect(form.submit).toBeEnabled();

    await page.goto('/guard');
    await expect(page).toHaveURL(/\/login\?(.*&)?next=%2Fguard/);
  });

  test('a wrong password is rejected by the Auth server and shown as an error', async ({ page, fake, fixture }) => {
    const since = await fake.lastSeq();
    await login(page, { ...fixture.users.guard, password: 'definitely-not-the-password' }, { expectPath: null });
    const form = loginForm(page);
    await expect(form.error).toHaveText(/\S/);
    await expect(form.error).toBeVisible();
    await expect(page).toHaveURL(/\/login(\?.*)?$/);
    expect(await storedSession(page.context())).toBeNull();

    const { entries } = await fake.requests(since);
    const attempts = entries.filter((e) => e.method === 'POST' && e.path.startsWith('/auth/v1/token?grant_type=password'));
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(400);
    expect(attempts[0].errorCode).toBe('invalid_credentials');
  });

  test('a guard signs in with the short guard login and reaches /guard', async ({ page, fake, fixture }) => {
    const guard = fixture.users.guard;
    expect(homeFor(guard.roles)).toBe('/guard');
    const since = await fake.lastSeq();
    await login(page, guard);
    await expect(page).toHaveURL(pathPattern('/guard'));

    // A genuine Supabase session for this guard is stored where the proxy reads it.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === AUTH_COOKIE_NAME || c.name.startsWith(`${AUTH_COOKIE_NAME}.`))).toBe(true);
    const session = await storedSession(page.context());
    expect(session?.user.id).toBe(guard.id);

    // The sign-in went to the Auth server with the mapped e-mail, and the app then read the
    // guard's own profile under RLS (as this user, not anonymously).
    const { entries } = await fake.requests(since);
    const token = entries.find((e) => e.method === 'POST' && e.path.startsWith('/auth/v1/token?grant_type=password'));
    expect(token?.status).toBe(200);
    await expect
      .poll(async () => (await fake.requests(since)).entries.some((e) => e.path.startsWith('/rest/v1/profiles') && e.userId === guard.id && e.status === 200))
      .toBe(true);
    // The guard's site comes from the database (fixture name, never a constant in the app).
    await expect(page.getByText(fixture.siteA.name).first()).toBeVisible();

    // Reloading keeps the guard in (the proxy validates the session with the Auth server).
    await page.reload();
    await expect(page).toHaveURL(pathPattern('/guard'));
  });

  test('helpers work against the app: API sign-in, fake Web NFC, offline switch', async ({ page, fixture }) => {
    await installFakeNfc(page);
    const session = await loginViaApi(page.context(), fixture.users.guard);
    expect(session.user.id).toBe(fixture.users.guard.id);
    await page.goto('/guard');
    await expect(page).toHaveURL(pathPattern('/guard'));
    await expect(page.getByText(fixture.siteA.name).first()).toBeVisible();

    const nfc = await page.evaluate(() => ({
      reader: typeof (window as unknown as { NDEFReader?: unknown }).NDEFReader === 'function',
      hooks: typeof (window as unknown as { __eeFakeNfc?: { tap?: unknown } }).__eeFakeNfc?.tap === 'function'
    }));
    expect(nfc).toEqual({ reader: true, hooks: true });
    expect(await nfcActiveReaders(page)).toBe(0);

    await goOffline(page.context());
    expect(await isBrowserOnline(page)).toBe(false);
    await goOnline(page.context());
    expect(await isBrowserOnline(page)).toBe(true);
  });
});
