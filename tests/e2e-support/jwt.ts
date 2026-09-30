/**
 * E2E TEST SUPPORT ONLY: HS256 JSON Web Tokens for the fake Supabase server.
 *
 * Hosted Supabase signs access tokens with the project's JWT secret; this module does the same
 * with a fixed TEST secret (see constants.ts) so the fake GoTrue, PostgREST and Storage
 * endpoints can issue and verify tokens exactly the way the real services do (signature,
 * `exp`, `role`, `sub`). Never use it outside tests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type JwtPayload = Record<string, unknown> & {
  sub?: string;
  role?: string;
  exp?: number;
  iat?: number;
};

export type JwtVerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'unsupported_alg' | 'expired'; message: string };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Signs `payload` as a compact HS256 JWT. */
export function signJwt(payload: JwtPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = hmac(secret, `${header}.${body}`).toString('base64url');
  return `${header}.${body}.${signature}`;
}

/** Decodes without verifying (for diagnostics only). */
export function decodeJwtUnverified(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as JwtPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies signature (HS256 only, like a project with the legacy JWT secret) and expiry.
 * `nowSeconds` is injectable so tests can check expiry handling.
 */
export function verifyJwt(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): JwtVerifyResult {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: 'malformed', message: 'Expected 3 parts in JWT; got ' + parts.length };
  }
  let header: { alg?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: unknown };
  } catch {
    return { ok: false, reason: 'malformed', message: 'JWT header is not valid JSON' };
  }
  if (header.alg !== 'HS256') {
    return { ok: false, reason: 'unsupported_alg', message: `Unsupported JWT algorithm ${String(header.alg)}` };
  }
  const expected = hmac(secret, `${parts[0]}.${parts[1]}`);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature', message: 'JWSError JWSInvalidSignature' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature', message: 'JWSError JWSInvalidSignature' };
  }
  const payload = decodeJwtUnverified(token);
  if (!payload) return { ok: false, reason: 'malformed', message: 'JWT payload is not a JSON object' };
  if (typeof payload.exp === 'number' && payload.exp <= nowSeconds) {
    return { ok: false, reason: 'expired', message: 'JWT expired' };
  }
  return { ok: true, payload };
}
