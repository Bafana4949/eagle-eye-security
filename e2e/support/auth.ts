/**
 * Sign-in helpers.
 *
 *  - login(page, user)            → through the real /login form (what a person does).
 *  - loginViaApi(context, user)   → password grant against the fake Auth server, then the
 *    session is stored exactly where @supabase/ssr keeps it (the sb-<ref>-auth-token cookie,
 *    base64url-encoded and chunked), so the proxy and the app see a genuine session. Faster for
 *    specs that are not about signing in.
 *
 * The form locators prefer data-testid hooks but fall back to stable HTML semantics
 * (autocomplete="username", type="password", the form's submit button, role="alert").
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { APP_URL, AUTH_COOKIE_NAME, FAKE_SUPABASE_URL, TEST_ANON_KEY } from '../../tests/e2e-support/constants';
import type { E2ERole, E2EUser } from '../../tests/e2e-support/fixture';
import { retryFetch } from '../../tests/e2e-support/netRetry';
import { loginTabs } from './devices';

export interface LoginForm {
  username: Locator;
  password: Locator;
  submit: Locator;
  error: Locator;
}

export function loginForm(page: Page): LoginForm {
  // Fallbacks stay inside the form that has a password field (never the "forgot password" form).
  const form = page.locator('form:has(input[type="password"])');
  return {
    username: page.getByTestId('auth-login-username').or(form.locator('input[autocomplete="username"], input[type="email"]')).first(),
    password: page.getByTestId('auth-login-password').or(form.locator('input[type="password"]')).first(),
    submit: page.getByTestId('auth-login-submit').or(form.locator('button[type="submit"]')).first(),
    // The error live region (empty until something goes wrong).
    error: page.getByTestId('auth-login-error').or(page.locator('[role="alert"][aria-live="assertive"]')).first()
  };
}

/**
 * Makes the e-mail / password form visible. /login has two tabs ("Guard duty" for enrolled
 * patrol phones, "Admin & supervisor" with the password form); this opens the password tab when
 * it is not the one shown. A login page without tabs is left as it is.
 */
export async function showPasswordForm(page: Page): Promise<LoginForm> {
  const form = loginForm(page);
  const { adminTab } = loginTabs(page);
  await expect(async () => {
    if (!(await form.username.isVisible()) && (await adminTab.isVisible())) await adminTab.click();
    await expect(form.username).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return form;
}

/** Home route for a set of roles (mirrors src/lib/auth/routeAccess homeForRoles). */
export function homeFor(roles: E2ERole[]): string {
  if (roles.includes('admin') || roles.includes('super_admin')) return '/admin';
  if (roles.includes('supervisor')) return '/supervisor';
  if (roles.includes('guard')) return '/guard';
  if (roles.includes('client_viewer')) return '/viewer';
  return '/';
}

/** Path regexp that matches `home` and anything below it (query allowed). */
export function pathPattern(home: string): RegExp {
  return new RegExp(`^${APP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${home === '/' ? '/' : `${home}(?:[/?#].*)?`}$`);
}

/**
 * Signs in through the login page and waits until the user's home (or `expectPath`) is shown.
 * Pass `expectPath: null` to only submit (e.g. when the sign-in is expected to fail).
 */
export async function login(
  page: Page,
  user: Pick<E2EUser, 'login' | 'password' | 'roles'>,
  options: { next?: string; expectPath?: string | null; password?: string } = {}
): Promise<void> {
  const target = options.next ? `/login?next=${encodeURIComponent(options.next)}` : '/login';
  await page.goto(target);
  const form = await showPasswordForm(page);
  await form.username.fill(user.login);
  await form.password.fill(options.password ?? user.password);
  await form.submit.click();
  if (options.expectPath === null) return;
  const expected = options.expectPath ?? options.next ?? homeFor(user.roles);
  await expect(page).toHaveURL(pathPattern(expected), { timeout: 30_000 });
}

export interface ApiSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: { id: string; email: string };
}

/** Password grant against the fake Auth server (no browser involved). */
export async function passwordGrant(user: Pick<E2EUser, 'email' | 'password'>): Promise<ApiSession> {
  const res = await retryFetch(`${FAKE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: TEST_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password })
  });
  const body = (await res.json()) as ApiSession & { msg?: string };
  if (!res.ok) throw new Error(`password grant for ${user.email} failed: HTTP ${res.status} ${body.msg ?? ''}`);
  return body;
}

const MAX_COOKIE_CHUNK = 3180;

/** The cookies @supabase/ssr writes for `session` (value "base64-<base64url JSON>", chunked). */
export function sessionCookies(session: ApiSession): Array<{ name: string; value: string }> {
  const value = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  if (value.length <= MAX_COOKIE_CHUNK) return [{ name: AUTH_COOKIE_NAME, value }];
  const chunks: Array<{ name: string; value: string }> = [];
  for (let i = 0; i * MAX_COOKIE_CHUNK < value.length; i += 1) {
    chunks.push({ name: `${AUTH_COOKIE_NAME}.${i}`, value: value.slice(i * MAX_COOKIE_CHUNK, (i + 1) * MAX_COOKIE_CHUNK) });
  }
  return chunks;
}

/** Signs `user` in for every page of `context` without using the login form. */
export async function loginViaApi(context: BrowserContext, user: Pick<E2EUser, 'email' | 'password'>): Promise<ApiSession> {
  const session = await passwordGrant(user);
  const url = new URL(APP_URL);
  await context.addCookies(
    sessionCookies(session).map((cookie) => ({
      ...cookie,
      domain: url.hostname,
      path: '/',
      sameSite: 'Lax' as const,
      httpOnly: false,
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 400 * 24 * 3600
    }))
  );
  return session;
}

/** The session cookie(s) currently in the browser (undefined when signed out). */
export async function sessionCookie(context: BrowserContext): Promise<string | undefined> {
  const cookies = await context.cookies(APP_URL);
  const parts = cookies
    .filter((c) => c.name === AUTH_COOKIE_NAME || c.name.startsWith(`${AUTH_COOKIE_NAME}.`))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  if (parts.length === 0) return undefined;
  return parts.map((c) => c.value).join('');
}

/** Decodes the stored session (to read the signed-in user id in assertions). */
export async function storedSession(context: BrowserContext): Promise<ApiSession | null> {
  const raw = await sessionCookie(context);
  if (!raw) return null;
  const json = raw.startsWith('base64-') ? Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8') : decodeURIComponent(raw);
  try {
    return JSON.parse(json) as ApiSession;
  } catch {
    return null;
  }
}
