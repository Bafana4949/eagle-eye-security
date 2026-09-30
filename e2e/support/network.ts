/**
 * Connectivity helpers.
 *
 *  - goOffline / goOnline: the phone has no network at all (navigator.onLine false, every
 *    request fails, 'offline'/'online' events fire) — Playwright's context.setOffline.
 *  - blockSupabase: the phone is "online" but the Supabase host is unreachable (e.g. a captive
 *    or black-holed rural connection); the app's own pages still load.
 *  - FakeSupabaseControl.setOutage(true) does the same on the server side (connections dropped
 *    by the fake server, which also affects the Next.js proxy's server-side calls).
 */
import type { BrowserContext, Page, Route } from '@playwright/test';
import { FAKE_SUPABASE_URL } from '../../tests/e2e-support/constants';

export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}

export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

export async function isBrowserOnline(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.onLine);
}

const supabasePattern = `${FAKE_SUPABASE_URL}/**`;

async function abortRoute(route: Route): Promise<void> {
  await route.abort('internetdisconnected');
}

/** Fails every browser request to the Supabase server (page navigations are unaffected). */
export async function blockSupabase(context: BrowserContext): Promise<void> {
  await context.route(supabasePattern, abortRoute);
}

export async function unblockSupabase(context: BrowserContext): Promise<void> {
  await context.unroute(supabasePattern, abortRoute);
}
