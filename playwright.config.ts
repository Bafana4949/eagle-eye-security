/**
 * Browser end-to-end tests: the production build of the app (`next build && next start`) against
 * a local fake Supabase server whose database is PGlite with ALL real migrations applied, so RLS,
 * triggers and storage policies are genuinely enforced (tests/e2e-support/fake-supabase).
 *
 *   npx playwright test                         # builds the app first (slow)
 *   E2E_SKIP_BUILD=1 npx playwright test        # reuse the existing .next build of THIS config
 *   npx playwright test e2e/smoke.spec.ts --project=chromium-mobile
 *
 * Env: E2E_SUPABASE_PORT (54329), E2E_APP_PORT (3100), E2E_CHROMIUM_PATH, E2E_REUSE_APP=1,
 *      E2E_NEXT_BUNDLER=webpack|turbopack (default: turbopack unless node_modules links outside).
 * All keys/passwords used here are TEST values of the throw-away fake project.
 */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { FAKE_MEDIA_ARGS, resolveChromiumExecutable } from './tests/e2e-support/chromium';
import {
  APP_PORT,
  APP_URL,
  FAKE_SUPABASE_PORT,
  FAKE_SUPABASE_URL,
  GUARD_LOGIN_DOMAIN,
  SITE_A_LOCATION,
  TEST_ANON_KEY,
  TEST_GPS_ACCURACY_METERS,
  TEST_SERVICE_ROLE_KEY
} from './tests/e2e-support/constants';

const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

const executablePath = resolveChromiumExecutable();

type UseOptions = NonNullable<PlaywrightTestConfig['use']>;

const phone: UseOptions = {
  browserName: 'chromium',
  baseURL: APP_URL,
  userAgent: ANDROID_CHROME_UA,
  isMobile: true,
  hasTouch: true,
  locale: 'en-ZA',
  timezoneId: 'Africa/Johannesburg',
  permissions: ['camera', 'geolocation', 'clipboard-read', 'clipboard-write'],
  geolocation: { latitude: SITE_A_LOCATION.latitude, longitude: SITE_A_LOCATION.longitude, accuracy: TEST_GPS_ACCURACY_METERS },
  serviceWorkers: 'allow',
  launchOptions: { executablePath, args: FAKE_MEDIA_ARGS },
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'off',
  actionTimeout: 15_000,
  navigationTimeout: 45_000
};

/**
 * Turbopack (the Next 16 default) refuses a node_modules that is a symlink/junction pointing
 * outside the project ("points out of the filesystem root"), as in shared-worktree setups; webpack
 * follows it. A normal checkout keeps the default bundler. E2E_NEXT_BUNDLER=webpack|turbopack forces one.
 */
function nextBuildCommand(): string {
  const forced = process.env.E2E_NEXT_BUNDLER;
  if (forced === 'webpack') return 'npx next build --webpack';
  if (forced === 'turbopack') return 'npx next build';
  try {
    const modules = path.join(__dirname, 'node_modules');
    if (lstatSync(modules).isSymbolicLink()) {
      const target = realpathSync(modules);
      const relative = path.relative(__dirname, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return 'npx next build --webpack';
    }
  } catch {
    // no node_modules link: default bundler
  }
  return 'npx next build';
}

const skipBuild = process.env.E2E_SKIP_BUILD === '1';
const nextStart = `npx next start -p ${APP_PORT} -H 127.0.0.1`;

export default defineConfig({
  testDir: './e2e',
  // One shared fake database: tests reset it and must not run concurrently.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  projects: [
    { name: 'chromium-mobile', use: { ...phone, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 } },
    { name: 'chromium-small', use: { ...phone, viewport: { width: 320, height: 640 }, deviceScaleFactor: 2 } }
  ],
  webServer: [
    {
      name: 'fake-supabase',
      command: 'npx tsx tests/e2e-support/fake-supabase/main.ts',
      url: `${FAKE_SUPABASE_URL}/__test/health`,
      env: { E2E_SUPABASE_PORT: String(FAKE_SUPABASE_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      name: 'next',
      command: skipBuild ? nextStart : `${nextBuildCommand()} && ${nextStart}`,
      url: `${APP_URL}/login`,
      env: {
        NEXT_PUBLIC_SUPABASE_URL: FAKE_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: TEST_ANON_KEY,
        NEXT_PUBLIC_GUARD_LOGIN_DOMAIN: GUARD_LOGIN_DOMAIN,
        // Server-only, for the admin user-provisioning route (fake project's TEST service key).
        SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_ROLE_KEY,
        NEXT_TELEMETRY_DISABLED: '1'
      },
      reuseExistingServer: process.env.E2E_REUSE_APP === '1',
      // `next build` on a cold cache can take many minutes on Windows.
      timeout: 20 * 60_000,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  ]
});
