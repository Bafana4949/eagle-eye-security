/**
 * Patrol phones ("kiosk" phones) — the browser side.
 *
 * A supervisor assigned to a site (or an org admin), signed in on a shared patrol phone, enrols
 * it for ONE site (RPC enrol_patrol_device). The server keeps only the SHA-256 of a random
 * device secret; the secret itself is stored here, in this browser's localStorage. Only a
 * request carrying a valid, non-revoked secret can list that site's guards
 * (POST /api/auth/device-roster) and obtain a session for one of them
 * (POST /api/auth/device-login → token hash → supabase.auth.verifyOtp). Guards therefore never
 * type an e-mail or a password on a patrol phone; everyone else signs in with a password.
 *
 * Rules kept here:
 * - The client never sends an e-mail address or any user identity other than the guard's id
 *   picked from the server's roster; the server decides who may sign in.
 * - No success without a real Supabase session (verifyOtp must return one for that guard).
 * - Errors are reported as what they are: offline, timeout (the server did not answer in time),
 *   not_enrolled, not_allowed, server_not_configured or failed.
 * - Every storage access is wrapped: blocked storage means "not enrolled", never a crash.
 *
 * The live selfie + GPS at clock-in is attendance evidence for supervisors to review. It is not
 * identity verification (there is no face recognition).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserRole } from '@/types/models';
import { isNetworkFailure } from './authErrors';
import { browserStorage, setCurrentUserPointer, writeActiveSiteId, type KeyValueStorage } from './identity';

export const PATROL_DEVICE_STORAGE_KEY = 'ee.patrolDevice';
/** Same-tab notification when the enrolment changes (the 'storage' event only fires in other tabs). */
export const PATROL_DEVICE_CHANGE_EVENT = 'eagle-eye:patrol-device-change';

export const DEVICE_ROSTER_PATH = '/api/auth/device-roster';
export const DEVICE_LOGIN_PATH = '/api/auth/device-login';

/** Format of the secret minted by enrol_patrol_device ('EED-' + 64 lowercase hex characters). */
export const DEVICE_SECRET_PATTERN = /^EED-[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same limit as the database (patrol_devices.label varchar(80)). */
export const PATROL_DEVICE_LABEL_MAX = 80;
/**
 * How long the phone waits for a device route. LONGER than the server's own worst case (two
 * upstream calls of DEVICE_UPSTREAM_TIMEOUT_MS = 15 s each in src/lib/auth/deviceLogin.ts), so a
 * slow but successful sign-in is not reported as a failure while the server completes it.
 */
export const DEVICE_REQUEST_TIMEOUT_MS = 35_000;

/** What this phone remembers about its enrolment. `secret` is the only credential. */
export interface PatrolDevice {
  deviceId: string;
  secret: string;
  siteId: string;
  siteName: string;
  label: string;
  /** ISO time this phone was enrolled. */
  enrolledAt: string;
}

export type PatrolDeviceErrorKind = 'offline' | 'timeout' | 'not_enrolled' | 'not_allowed' | 'server_not_configured' | 'failed';

export interface RosterGuard {
  id: string;
  firstName: string;
  lastName: string;
}

export type DeviceRosterResult =
  | { ok: true; device: { id: string; label: string }; site: { id: string; name: string }; guards: RosterGuard[] }
  | { ok: false; error: PatrolDeviceErrorKind };

export type GuardDeviceSignInResult = { ok: true; userId: string } | { ok: false; error: PatrolDeviceErrorKind };

export type EnrolErrorKind = 'not_allowed' | 'invalid_label' | 'offline' | 'storage_unavailable' | 'failed';
export type EnrolResult = { ok: true; device: PatrolDevice } | { ok: false; error: EnrolErrorKind; message?: string };

export type RevokeResult = { ok: true } | { ok: false; error: 'not_allowed' | 'offline' | 'failed'; message?: string };

// ---------------------------------------------------------------------------
// Local enrolment (localStorage)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidDevice(value: unknown): value is PatrolDevice {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.deviceId === 'string' &&
    UUID_PATTERN.test(d.deviceId) &&
    typeof d.secret === 'string' &&
    DEVICE_SECRET_PATTERN.test(d.secret) &&
    typeof d.siteId === 'string' &&
    UUID_PATTERN.test(d.siteId) &&
    typeof d.siteName === 'string' &&
    isNonEmptyString(d.label) &&
    typeof d.enrolledAt === 'string'
  );
}

/** Parses a stored enrolment; anything malformed counts as "not enrolled". */
export function parsePatrolDevice(raw: string | null | undefined): PatrolDevice | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidDevice(parsed)) return null;
    const { deviceId, secret, siteId, siteName, label, enrolledAt } = parsed;
    return { deviceId, secret, siteId, siteName, label, enrolledAt };
  } catch {
    return null;
  }
}

function notifyChange(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PATROL_DEVICE_CHANGE_EVENT));
  } catch {
    // No window / events unavailable: listeners simply re-read later.
  }
}

/** The raw stored value (a stable string snapshot for React's useSyncExternalStore). */
export function readPatrolDeviceRaw(storage: KeyValueStorage | null = browserStorage()): string | null {
  try {
    return storage ? storage.getItem(PATROL_DEVICE_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

export function loadPatrolDevice(storage: KeyValueStorage | null = browserStorage()): PatrolDevice | null {
  return parsePatrolDevice(readPatrolDeviceRaw(storage));
}

/** Stores the enrolment. Returns false when it could not be stored (storage blocked / full). */
export function savePatrolDevice(device: PatrolDevice, storage: KeyValueStorage | null = browserStorage()): boolean {
  if (!storage || !isValidDevice(device)) return false;
  const { deviceId, secret, siteId, siteName, label, enrolledAt } = device;
  try {
    storage.setItem(PATROL_DEVICE_STORAGE_KEY, JSON.stringify({ deviceId, secret, siteId, siteName, label, enrolledAt }));
  } catch {
    return false;
  }
  notifyChange();
  // Read it back: some browsers accept the write and drop it (e.g. storage partitioning).
  return loadPatrolDevice(storage)?.secret === secret;
}

/** Forgets this phone's enrolment (the server entry stays until it is revoked). */
export function clearPatrolDevice(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(PATROL_DEVICE_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing could have been stored either.
  }
  notifyChange();
}

/** Subscribes to enrolment changes in this tab and in other tabs. */
export function subscribePatrolDevice(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PATROL_DEVICE_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(PATROL_DEVICE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(PATROL_DEVICE_CHANGE_EVENT, onChange);
  };
}

// ---------------------------------------------------------------------------
// Enrolment and revocation (signed-in admin / supervisor, RLS + SECURITY DEFINER RPCs)
// ---------------------------------------------------------------------------

interface RpcErrorLike {
  code?: unknown;
  message?: unknown;
}

function rpcErrorKind(error: unknown, status: number | undefined): 'not_allowed' | 'invalid_label' | 'offline' | 'failed' {
  const e = (error ?? {}) as RpcErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === '42501') return 'not_allowed';
  if (code === '22023') return 'invalid_label';
  if (!code && status !== 429 && isNetworkFailure(status, error)) return 'offline';
  return 'failed';
}

function messageOf(error: unknown): string | undefined {
  const e = (error ?? {}) as RpcErrorLike;
  if (typeof e.message === 'string' && e.message) return e.message;
  return error instanceof Error ? error.message : undefined;
}

type RpcClient = Pick<SupabaseClient, 'rpc'>;

interface RpcResponse {
  data: unknown;
  error: unknown;
  status?: number;
}

async function callRpc(supabase: RpcClient, fn: string, args: Record<string, unknown>): Promise<RpcResponse> {
  try {
    return (await supabase.rpc(fn, args)) as RpcResponse;
  } catch (error) {
    return { data: null, error, status: 0 };
  }
}

/**
 * Enrols THIS phone for `siteId` (the caller must manage that site) and stores the secret here.
 * If this browser cannot keep the secret, the new server entry is revoked again and nothing is
 * reported as enrolled.
 */
export async function enrolThisPhone(
  supabase: RpcClient,
  siteId: string,
  label: string,
  storage: KeyValueStorage | null = browserStorage(),
  now: () => Date = () => new Date()
): Promise<EnrolResult> {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed || trimmed.length > PATROL_DEVICE_LABEL_MAX) return { ok: false, error: 'invalid_label' };
  if (!UUID_PATTERN.test(siteId)) return { ok: false, error: 'failed', message: 'Invalid site.' };

  const { data, error, status } = await callRpc(supabase, 'enrol_patrol_device', { p_site_id: siteId, p_label: trimmed });
  if (error) return { ok: false, error: rpcErrorKind(error, status), message: messageOf(error) };

  const row = (data ?? {}) as Record<string, unknown>;
  const device: PatrolDevice = {
    deviceId: typeof row.device_id === 'string' ? row.device_id : '',
    secret: typeof row.device_secret === 'string' ? row.device_secret : '',
    siteId: typeof row.site_id === 'string' ? row.site_id : '',
    siteName: typeof row.site_name === 'string' ? row.site_name : '',
    label: typeof row.label === 'string' ? row.label : trimmed,
    enrolledAt: now().toISOString()
  };
  if (!isValidDevice(device) || device.siteId !== siteId) {
    return { ok: false, error: 'failed', message: 'The server did not return a usable enrolment.' };
  }

  if (!savePatrolDevice(device, storage)) {
    // Nobody can ever present that secret: close the entry instead of leaving it active.
    if (UUID_PATTERN.test(device.deviceId)) await callRpc(supabase, 'revoke_patrol_device', { p_device_id: device.deviceId });
    return { ok: false, error: 'storage_unavailable' };
  }
  return { ok: true, device };
}

/** Revokes a patrol phone (server). If it is this phone, its local enrolment is forgotten too. */
export async function revokePatrolDevice(
  supabase: RpcClient,
  deviceId: string,
  storage: KeyValueStorage | null = browserStorage()
): Promise<RevokeResult> {
  if (!UUID_PATTERN.test(deviceId)) return { ok: false, error: 'failed', message: 'Invalid device.' };
  const { error, status } = await callRpc(supabase, 'revoke_patrol_device', { p_device_id: deviceId });
  if (error) {
    const kind = rpcErrorKind(error, status);
    return { ok: false, error: kind === 'invalid_label' ? 'failed' : kind, message: messageOf(error) };
  }
  if (loadPatrolDevice(storage)?.deviceId === deviceId) clearPatrolDevice(storage);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Roster and guard sign-in (the device secret is the only credential sent)
// ---------------------------------------------------------------------------

export interface DeviceRequestOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  storage?: KeyValueStorage | null;
  /** Defaults to navigator.onLine === false. */
  isOffline?: () => boolean;
  timeoutMs?: number;
}

function defaultIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

interface JsonAnswer {
  status: number;
  body: unknown;
}

/**
 * POSTs JSON. Resolves 'offline' when the server could not be reached and 'timeout' when it did not
 * answer within the deadline (it may still be working on it - not the same as "no connection").
 */
async function postJson(
  path: string,
  payload: Record<string, string>,
  options: DeviceRequestOptions
): Promise<JsonAnswer | 'offline' | 'timeout'> {
  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchImpl) return 'offline';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? DEVICE_REQUEST_TIMEOUT_MS)
    : null;
  try {
    const response = await fetchImpl(path, {
      method: 'POST',
      // The device secret is the credential; no cookies are needed or sent.
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return timedOut ? 'timeout' : 'offline';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bodyError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  return b.ok === false && typeof b.error === 'string' ? b.error : null;
}

/**
 * Maps a refused answer to an error kind. Only an answer in the API's own JSON error shape is
 * trusted to mean "not enrolled" (which wipes the local enrolment) — a 401 / 503 page from
 * something in between (captive portal, proxy) is reported as "failed" instead.
 */
function refusal(answer: JsonAnswer): PatrolDeviceErrorKind {
  const code = bodyError(answer.body);
  if (answer.status === 401 && code !== null) return 'not_enrolled';
  if (answer.status === 403 && code !== null) return 'not_allowed';
  if (answer.status === 503 && code === 'server_not_configured') return 'server_not_configured';
  return 'failed';
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseGuard(value: unknown): RosterGuard | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as Record<string, unknown>;
  const id = str(g.id);
  const firstName = str(g.firstName) ?? str(g.first_name);
  const lastName = str(g.lastName) ?? str(g.last_name);
  if (!id || !UUID_PATTERN.test(id) || firstName === null || lastName === null) return null;
  if (!firstName.trim() && !lastName.trim()) return null;
  return { id, firstName, lastName };
}

/** Lists the guards of this phone's site. On "not enrolled" the local enrolment is cleared. */
export async function fetchDeviceRoster(options: DeviceRequestOptions = {}): Promise<DeviceRosterResult> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const device = loadPatrolDevice(storage);
  if (!device) return { ok: false, error: 'not_enrolled' };
  if ((options.isOffline ?? defaultIsOffline)()) return { ok: false, error: 'offline' };

  const answer = await postJson(DEVICE_ROSTER_PATH, { deviceSecret: device.secret }, options);
  if (answer === 'offline' || answer === 'timeout') return { ok: false, error: answer };
  if (answer.status !== 200) {
    const error = refusal(answer);
    if (error === 'not_enrolled') clearPatrolDevice(storage);
    return { ok: false, error };
  }

  const body = (answer.body ?? {}) as Record<string, unknown>;
  const deviceInfo = (body.device ?? {}) as Record<string, unknown>;
  const siteInfo = (body.site ?? {}) as Record<string, unknown>;
  const deviceId = str(deviceInfo.id);
  const siteId = str(siteInfo.id);
  if (body.ok !== true || !deviceId || !siteId || !Array.isArray(body.guards)) return { ok: false, error: 'failed' };

  const guards = body.guards.map(parseGuard).filter((guard): guard is RosterGuard => guard !== null);
  const label = str(deviceInfo.label) ?? device.label;
  const siteName = str(siteInfo.name) ?? device.siteName;

  // Keep the phone's copy of the names current (e.g. a renamed site); the secret never changes.
  if (deviceId === device.deviceId && siteId === device.siteId && (label !== device.label || siteName !== device.siteName)) {
    savePatrolDevice({ ...device, label: label || device.label, siteName }, storage);
  }
  return { ok: true, device: { id: deviceId, label }, site: { id: siteId, name: siteName }, guards };
}

export interface GuardSignInOptions extends DeviceRequestOptions {
  /**
   * Runs after the server has agreed to sign the guard in and before the new session is stored
   * (verifyOtp). The login page waits here for an earlier sign-out that is still running and
   * notes the previous person's session (see ./handOver.ts). It must NOT sign anybody out: the
   * previous person is forgotten only after the new session exists.
   */
  beforeSession?: () => Promise<void>;
}

/**
 * Signs `guardId` (a guard picked from this phone's roster) in on this phone:
 * POST device-login with the device secret → token hash → verifyOtp. Sends no e-mail address.
 * Never signs anybody out (except a session that turned out to belong to someone else): the
 * new session simply replaces the stored one, so a refusal leaves the current person signed in.
 */
export async function signInGuardOnDevice(
  supabase: Pick<SupabaseClient, 'auth'>,
  guardId: string,
  options: GuardSignInOptions = {}
): Promise<GuardDeviceSignInResult> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const device = loadPatrolDevice(storage);
  if (!device) return { ok: false, error: 'not_enrolled' };
  if (typeof guardId !== 'string' || !UUID_PATTERN.test(guardId)) return { ok: false, error: 'failed' };
  if ((options.isOffline ?? defaultIsOffline)()) return { ok: false, error: 'offline' };

  const answer = await postJson(DEVICE_LOGIN_PATH, { deviceSecret: device.secret, guardId }, options);
  if (answer === 'offline' || answer === 'timeout') return { ok: false, error: answer };
  if (answer.status !== 200) {
    const error = refusal(answer);
    if (error === 'not_enrolled') clearPatrolDevice(storage);
    return { ok: false, error };
  }
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const tokenHash = str(body.tokenHash) ?? str(body.token_hash);
  if (body.ok !== true || !tokenHash) return { ok: false, error: 'failed' };

  if (options.beforeSession) {
    try {
      await options.beforeSession();
    } catch {
      return { ok: false, error: 'failed' };
    }
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    if (error) {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : undefined;
      // A 429 is the server answering "slow down", not a missing connection.
      return { ok: false, error: status !== 429 && isNetworkFailure(status, error) ? 'offline' : 'failed' };
    }
    const user = data?.user ?? data?.session?.user ?? null;
    if (!data?.session || !user) return { ok: false, error: 'failed' };
    if (user.id !== guardId) {
      // Never keep a session for somebody other than the guard who tapped their name.
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        // The session is dropped by the next sign-in on this phone at the latest.
      }
      return { ok: false, error: 'failed' };
    }
    setCurrentUserPointer(storage, user.id);
    // A patrol phone serves one site: open the guard app on it.
    writeActiveSiteId(storage, user.id, device.siteId);
    return { ok: true, userId: user.id };
  } catch (error) {
    return { ok: false, error: isNetworkFailure(undefined, error) ? 'offline' : 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Removing this phone's enrolment (revokes the server entry too)
// ---------------------------------------------------------------------------

export type RemoveEnrolmentResult = { revoked: true } | { revoked: false; error?: 'not_allowed' | 'offline' | 'failed' };

/**
 * "Remove enrolment from this phone": revokes this phone's server entry (needs a signed-in
 * manager of the site and a connection) and forgets the secret here. The local copy is cleared
 * even when the revocation fails - the result says so, and the entry must then be revoked from
 * the list.
 */
export async function removeThisPhoneEnrolment(
  supabase: RpcClient | null,
  storage: KeyValueStorage | null = browserStorage()
): Promise<RemoveEnrolmentResult> {
  const device = loadPatrolDevice(storage);
  if (!device) return { revoked: false };
  let result: RevokeResult = { ok: false, error: 'offline' };
  if (supabase) result = await revokePatrolDevice(supabase, device.deviceId, storage);
  clearPatrolDevice(storage);
  return result.ok ? { revoked: true } : { revoked: false, error: result.error };
}

// ---------------------------------------------------------------------------
// Short-lived notes for the next screen (sessionStorage: this tab only)
// ---------------------------------------------------------------------------

/** Set after a patrol-phone sign-in: the guard home shows "Signed in as <name> – not you?". */
export const DEVICE_SIGN_IN_NOTE_KEY = 'ee.patrolDevice.justSignedIn';
/** How long that check is offered after the tap. */
export const DEVICE_SIGN_IN_CHECK_MS = 60_000;
/** Set after enrolling this phone (the manager is signed out and lands on /login). */
export const ENROLLED_NOTE_KEY = 'ee.patrolDevice.enrolledNote';

function sessionStore(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function markDeviceSignIn(userId: string, now: number = Date.now(), storage: KeyValueStorage | null = sessionStore()): void {
  try {
    storage?.setItem(DEVICE_SIGN_IN_NOTE_KEY, JSON.stringify({ userId, at: now }));
  } catch {
    // Only a convenience: without it the guard home simply shows no check.
  }
}

/** True while `userId` signed in on this phone by tapping their name less than a minute ago. */
export function isFreshDeviceSignIn(userId: string | null, now: number = Date.now(), storage: KeyValueStorage | null = sessionStore()): boolean {
  if (!userId) return false;
  try {
    const raw = storage?.getItem(DEVICE_SIGN_IN_NOTE_KEY);
    if (!raw) return false;
    const note = JSON.parse(raw) as { userId?: unknown; at?: unknown };
    return note.userId === userId && typeof note.at === 'number' && now - note.at >= 0 && now - note.at < DEVICE_SIGN_IN_CHECK_MS;
  } catch {
    return false;
  }
}

export function clearDeviceSignIn(storage: KeyValueStorage | null = sessionStore()): void {
  try {
    storage?.removeItem(DEVICE_SIGN_IN_NOTE_KEY);
  } catch {
    // Nothing stored.
  }
}

export interface EnrolledNote {
  siteName: string;
  oldRevokeFailed: boolean;
}

export function saveEnrolledNote(note: EnrolledNote, storage: KeyValueStorage | null = sessionStore()): void {
  try {
    storage?.setItem(ENROLLED_NOTE_KEY, JSON.stringify(note));
  } catch {
    // The login page then shows no confirmation; the Guard duty tab still shows the site.
  }
}

/** Reads and removes the note (shown once). */
export function takeEnrolledNote(storage: KeyValueStorage | null = sessionStore()): EnrolledNote | null {
  try {
    const raw = storage?.getItem(ENROLLED_NOTE_KEY);
    if (!raw) return null;
    storage?.removeItem(ENROLLED_NOTE_KEY);
    const note = JSON.parse(raw) as Partial<EnrolledNote>;
    return typeof note.siteName === 'string' ? { siteName: note.siteName, oldRevokeFailed: note.oldRevokeFailed === true } : null;
  } catch {
    return null;
  }
}

/** Roles that must never stay signed in on a patrol phone (they sign in with a password). */
export const MANAGER_ROLES: readonly UserRole[] = ['admin', 'super_admin', 'supervisor'];

export function isManagerAccount(roles: readonly UserRole[]): boolean {
  return roles.some((role) => MANAGER_ROLES.includes(role));
}
