/**
 * Checkpoint data access: loading a site's checkpoints (Supabase with offline cache),
 * secure QR token generation, strict QR payload parsing and checkpoint resolution for
 * both scan methods.
 *
 * Security notes:
 * - QR text is matched ONLY against QR tokens / legacy codes, NFC serials ONLY against
 *   enrolled UIDs (a QR that encodes a UID is not a valid scan).
 * - Payloads are parsed as a whole string: a URL that merely contains a token is rejected.
 * - The printed token and the NFC serial are secrets the database hides from every role
 *   except org admins. The app matches scans against their SHA-256 fingerprints
 *   (qr_token_sha256 / nfc_uid_sha256); admins read the raw values with
 *   fetchCheckpointSecrets(), which the server audits.
 * - Server-side (RLS + patrol_scans trigger) remains the authority; this module only
 *   resolves which checkpoint the guard is standing at.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Checkpoint, CheckpointPayloadType } from '@/types/models';
import { normalizeNfcSerial } from '@/lib/nfc/webNfc';
import { sha256 } from '@/lib/utils/hash';

export const CHECKPOINT_TOKEN_PREFIX = 'EE-CP-';
/** New tokens: 16 random bytes → 32 upper-case hex characters (128 bits). */
const TOKEN_RANDOM_BYTES = 16;
/** Accepted token body: new 32-hex tokens and older/seeded tokens such as EE-CP-MAIN-GATE-01. */
const SECURE_TOKEN_PATTERN = /^EE-CP-[A-Z0-9-]{6,64}$/;
/** Dawie's printed cards encode 'PLAAS-CP:<id>' where id is e.g. CP1…CP6. */
const LEGACY_PREFIX = 'PLAAS-CP:';
const LEGACY_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Anything longer than this cannot be one of our payloads (keeps parsing cheap). */
const MAX_PAYLOAD_LENGTH = 256;
/**
 * Upper bound for the checkpoint query. On a connected-but-dead rural link (one bar, captive
 * portal) navigator.onLine stays true and fetch has no timeout of its own, so without a bound
 * the patrol screen would wait minutes before falling back to the cached list.
 */
export const CHECKPOINT_LOAD_TIMEOUT_MS = 8000;

export type CheckpointPayload =
  | { kind: 'secure_token'; token: string }
  | { kind: 'legacy_qr'; code: string }
  | { kind: 'unknown'; raw: string };

export type ResolveCheckpointInput = { method: 'qr' | 'nfc'; raw: string };

export interface ResolveCheckpointOptions {
  /**
   * The site's allow_legacy_qr setting (Site.allowLegacyQr). false refuses Dawie's printed
   * PLAAS-CP cards with reason 'legacy_disabled'. Default true (accepted, but the server never
   * marks such scans as verified).
   */
  allowLegacyQr?: boolean;
}

export type ResolveCheckpointResult =
  | { ok: true; checkpoint: Checkpoint; payloadType: CheckpointPayloadType }
  | { ok: false; reason: 'inactive'; checkpoint: Checkpoint }
  | { ok: false; reason: 'unknown_tag' | 'unknown_qr' | 'legacy_disabled' };

type RandomFill = (bytes: Uint8Array) => Uint8Array;

function defaultRandomFill(bytes: Uint8Array): Uint8Array {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    // Never fall back to Math.random for a bearer secret.
    throw new Error('crypto.getRandomValues is unavailable; cannot generate a secure checkpoint token.');
  }
  return cryptoObj.getRandomValues(bytes);
}

/**
 * Generates a new checkpoint QR token: 'EE-CP-' + 32 upper-case hex characters
 * (128 bits from crypto.getRandomValues). `randomFill` is injectable for tests only.
 */
export function generateCheckpointToken(randomFill: RandomFill = defaultRandomFill): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES);
  const filled = randomFill(bytes);
  if (!(filled instanceof Uint8Array) || filled.length !== TOKEN_RANDOM_BYTES) {
    throw new Error('Random source returned an unexpected buffer.');
  }
  let hex = '';
  for (const byte of filled) hex += byte.toString(16).padStart(2, '0');
  return CHECKPOINT_TOKEN_PREFIX + hex.toUpperCase();
}

/**
 * Parses scanned QR text strictly. Only the whole (trimmed) string is considered:
 * - 'EE-CP-' + 6..64 of [A-Z0-9-]  → secure_token (new tokens are 32 hex; seeded tokens are accepted)
 * - 'PLAAS-CP:<code>'              → legacy_qr (Dawie's original printed cards)
 * - anything else                  → unknown
 * Token matching is case-sensitive: tokens are generated and printed in upper case.
 */
export function parseCheckpointPayload(text: string): CheckpointPayload {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAYLOAD_LENGTH) return { kind: 'unknown', raw };

  if (SECURE_TOKEN_PATTERN.test(trimmed)) return { kind: 'secure_token', token: trimmed };

  if (trimmed.startsWith(LEGACY_PREFIX)) {
    const code = trimmed.slice(LEGACY_PREFIX.length).trim();
    if (LEGACY_CODE_PATTERN.test(code)) return { kind: 'legacy_qr', code };
  }
  return { kind: 'unknown', raw };
}

/** Prefers an active match; returns an inactive one only when no active checkpoint matches. */
function pickMatch(matches: Checkpoint[]): Checkpoint | null {
  if (matches.length === 0) return null;
  return matches.find((cp) => cp.isActive) ?? matches[0];
}

/**
 * Fingerprint of an NFC serial as stored in checkpoints.nfc_uid_sha256 (SHA-256 of the
 * normalised serial), or null when the serial cannot be a real ISO 14443-A UID.
 */
export async function nfcSerialFingerprint(serial: string | null | undefined): Promise<string | null> {
  const normalised = normalizeNfcSerial(serial);
  return normalised ? sha256(normalised) : null;
}

/** Fingerprint of a printed QR token as stored in checkpoints.qr_token_sha256. */
export function qrTokenFingerprint(token: string): Promise<string> {
  return sha256(token);
}

/**
 * Resolves a scan to one of the given checkpoints (normally the guard's site list).
 * - nfc: SHA-256 of the normalised serial equals the checkpoint's nfcUidSha256
 * - qr:  SHA-256 of the secure token equals qrTokenSha256; a legacy code equals legacyCode
 *        (case-insensitive) unless options.allowLegacyQr is false
 * Inactive checkpoints resolve to { ok: false, reason: 'inactive' } so the UI can say so.
 * Needs Web Crypto (https or localhost), like the rest of the evidence chain.
 */
export async function resolveCheckpoint(
  input: ResolveCheckpointInput,
  checkpoints: ReadonlyArray<Checkpoint>,
  options: ResolveCheckpointOptions = {}
): Promise<ResolveCheckpointResult> {
  if (input.method === 'nfc') {
    const fingerprint = await nfcSerialFingerprint(input.raw);
    if (!fingerprint) return { ok: false, reason: 'unknown_tag' };
    const match = pickMatch(checkpoints.filter((cp) => cp.nfcUidSha256 === fingerprint));
    if (!match) return { ok: false, reason: 'unknown_tag' };
    if (!match.isActive) return { ok: false, reason: 'inactive', checkpoint: match };
    return { ok: true, checkpoint: match, payloadType: 'nfc_uid' };
  }

  const payload = parseCheckpointPayload(input.raw);
  let match: Checkpoint | null = null;
  let payloadType: CheckpointPayloadType;
  if (payload.kind === 'secure_token') {
    const fingerprint = await qrTokenFingerprint(payload.token);
    match = pickMatch(checkpoints.filter((cp) => cp.qrTokenSha256 === fingerprint));
    payloadType = 'secure_token';
  } else if (payload.kind === 'legacy_qr') {
    if (options.allowLegacyQr === false) return { ok: false, reason: 'legacy_disabled' };
    const code = payload.code.toLowerCase();
    match = pickMatch(
      checkpoints.filter((cp) => typeof cp.legacyCode === 'string' && cp.legacyCode.trim().toLowerCase() === code)
    );
    payloadType = 'legacy_qr';
  } else {
    return { ok: false, reason: 'unknown_qr' };
  }

  if (!match) return { ok: false, reason: 'unknown_qr' };
  if (!match.isActive) return { ok: false, reason: 'inactive', checkpoint: match };
  return { ok: true, checkpoint: match, payloadType };
}

// ---------------------------------------------------------------------------
// Loading (Supabase + offline cache)
// ---------------------------------------------------------------------------

/**
 * Explicit column list (never select '*': qr_code_hash and nfc_uid are not readable by any
 * signed-in role, and a query naming them fails with 42501). Use the same list after an
 * admin insert / update (`.select(CHECKPOINT_COLUMNS)`), or return=minimal.
 */
export const CHECKPOINT_COLUMNS =
  'id, site_id, name, description, qr_token_sha256, qr_token_strong, nfc_uid_sha256, latitude, longitude, permitted_radius_meters, order_index, is_active, deactivated_at, legacy_code, organisation_id, nfc_enrolled_at, nfc_enrolled_by';

export interface CheckpointRow {
  id: string;
  site_id: string;
  name: string;
  description: string | null;
  qr_token_sha256: string | null;
  qr_token_strong: boolean | null;
  nfc_uid_sha256: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  permitted_radius_meters: number | string | null;
  order_index: number | string | null;
  is_active: boolean | null;
  deactivated_at: string | null;
  legacy_code: string | null;
  organisation_id: string | null;
  nfc_enrolled_at: string | null;
  nfc_enrolled_by: string | null;
}

/**
 * Shape of the Dexie `checkpointCache` table (primary key `siteId`):
 *   { siteId: string; checkpoints: Checkpoint[]; cachedAt: string } where cachedAt is ISO-8601.
 * A Dexie Table<CheckpointCacheRecord, string> satisfies CheckpointCacheStore.
 */
export interface CheckpointCacheRecord {
  siteId: string;
  checkpoints: Checkpoint[];
  cachedAt: string;
}

export interface CheckpointCacheStore {
  get(siteId: string): PromiseLike<CheckpointCacheRecord | undefined>;
  put(record: CheckpointCacheRecord): PromiseLike<unknown>;
}

export interface LoadCheckpointsDeps {
  /** The offline cache table (offlineDB.checkpointCache). null disables caching (e.g. during SSR). */
  cache: CheckpointCacheStore | null;
  /** Supabase client; defaults to the app's browser client. */
  supabase?: Pick<SupabaseClient, 'from'>;
  /** Defaults to navigator.onLine (true when unknown). */
  isOnline?: () => boolean;
  now?: () => Date;
  /** Network attempt bound (default CHECKPOINT_LOAD_TIMEOUT_MS); on expiry the cache is used. */
  timeoutMs?: number;
}

export interface LoadCheckpointsResult {
  checkpoints: Checkpoint[];
  source: 'network' | 'cache';
  /** When the returned list was fetched from the server (ISO). */
  cachedAt: string;
  /** Set when the network was tried and failed, and the cache was used instead. */
  networkError?: string;
}

export class CheckpointLoadError extends Error {
  readonly reason: 'offline_no_cache' | 'network_error_no_cache';
  constructor(reason: 'offline_no_cache' | 'network_error_no_cache', message: string) {
    super(message);
    this.name = 'CheckpointLoadError';
    this.reason = reason;
  }
}

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Maps a checkpoints row to the client model. */
export function mapCheckpointRow(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    description: row.description ?? undefined,
    qrTokenSha256: row.qr_token_sha256 ?? undefined,
    qrTokenStrong: typeof row.qr_token_strong === 'boolean' ? row.qr_token_strong : undefined,
    nfcUidSha256: row.nfc_uid_sha256 ?? undefined,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    permittedRadiusMeters: toNumber(row.permitted_radius_meters) ?? 50,
    orderIndex: toNumber(row.order_index) ?? 0,
    isActive: row.is_active !== false,
    deactivatedAt: row.deactivated_at ?? undefined,
    organisationId: row.organisation_id ?? undefined,
    legacyCode: row.legacy_code ?? undefined,
    nfcEnrolledAt: row.nfc_enrolled_at ?? undefined,
    nfcEnrolledBy: row.nfc_enrolled_by ?? undefined
  };
}

function defaultIsOnline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true;
  return navigator.onLine;
}

async function defaultSupabase(): Promise<Pick<SupabaseClient, 'from'>> {
  const mod = await import('@/lib/supabase/client');
  return mod.createClient();
}

async function readCache(cache: CheckpointCacheStore | null, siteId: string): Promise<CheckpointCacheRecord | null> {
  if (!cache) return null;
  try {
    const record = await cache.get(siteId);
    return record && Array.isArray(record.checkpoints) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Loads all checkpoints of a site (active and inactive; RLS limits rows to sites the caller
 * may see), ordered by order_index. Online: queries Supabase and refreshes the cache.
 * Offline, on a network/Supabase error, or when the query does not answer within timeoutMs
 * (the request is aborted): falls back to the cached list.
 * Throws CheckpointLoadError when neither is available (the UI must say so; never fake data).
 */
export async function loadCheckpoints(siteId: string, deps: LoadCheckpointsDeps): Promise<LoadCheckpointsResult> {
  if (!siteId) throw new Error('loadCheckpoints: siteId is required');
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const now = deps.now ?? (() => new Date());

  if (!isOnline()) {
    const cached = await readCache(deps.cache, siteId);
    if (cached) return { checkpoints: cached.checkpoints, source: 'cache', cachedAt: cached.cachedAt };
    throw new CheckpointLoadError(
      'offline_no_cache',
      'Offline and this site’s checkpoints have not been downloaded to this phone yet. Connect once to download them.'
    );
  }

  const timeoutMs = deps.timeoutMs ?? CHECKPOINT_LOAD_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejects on expiry even if the transport ignores the abort signal.
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Checkpoint download timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  expiry.catch(() => undefined); // handled through Promise.race below

  let networkError: string;
  try {
    const client = deps.supabase ?? (await Promise.race([defaultSupabase(), expiry]));
    const query = client
      .from('checkpoints')
      .select(CHECKPOINT_COLUMNS)
      .eq('site_id', siteId)
      .order('order_index', { ascending: true })
      .abortSignal(controller.signal);
    const { data, error } = await Promise.race([query, expiry]);
    if (error) throw new Error(error.message || 'Supabase query failed');
    const rows = (data ?? []) as unknown as CheckpointRow[];
    const checkpoints = rows.map(mapCheckpointRow);
    const cachedAt = now().toISOString();
    if (deps.cache) {
      try {
        await deps.cache.put({ siteId, checkpoints, cachedAt });
      } catch {
        // Quota/IndexedDB failure must not hide fresh server data.
      }
    }
    return { checkpoints, source: 'network', cachedAt };
  } catch (error) {
    networkError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const cached = await readCache(deps.cache, siteId);
  if (cached) return { checkpoints: cached.checkpoints, source: 'cache', cachedAt: cached.cachedAt, networkError };
  throw new CheckpointLoadError('network_error_no_cache', `Could not load checkpoints: ${networkError}`);
}

// ---------------------------------------------------------------------------
// Admin: raw secrets and write errors
// ---------------------------------------------------------------------------

/** Raw QR token and enrolled NFC serial of one checkpoint (org admins only). */
export interface CheckpointSecret {
  checkpointId: string;
  siteId: string;
  /** The text to print in the QR card (EE-CP-…). */
  qrToken: string;
  /** Normalised serial ('04:a2:3b:…') or null when no tag is enrolled. */
  nfcUid: string | null;
}

interface CheckpointSecretRow {
  checkpoint_id: string;
  site_id: string;
  qr_token: string;
  nfc_uid: string | null;
}

export class CheckpointSecretsError extends Error {
  /** SQLSTATE / PostgREST code ('42501' = caller is not an org admin of that site's organisation). */
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = 'CheckpointSecretsError';
    this.code = code;
  }
}

/**
 * Raw QR tokens and NFC serials for printing / reprinting cards and showing which tag is
 * enrolled, via the get_checkpoint_secrets() RPC. Only org admins may call it (42501
 * otherwise) and the server writes an audit entry for every call, so call it on an explicit
 * admin action ("Print QR cards", "Show tag serial"), never on page load or for guards.
 * `siteId` null = every site of the admin's organisation.
 */
export async function fetchCheckpointSecrets(
  siteId: string | null,
  deps: { supabase?: Pick<SupabaseClient, 'rpc'> } = {}
): Promise<CheckpointSecret[]> {
  const client = deps.supabase ?? (await import('@/lib/supabase/client')).createClient();
  const { data, error } = await client.rpc('get_checkpoint_secrets', { p_site_id: siteId });
  if (error) {
    const code = typeof error.code === 'string' ? error.code : undefined;
    throw new CheckpointSecretsError(error.message || 'Could not load checkpoint secrets', code);
  }
  return ((data ?? []) as CheckpointSecretRow[]).map((row) => ({
    checkpointId: row.checkpoint_id,
    siteId: row.site_id,
    qrToken: row.qr_token,
    nfcUid: row.nfc_uid
  }));
}

export type CheckpointWriteProblem =
  | 'duplicate_tag'
  | 'duplicate_legacy_code'
  | 'invalid_tag_serial'
  | 'invalid_token'
  | 'in_use'
  | 'not_allowed'
  | 'error';

const WRITE_PROBLEM_MESSAGES: Record<CheckpointWriteProblem, string> = {
  duplicate_tag: 'This NFC tag is already linked to another checkpoint.',
  duplicate_legacy_code: 'Another checkpoint on this site already uses this card code.',
  invalid_tag_serial: 'Not a valid tag serial (expected 4 to 10 hexadecimal bytes).',
  invalid_token: 'Invalid QR token: create tokens with generateCheckpointToken().',
  in_use: 'This checkpoint has patrol history and cannot be deleted. Deactivate it instead.',
  not_allowed: 'Only an organisation admin can change checkpoints.',
  error: 'The checkpoint could not be saved.'
};

/**
 * Maps an error from an admin insert / update / delete on `checkpoints` to what the admin
 * should be told. The database enforces every rule (unique tag per organisation, serial
 * format, token format, no deleting checkpoints with scans, admins only).
 */
export function classifyCheckpointWriteError(
  error: { code?: unknown; message?: unknown } | null | undefined
): { problem: CheckpointWriteProblem; message: string } {
  const code = typeof error?.code === 'string' ? error.code : '';
  const text = typeof error?.message === 'string' ? error.message : '';
  let problem: CheckpointWriteProblem = 'error';
  if (code === '23505') problem = /legacy_code/i.test(text) ? 'duplicate_legacy_code' : 'duplicate_tag';
  else if (code === '22023') problem = /token/i.test(text) ? 'invalid_token' : 'invalid_tag_serial';
  // ON DELETE RESTRICT from patrol_scans (23001; 23503 on servers that report it as a plain FK violation).
  else if (code === '23001' || (code === '23503' && /update or delete on table/i.test(text))) problem = 'in_use';
  else if (code === '42501') problem = 'not_allowed';
  const message = problem === 'error' && text ? `${WRITE_PROBLEM_MESSAGES.error} ${text}` : WRITE_PROBLEM_MESSAGES[problem];
  return { problem, message };
}
