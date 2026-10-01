/**
 * Patrol-phone ("kiosk") guard sign-in — the server logic behind
 *   POST /api/auth/device-roster  { deviceSecret }           → { ok: true, device, site, guards }
 *   POST /api/auth/device-login   { deviceSecret, guardId }  → { ok: true, tokenHash }
 *
 * Trust model
 * - The ONLY credential is the enrolled phone's device secret ("EED-" + 64 hex). A supervisor of
 *   the site (or an org admin) enrolled the phone while signed in on it; the database keeps only
 *   the secret's SHA-256 (supabase/migrations/20261001000200_patrol_devices.sql). Without a valid,
 *   non-revoked secret there is no roster and no session — such phones use e-mail + password.
 * - Which guards may sign in on the phone, and the chosen guard's Auth e-mail, are decided in the
 *   database by the service-role-only functions device_roster / device_guard_login (active guard,
 *   same organisation, assigned to the device's site, no admin/supervisor roles). The request never
 *   carries an e-mail or any identity other than a roster id, and the e-mail is never returned.
 * - The session is issued as a magic-link token hash (auth.admin.generateLink — no e-mail is sent)
 *   that the phone exchanges with supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }). The
 *   guard therefore holds a normal Supabase session: RLS, audit and storage scoping all run under
 *   the guard's own auth.uid().
 * - No fallback: every failure is an error code; nothing "succeeds" without a real token.
 * - The selfie + GPS captured at clock-in is attendance EVIDENCE for supervisors to review. It is
 *   not identity verification (there is no facial recognition).
 *
 * SERVER ONLY (`import 'server-only'`: `next build` fails if a Client Component imports it). Client
 * code may `import type` from here (type imports are erased). node:test loads it after
 * src/lib/testing/allowServerOnly.ts, which stubs the marker package for the test process only.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

/** Device secret format produced by public.enrol_patrol_device ('EED-' + 64 lower-case hex). */
export const DEVICE_SECRET_PATTERN = /^EED-[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both request bodies are tiny ({"deviceSecret":"EED-…","guardId":"…"} is ~130 bytes). */
export const MAX_DEVICE_REQUEST_BYTES = 2 * 1024;

/** Upper bound for each call to Supabase, so a hung upstream never freezes the guard's phone. */
export const DEVICE_UPSTREAM_TIMEOUT_MS = 15_000;

export const DEVICE_LOGIN_ERROR_CODES = [
  'invalid_request',
  'device_not_enrolled',
  'guard_not_allowed',
  'server_not_configured',
  'session_failed'
] as const;
export type DeviceLoginErrorCode = (typeof DEVICE_LOGIN_ERROR_CODES)[number];

export const DEVICE_LOGIN_ERROR_STATUS: Readonly<Record<DeviceLoginErrorCode, number>> = Object.freeze({
  invalid_request: 400,
  device_not_enrolled: 401,
  guard_not_allowed: 403,
  server_not_configured: 503,
  session_failed: 502
});

export interface RosterDevice {
  id: string;
  label: string;
}
export interface RosterSite {
  id: string;
  name: string;
}
export interface RosterGuard {
  id: string;
  firstName: string;
  lastName: string;
}

export type DeviceRosterResult =
  | { ok: true; device: RosterDevice; site: RosterSite; guards: RosterGuard[] }
  | { ok: false; error: DeviceLoginErrorCode };

export type GuardDeviceSessionResult = { ok: true; tokenHash: string } | { ok: false; error: DeviceLoginErrorCode };

/**
 * Response bodies of the two routes (read by src/lib/auth/patrolDevice.ts). Every body carries
 * `ok`, like the other API routes; the client only trusts a refusal in this exact shape.
 */
export interface DeviceRosterResponseBody {
  ok: true;
  device: RosterDevice;
  site: RosterSite;
  guards: RosterGuard[];
}
export interface DeviceLoginResponseBody {
  ok: true;
  tokenHash: string;
}
export interface DeviceErrorResponseBody {
  ok: false;
  error: DeviceLoginErrorCode;
}

export function isValidDeviceSecret(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_SECRET_PATTERN.test(value);
}

export function isValidGuardId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Request bodies. Strict: any other key — in particular `email`, `userId` or `password` — makes the
 * request invalid, so no identity other than a roster id can ever be supplied by a client.
 */
export const deviceRosterRequestSchema = z
  .object({
    deviceSecret: z.string().regex(DEVICE_SECRET_PATTERN)
  })
  .strict();

export const deviceLoginRequestSchema = z
  .object({
    deviceSecret: z.string().regex(DEVICE_SECRET_PATTERN),
    guardId: z
      .string()
      .regex(UUID_PATTERN)
      .transform((id) => id.toLowerCase())
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Dependencies (injected; tests pass fakes)
// ---------------------------------------------------------------------------------------------

export type DeviceRpcName = 'device_roster' | 'device_guard_login';

export interface RpcErrorLike {
  message?: string;
  code?: string;
}

export interface RpcResponse {
  data: unknown;
  error: RpcErrorLike | null;
}

export type MagicLinkResult = { hashedToken: string } | { error: string };

export type DeviceLoginLogger = (message: string, detail?: Record<string, string | number | boolean | null>) => void;

export interface DeviceLoginDeps {
  /** Calls a database function with the service-role client. */
  rpc: (fn: DeviceRpcName, args: Record<string, unknown>) => Promise<RpcResponse>;
  /** auth.admin.generateLink({ type: 'magiclink', email }) → its hashed_token. Sends no e-mail. */
  generateMagicLink: (email: string) => Promise<MagicLinkResult>;
  /** Server-side diagnostics. Only receives redacted text (no secret, token or e-mail). */
  log?: DeviceLoginLogger;
  /** Per-call upstream deadline (default DEVICE_UPSTREAM_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Thrown by deps when the service-role client cannot be created (e.g. key missing). */
export class ServerNotConfiguredError extends Error {
  constructor() {
    super('server_not_configured');
    this.name = 'ServerNotConfiguredError';
  }
}

class UpstreamTimeoutError extends Error {
  constructor() {
    super('upstream_timeout');
    this.name = 'UpstreamTimeoutError';
  }
}

const defaultLog: DeviceLoginLogger = (message, detail) => {
  console.warn(`[device-login] ${message}`, detail ?? {});
};

type ServiceRoleClient = Pick<SupabaseClient, 'rpc' | 'auth'>;

/**
 * Builds the real dependencies from a service-role client factory — the route handlers pass
 * createServiceRoleClient (src/lib/supabase/admin.ts). It is taken as a parameter so this module
 * never imports the `server-only` admin module itself. The client is created lazily on the first
 * call; if that fails (SUPABASE_SERVICE_ROLE_KEY / URL missing) the calls throw
 * ServerNotConfiguredError, which the functions below report as 'server_not_configured'.
 */
export function createDeviceLoginDeps(getServiceClient: () => ServiceRoleClient, log: DeviceLoginLogger = defaultLog): DeviceLoginDeps {
  let client: ServiceRoleClient | null = null;
  const service = (): ServiceRoleClient => {
    if (client) return client;
    try {
      client = getServiceClient();
    } catch {
      // The factory's message names the missing variable only; no need to repeat it here.
      log('service-role client unavailable; check the server environment');
      throw new ServerNotConfiguredError();
    }
    return client;
  };

  return {
    log,
    async rpc(fn, args) {
      const { data, error } = await service().rpc(fn, args);
      if (!error) return { data, error: null };
      return {
        data: null,
        error: {
          message: typeof error.message === 'string' ? error.message : undefined,
          code: typeof error.code === 'string' ? error.code : undefined
        }
      };
    },
    async generateMagicLink(email) {
      const { data, error } = await service().auth.admin.generateLink({ type: 'magiclink', email });
      if (error) {
        // Only the error code/status: Auth messages can contain the e-mail address.
        const code = (error as { code?: unknown }).code;
        const status = (error as { status?: unknown }).status;
        return { error: typeof code === 'string' && code ? code : `status_${typeof status === 'number' ? status : 'unknown'}` };
      }
      const hashed = data?.properties?.hashed_token;
      return typeof hashed === 'string' && hashed.length > 0 ? { hashedToken: hashed } : { error: 'missing_hashed_token' };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------------------------

const SECRET_IN_TEXT = /EED-[0-9a-f]{16,}/gi;
const EMAIL_IN_TEXT = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g;

/** Makes text safe for server logs: no device secret, no e-mail address, bounded length. */
export function redactForLog(text: string): string {
  return text.replace(SECRET_IN_TEXT, '[device-secret]').replace(EMAIL_IN_TEXT, '[email]').slice(0, 300);
}

function logIssue(deps: DeviceLoginDeps, stage: string, detail: Record<string, string | number | boolean | null> = {}): void {
  const safe: Record<string, string | number | boolean | null> = { stage };
  for (const [key, value] of Object.entries(detail)) {
    safe[key] = typeof value === 'string' ? redactForLog(value) : value;
  }
  try {
    (deps.log ?? defaultLog)('device sign-in issue', safe);
  } catch {
    // Logging must never change the outcome.
  }
}

async function withDeadline<T>(deps: DeviceLoginDeps, work: () => Promise<T>): Promise<T> {
  const ms = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0 ? deps.timeoutMs : DEVICE_UPSTREAM_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamTimeoutError()), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Maps a database error to a response code. Only the two exceptions raised on purpose by the
 * device functions map to "not enrolled" / "not allowed"; anything else (missing function,
 * permission problem, bad key, outage) is 'session_failed' — in particular it must NOT look like
 * 'device_not_enrolled', which makes the phone forget its enrolment.
 */
export function mapRpcError(error: RpcErrorLike | null | undefined): DeviceLoginErrorCode {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message === 'device_not_enrolled') return 'device_not_enrolled';
  if (message === 'guard_not_allowed') return 'guard_not_allowed';
  return 'session_failed';
}

function thrownToCode(deps: DeviceLoginDeps, stage: string, thrown: unknown): DeviceLoginErrorCode {
  if (thrown instanceof ServerNotConfiguredError) return 'server_not_configured';
  logIssue(deps, stage, {
    error: thrown instanceof Error ? thrown.name : typeof thrown,
    message: thrown instanceof Error ? thrown.message : null
  });
  return 'session_failed';
}

const rosterNameSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) => (typeof value === 'string' ? value : ''));

/** Shape returned by public.device_roster. Unknown fields are dropped (whitelist). */
const rosterRowSchema = z.object({
  device: z.object({ id: z.string().regex(UUID_PATTERN), label: z.string() }),
  site: z.object({ id: z.string().regex(UUID_PATTERN), name: z.string() }),
  guards: z
    .array(
      z.object({
        id: z.string().regex(UUID_PATTERN),
        first_name: rosterNameSchema,
        last_name: rosterNameSchema
      })
    )
    .nullable()
    .optional()
    .transform((guards) => guards ?? [])
});

/** Shape returned by public.device_guard_login. */
const guardLoginRowSchema = z.object({
  user_id: z.string().regex(UUID_PATTERN),
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/),
  device_id: z.string().regex(UUID_PATTERN),
  site_id: z.string().regex(UUID_PATTERN)
});

/** Lists the guards who may sign in on the phone holding `secret`. */
export async function getDeviceRoster(deps: DeviceLoginDeps, secret: unknown): Promise<DeviceRosterResult> {
  if (!isValidDeviceSecret(secret)) return { ok: false, error: 'invalid_request' };

  let response: RpcResponse;
  try {
    response = await withDeadline(deps, () => deps.rpc('device_roster', { p_secret: secret }));
  } catch (thrown) {
    return { ok: false, error: thrownToCode(deps, 'device_roster', thrown) };
  }

  if (response.error) {
    const code = mapRpcError(response.error);
    if (code === 'session_failed') {
      logIssue(deps, 'device_roster', { code: response.error.code ?? null, message: response.error.message ?? null });
    }
    return { ok: false, error: code };
  }
  // The function returns NULL for an unknown or revoked phone (or an inactive site).
  if (response.data === null || response.data === undefined) return { ok: false, error: 'device_not_enrolled' };

  const parsed = rosterRowSchema.safeParse(response.data);
  if (!parsed.success) {
    logIssue(deps, 'device_roster', { message: 'unexpected result shape' });
    return { ok: false, error: 'session_failed' };
  }
  const row = parsed.data;
  return {
    ok: true,
    device: { id: row.device.id, label: row.device.label },
    site: { id: row.site.id, name: row.site.name },
    guards: row.guards.map((guard) => ({ id: guard.id, firstName: guard.first_name, lastName: guard.last_name }))
  };
}

/**
 * Issues a sign-in token for `guardId` on the phone holding `secret`. The database decides whether
 * the guard is allowed on that phone and supplies the Auth e-mail; only then is a magic-link token
 * generated. Only the token hash is returned — never the e-mail.
 */
export async function issueGuardDeviceSession(deps: DeviceLoginDeps, secret: unknown, guardId: unknown): Promise<GuardDeviceSessionResult> {
  if (!isValidDeviceSecret(secret) || !isValidGuardId(guardId)) return { ok: false, error: 'invalid_request' };
  const requestedGuard = guardId.toLowerCase();

  let response: RpcResponse;
  try {
    response = await withDeadline(deps, () => deps.rpc('device_guard_login', { p_secret: secret, p_guard_id: requestedGuard }));
  } catch (thrown) {
    return { ok: false, error: thrownToCode(deps, 'device_guard_login', thrown) };
  }

  if (response.error) {
    const code = mapRpcError(response.error);
    if (code === 'session_failed') {
      logIssue(deps, 'device_guard_login', { code: response.error.code ?? null, message: response.error.message ?? null });
    }
    return { ok: false, error: code };
  }

  const parsed = guardLoginRowSchema.safeParse(response.data);
  if (!parsed.success) {
    logIssue(deps, 'device_guard_login', { message: 'unexpected result shape' });
    return { ok: false, error: 'session_failed' };
  }
  if (parsed.data.user_id.toLowerCase() !== requestedGuard) {
    // The database must authorise exactly the guard that was tapped; anything else is refused.
    logIssue(deps, 'device_guard_login', { message: 'result is for a different user' });
    return { ok: false, error: 'session_failed' };
  }

  let link: MagicLinkResult;
  try {
    link = await withDeadline(deps, () => deps.generateMagicLink(parsed.data.email));
  } catch (thrown) {
    return { ok: false, error: thrownToCode(deps, 'generate_link', thrown) };
  }
  // A token hash is printable ASCII without spaces (GoTrue: 56 hex characters).
  if (!('hashedToken' in link) || typeof link.hashedToken !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(link.hashedToken)) {
    logIssue(deps, 'generate_link', { error: 'error' in link && typeof link.error === 'string' ? link.error : 'invalid token' });
    return { ok: false, error: 'session_failed' };
  }
  return { ok: true, tokenHash: link.hashedToken };
}

// ---------------------------------------------------------------------------------------------
// HTTP request handling (framework-free; the route handlers only adapt Request/Response)
// ---------------------------------------------------------------------------------------------

export interface DeviceHttpRequest {
  contentType: string | null;
  contentLength: string | null;
  body: ReadableStream<Uint8Array> | null;
}

export type DeviceRouteOutcome<T> = { status: number; body: T | DeviceErrorResponseBody };

function refuse(error: DeviceLoginErrorCode): { status: number; body: DeviceErrorResponseBody } {
  return { status: DEVICE_LOGIN_ERROR_STATUS[error], body: { ok: false, error } };
}

/**
 * Reads at most `maxBytes` of a request body as UTF-8 text. Returns null when the body is missing,
 * larger than the limit (reading stops there), unreadable or not valid UTF-8.
 */
export async function readLimitedBodyText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_DEVICE_REQUEST_BYTES
): Promise<string | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const INVALID = Symbol('invalid');

async function readJsonBody(request: DeviceHttpRequest): Promise<unknown | typeof INVALID> {
  if (!/^application\/json\b/i.test((request.contentType ?? '').trim())) return INVALID;
  if (request.contentLength !== null && request.contentLength.trim() !== '') {
    const declared = Number(request.contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > MAX_DEVICE_REQUEST_BYTES) return INVALID;
  }
  const text = await readLimitedBodyText(request.body, MAX_DEVICE_REQUEST_BYTES);
  if (text === null) return INVALID;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID;
  }
}

/** POST /api/auth/device-roster */
export async function handleDeviceRosterRequest(
  request: DeviceHttpRequest,
  deps: DeviceLoginDeps
): Promise<DeviceRouteOutcome<DeviceRosterResponseBody>> {
  const json = await readJsonBody(request);
  if (json === INVALID) return refuse('invalid_request');
  const parsed = deviceRosterRequestSchema.safeParse(json);
  if (!parsed.success) return refuse('invalid_request');

  const result = await getDeviceRoster(deps, parsed.data.deviceSecret);
  if (!result.ok) return refuse(result.error);
  return { status: 200, body: { ok: true, device: result.device, site: result.site, guards: result.guards } };
}

/** POST /api/auth/device-login */
export async function handleDeviceLoginRequest(
  request: DeviceHttpRequest,
  deps: DeviceLoginDeps
): Promise<DeviceRouteOutcome<DeviceLoginResponseBody>> {
  const json = await readJsonBody(request);
  if (json === INVALID) return refuse('invalid_request');
  const parsed = deviceLoginRequestSchema.safeParse(json);
  if (!parsed.success) return refuse('invalid_request');

  const result = await issueGuardDeviceSession(deps, parsed.data.deviceSecret, parsed.data.guardId);
  if (!result.ok) return refuse(result.error);
  return { status: 200, body: { ok: true, tokenHash: result.tokenHash } };
}
