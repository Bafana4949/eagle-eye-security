import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * Build version.
 *
 * One value is used for:
 *   - generateBuildId (the Next.js build id),
 *   - NEXT_PUBLIC_APP_VERSION in the client bundle (PwaRegistrar registers `/sw.js?v=<version>` and the
 *     service worker derives its cache names from it, so every build gets fresh caches), and
 *   - the `X-App-Version` response header (PwaRegistrar compares it with its own version to notice a
 *     new deployment even though /sw.js itself is byte-identical between builds).
 *
 * Priority: NEXT_PUBLIC_APP_VERSION set by CI/hosting → `<git sha>-<UTC build time>` → `<UTC build time>`.
 * The resolved value is written back to process.env on first evaluation, so build workers that load
 * this file again inherit the same version instead of computing a new timestamp.
 */
const APP_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function gitShortSha(): string | null {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_REF || process.env.GIT_COMMIT;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 12).toLowerCase();
  try {
    const out = execSync('git rev-parse --short=12 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    })
      .toString()
      .trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

function resolveAppVersion(): string {
  const configured = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (configured && APP_VERSION_PATTERN.test(configured)) return configured;
  if (configured) {
    console.warn(
      '[next.config] NEXT_PUBLIC_APP_VERSION must match /^[A-Za-z0-9._-]{1,64}$/; using a generated build version instead.'
    );
  }
  // e.g. 20261001t061512 (UTC)
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', 't');
  const sha = gitShortSha();
  return sha ? `${sha}-${stamp}` : stamp;
}

const APP_VERSION = resolveAppVersion();
process.env.NEXT_PUBLIC_APP_VERSION = APP_VERSION;

/**
 * Conservative security headers for every response. The CSP only sets directives that cannot break
 * Next.js inline scripts or Supabase (frame-ancestors, base-uri, object-src, form-action); a full
 * script-src/connect-src policy needs nonces from the proxy and is a separate decision.
 */
const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), geolocation=(self), screen-wake-lock=(self), microphone=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-App-Version', value: APP_VERSION },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  generateBuildId: async () => APP_VERSION,
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
      {
        // The service worker must never be served from the HTTP cache, otherwise update checks miss new builds.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
        ],
      },
      {
        source: '/offline.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default nextConfig;
