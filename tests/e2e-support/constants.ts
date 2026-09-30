/**
 * E2E TEST SUPPORT ONLY: fixed settings shared by the fake Supabase server, playwright.config.ts
 * and the specs. Everything here is a TEST value for a throw-away local database; none of it is a
 * production credential and none of it must ever be copied into .env files or src/.
 */
import { signJwt } from './jwt';

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

/** Port of the fake Supabase server (GoTrue + PostgREST + Storage subset). */
export const FAKE_SUPABASE_PORT = envPort('E2E_SUPABASE_PORT', 54329);
/** Port of `next start` for the app under test. */
export const APP_PORT = envPort('E2E_APP_PORT', 3100);

export const FAKE_SUPABASE_URL = `http://127.0.0.1:${FAKE_SUPABASE_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

/** HS256 secret of the fake project (TEST ONLY). */
export const TEST_JWT_SECRET = 'e2e-only-fake-supabase-jwt-secret-do-not-use-anywhere-else-7f3a9c';

/** Header that every /__test/* control request must carry (keeps the app from calling them by accident). */
export const TEST_CONTROL_HEADER = 'x-e2e-control';
export const TEST_CONTROL_TOKEN = 'e2e-control-3b8d1f';

/** Guard logins without '@' map to <login>@<this domain> (NEXT_PUBLIC_GUARD_LOGIN_DOMAIN of the build). */
export const GUARD_LOGIN_DOMAIN = 'guards.test';

/** Fixed issue/expiry so the keys are identical in every process (config, server, specs). */
const KEY_IAT = 1_767_225_600; // 2026-01-01T00:00:00Z
const KEY_EXP = 4_102_444_800; // 2100-01-01T00:00:00Z

/** The project's public anon key (role anon), as NEXT_PUBLIC_SUPABASE_ANON_KEY. */
export const TEST_ANON_KEY = signJwt({ iss: 'supabase-e2e', ref: 'e2e', role: 'anon', iat: KEY_IAT, exp: KEY_EXP }, TEST_JWT_SECRET);
/** Service-role key (BYPASSRLS) for the app's server-side admin route in E2E runs. */
export const TEST_SERVICE_ROLE_KEY = signJwt(
  { iss: 'supabase-e2e', ref: 'e2e', role: 'service_role', iat: KEY_IAT, exp: KEY_EXP },
  TEST_JWT_SECRET
);

/** Where the test phone "is": the centre of fixture site A (Playwright geolocation). */
export const SITE_A_LOCATION = { latitude: -25.68412, longitude: 27.81452 } as const;
/** Accuracy (m) reported by the emulated GPS. */
export const TEST_GPS_ACCURACY_METERS = 8;

/** The @supabase/ssr session cookie name for FAKE_SUPABASE_URL (sb-<first host label>-auth-token). */
export const AUTH_COOKIE_NAME = `sb-${new URL(FAKE_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
