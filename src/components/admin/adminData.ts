/**
 * Admin console data access (sites, checkpoints, NFC enrolment, staff, audit log).
 *
 * Every function talks to Supabase AS THE SIGNED-IN ADMIN: Row Level Security, column privileges
 * and triggers in the database decide what is allowed. Rules followed here:
 * - Explicit column lists only (never `select('*')`; checkpoint secrets are not selectable).
 * - Every write asks the database to return the row it stored (`.select(...)`) and the result is
 *   built from that row, so the UI only ever shows what the server confirmed. An RLS-filtered
 *   UPDATE/DELETE returns zero rows without an error; that is reported as a failure.
 * - Raw QR tokens and NFC serials are read only through the audited get_checkpoint_secrets RPC
 *   (fetchCheckpointSecrets), on an explicit admin action.
 * - Nothing is invented: no fallback values, no generated serials.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Checkpoint, Site, SupportedLanguage, UserRole } from '@/types/models';
import {
  CHECKPOINT_COLUMNS,
  classifyCheckpointWriteError,
  fetchCheckpointSecrets,
  generateCheckpointToken,
  mapCheckpointRow,
  nfcSerialFingerprint,
  type CheckpointRow,
  type CheckpointSecret,
  type CheckpointWriteProblem
} from '@/lib/data/checkpoints';
import { SITE_COLUMNS, mapSiteRow, type SiteRow } from '@/lib/auth/identity';
import { isUserRole } from '@/lib/auth/routeAccess';
import { normalizeNfcSerial } from '@/lib/nfc/webNfc';

/** The subset of the Supabase client used here (the PGlite test adapter implements it too). */
export type AdminDb = Pick<SupabaseClient, 'from' | 'rpc'>;

export type AdminErrorKind =
  | 'not_allowed'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'in_use'
  | 'network'
  | 'not_confirmed'
  | 'error';

export interface AdminError {
  kind: AdminErrorKind;
  /** SQLSTATE / PostgREST code when the server answered. */
  code?: string;
  /** Server / library message (technical detail for the admin; not translated). */
  message: string;
  /** Checkpoint-specific classification (classifyCheckpointWriteError). */
  problem?: CheckpointWriteProblem;
}

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: AdminError };

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

const NETWORK_PATTERN = /fetch failed|failed to fetch|networkerror|network request failed|load failed|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i;

/** Maps a PostgREST / fetch error to what the admin should be told. */
export function toAdminError(error: unknown): AdminError {
  const e = (error ?? {}) as PgErrorLike;
  const code = typeof e.code === 'string' && e.code !== '' ? e.code : undefined;
  const message =
    typeof e.message === 'string' && e.message !== '' ? e.message : error instanceof Error ? error.message : String(error);
  let kind: AdminErrorKind = 'error';
  if (!code && (error instanceof TypeError || NETWORK_PATTERN.test(message))) kind = 'network';
  else if (code === '42501') kind = 'not_allowed';
  else if (code === 'PGRST116') kind = 'not_found';
  else if (code === '23505') kind = 'conflict';
  else if (code === '23001' || (code === '23503' && /update or delete on table/i.test(message))) kind = 'in_use';
  else if (code === '22023' || code === '23514' || code === '22P02' || code === '22001' || code === '23502' || code === '22007') {
    kind = 'invalid';
  }
  return code ? { kind, code, message } : { kind, message };
}

function fail<T>(error: unknown): AdminResult<T> {
  return { ok: false, error: toAdminError(error) };
}

function checkpointFail<T>(error: unknown): AdminResult<T> {
  const base = toAdminError(error);
  const { problem } = classifyCheckpointWriteError(error as PgErrorLike);
  return { ok: false, error: { ...base, problem } };
}

async function run<T>(fn: () => Promise<AdminResult<T>>): Promise<AdminResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** Values written to a site row. Times are 'HH:MM' (SAST); phone numbers already validated. */
export interface SiteSettingsInput {
  name: string;
  code: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  defaultRadiusMeters: number;
  dayShiftStart: string;
  dayShiftEnd: string;
  nightShiftStart: string;
  nightShiftEnd: string;
  roundIntervalMinutes: number;
  emergencyPhone: string | null;
  policePhone: string | null;
  /** E.164 ('+27…') from normalizeSouthAfricanMobile, or null when not configured. */
  whatsappDispatchNumber: string | null;
  allowLegacyQr: boolean;
  isActive: boolean;
}

function siteRowFromInput(input: SiteSettingsInput): Record<string, unknown> {
  return {
    name: input.name,
    code: input.code,
    address: input.address,
    latitude: input.latitude,
    longitude: input.longitude,
    default_radius_meters: input.defaultRadiusMeters,
    day_shift_start: input.dayShiftStart,
    day_shift_end: input.dayShiftEnd,
    night_shift_start: input.nightShiftStart,
    night_shift_end: input.nightShiftEnd,
    round_interval_minutes: input.roundIntervalMinutes,
    emergency_phone: input.emergencyPhone,
    police_phone: input.policePhone,
    whatsapp_dispatch_number: input.whatsappDispatchNumber,
    allow_legacy_qr: input.allowLegacyQr,
    is_active: input.isActive
  };
}

/** Every site of the admin's organisation (RLS), by name. */
export async function loadOrgSites(db: AdminDb): Promise<AdminResult<Site[]>> {
  return run(async () => {
    const { data, error } = await db.from('sites').select(SITE_COLUMNS).order('name', { ascending: true });
    if (error) return fail(error);
    return { ok: true, value: ((data ?? []) as unknown as SiteRow[]).map(mapSiteRow) };
  });
}

/**
 * Creates a site in the admin's organisation. `organisationId` must be the admin's own
 * profile.organisationId; the database refuses any other organisation.
 * Phone numbers start empty ("not configured") on purpose: the old schema default for
 * police_phone would otherwise appear on guard phones without anyone having entered it.
 * Shift times, round interval and radius take the database defaults and are shown for review.
 */
export async function createSite(
  db: AdminDb,
  organisationId: string,
  input: { name: string; code: string }
): Promise<AdminResult<Site>> {
  return run(async () => {
    const { data, error } = await db
      .from('sites')
      .insert({
        organisation_id: organisationId,
        name: input.name,
        code: input.code,
        police_phone: null,
        emergency_phone: null,
        whatsapp_dispatch_number: null
      })
      .select(SITE_COLUMNS)
      .single();
    if (error) return fail(error);
    return { ok: true, value: mapSiteRow(data as unknown as SiteRow) };
  });
}

/** Saves a site's settings and returns the row as the database stored it. */
export async function updateSite(db: AdminDb, siteId: string, input: SiteSettingsInput): Promise<AdminResult<Site>> {
  return run(async () => {
    const { data, error } = await db
      .from('sites')
      .update(siteRowFromInput(input))
      .eq('id', siteId)
      .select(SITE_COLUMNS)
      .single();
    if (error) return fail(error);
    return { ok: true, value: mapSiteRow(data as unknown as SiteRow) };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointInput {
  name: string;
  description: string | null;
  permittedRadiusMeters: number;
  orderIndex: number;
  legacyCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

function checkpointRowFromInput(input: CheckpointInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    permitted_radius_meters: input.permittedRadiusMeters,
    order_index: input.orderIndex,
    legacy_code: input.legacyCode,
    latitude: input.latitude,
    longitude: input.longitude
  };
}

function singleCheckpoint(data: unknown): Checkpoint {
  return mapCheckpointRow(data as CheckpointRow);
}

/** All checkpoints of one site (active and inactive), in patrol order. No offline cache. */
export async function loadSiteCheckpoints(db: AdminDb, siteId: string): Promise<AdminResult<Checkpoint[]>> {
  return run(async () => {
    const { data, error } = await db
      .from('checkpoints')
      .select(CHECKPOINT_COLUMNS)
      .eq('site_id', siteId)
      .order('order_index', { ascending: true });
    if (error) return fail(error);
    return { ok: true, value: ((data ?? []) as unknown as CheckpointRow[]).map(mapCheckpointRow) };
  });
}

/** Creates a checkpoint with a new 128-bit QR token (generateCheckpointToken). */
export async function createCheckpoint(
  db: AdminDb,
  siteId: string,
  input: CheckpointInput
): Promise<AdminResult<Checkpoint>> {
  return run(async () => {
    const { data, error } = await db
      .from('checkpoints')
      .insert({
        site_id: siteId,
        ...checkpointRowFromInput(input),
        qr_code_hash: generateCheckpointToken(),
        is_active: true
      })
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) return checkpointFail(error);
    return { ok: true, value: singleCheckpoint(data) };
  });
}

export async function updateCheckpoint(
  db: AdminDb,
  checkpointId: string,
  input: CheckpointInput
): Promise<AdminResult<Checkpoint>> {
  return run(async () => {
    const { data, error } = await db
      .from('checkpoints')
      .update(checkpointRowFromInput(input))
      .eq('id', checkpointId)
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) return checkpointFail(error);
    return { ok: true, value: singleCheckpoint(data) };
  });
}

export async function setCheckpointActive(
  db: AdminDb,
  checkpointId: string,
  active: boolean
): Promise<AdminResult<Checkpoint>> {
  return run(async () => {
    const { data, error } = await db
      .from('checkpoints')
      .update({ is_active: active })
      .eq('id', checkpointId)
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) return checkpointFail(error);
    const checkpoint = singleCheckpoint(data);
    if (checkpoint.isActive !== active) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the change.' } };
    }
    return { ok: true, value: checkpoint };
  });
}

/**
 * Deletes a checkpoint. The database refuses when patrol scans reference it (23001 'in_use');
 * the caller should then offer deactivation instead.
 */
export async function deleteCheckpoint(db: AdminDb, checkpointId: string): Promise<AdminResult<{ id: string }>> {
  return run(async () => {
    const { data, error } = await db.from('checkpoints').delete().eq('id', checkpointId).select('id');
    if (error) return checkpointFail(error);
    const rows = (data ?? []) as Array<{ id: string }>;
    if (rows.length !== 1) {
      return { ok: false, error: { kind: 'not_found', message: 'No checkpoint was deleted (not found or not allowed).' } };
    }
    return { ok: true, value: { id: rows[0].id } };
  });
}

/**
 * Replaces the checkpoint's QR token with a new random one. The old printed card stops
 * resolving immediately; the admin must print and post the new card.
 */
export async function rotateCheckpointToken(db: AdminDb, checkpointId: string): Promise<AdminResult<Checkpoint>> {
  return run(async () => {
    const before = await db.from('checkpoints').select('id, qr_token_sha256').eq('id', checkpointId).maybeSingle();
    if (before.error) return checkpointFail(before.error);
    if (!before.data) return { ok: false, error: { kind: 'not_found', message: 'Checkpoint not found.' } };
    const oldFingerprint = (before.data as { qr_token_sha256: string | null }).qr_token_sha256;
    const { data, error } = await db
      .from('checkpoints')
      .update({ qr_code_hash: generateCheckpointToken() })
      .eq('id', checkpointId)
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) return checkpointFail(error);
    const checkpoint = singleCheckpoint(data);
    if (!checkpoint.qrTokenSha256 || checkpoint.qrTokenSha256 === oldFingerprint) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the new token.' } };
    }
    return { ok: true, value: checkpoint };
  });
}

/** Raw tokens / serials for printing (audited server-side as checkpoint.secrets_viewed). */
export async function loadCheckpointSecrets(db: AdminDb, siteId: string): Promise<AdminResult<CheckpointSecret[]>> {
  return run(async () => {
    try {
      return { ok: true, value: await fetchCheckpointSecrets(siteId, { supabase: db }) };
    } catch (error) {
      return fail(error);
    }
  });
}

// ---------------------------------------------------------------------------
// NFC tags
// ---------------------------------------------------------------------------

/** A checkpoint that holds a given tag (looked up by the serial's SHA-256 fingerprint). */
export interface TagHolder {
  id: string;
  siteId: string;
  name: string;
  isActive: boolean;
}

/**
 * Which checkpoint(s) of the admin's organisation the tag is registered to. Read-only; the raw
 * serial never leaves the device (only its fingerprint is compared).
 */
export async function findCheckpointsByTag(db: AdminDb, serial: string): Promise<AdminResult<TagHolder[]>> {
  return run(async () => {
    const fingerprint = await nfcSerialFingerprint(serial);
    if (!fingerprint) {
      return { ok: false, error: { kind: 'invalid', message: 'Not a valid tag serial (expected 4 to 10 bytes).' } };
    }
    const { data, error } = await db
      .from('checkpoints')
      .select('id, site_id, name, is_active')
      .eq('nfc_uid_sha256', fingerprint);
    if (error) return fail(error);
    const rows = (data ?? []) as Array<{ id: string; site_id: string; name: string; is_active: boolean | null }>;
    return {
      ok: true,
      value: rows.map((row) => ({ id: row.id, siteId: row.site_id, name: row.name, isActive: row.is_active !== false }))
    };
  });
}

export interface TagEnrolment {
  checkpoint: Checkpoint;
  /** The normalised serial that the database now holds for this checkpoint. */
  serial: string;
  /** Server enrolment time (nfc_enrolled_at), read back from the database. */
  enrolledAt: string;
}

export type EnrolTagResult =
  | { ok: true; value: TagEnrolment }
  | { ok: false; error: AdminError; holders?: TagHolder[] };

/**
 * Registers a tag serial (exactly as read by Web NFC) on a checkpoint. Success only when the row
 * returned by the database carries this serial's fingerprint and a server enrolment time.
 * A tag already registered elsewhere in the organisation fails with problem 'duplicate_tag'
 * and the checkpoint(s) holding it.
 */
export async function enrolNfcTag(db: AdminDb, checkpointId: string, serialRead: string): Promise<EnrolTagResult> {
  try {
    const serial = normalizeNfcSerial(serialRead);
    if (!serial) {
      return {
        ok: false,
        error: { kind: 'invalid', problem: 'invalid_tag_serial', message: 'Not a valid tag serial (expected 4 to 10 bytes).' }
      };
    }
    const fingerprint = await nfcSerialFingerprint(serial);
    const { data, error } = await db
      .from('checkpoints')
      .update({ nfc_uid: serial })
      .eq('id', checkpointId)
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) {
      const failure = checkpointFail<TagEnrolment>(error);
      if (failure.ok) return failure;
      if (failure.error.problem === 'duplicate_tag' && failure.error.kind === 'conflict') {
        const holders = await findCheckpointsByTag(db, serial);
        return {
          ok: false,
          error: failure.error,
          holders: holders.ok ? holders.value.filter((holder) => holder.id !== checkpointId) : undefined
        };
      }
      return failure;
    }
    const checkpoint = singleCheckpoint(data);
    if (!fingerprint || checkpoint.nfcUidSha256 !== fingerprint || !checkpoint.nfcEnrolledAt) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the tag registration.' } };
    }
    return { ok: true, value: { checkpoint, serial, enrolledAt: checkpoint.nfcEnrolledAt } };
  } catch (error) {
    return fail(error);
  }
}

/** Revokes the tag of a checkpoint (the physical tag no longer resolves anywhere). */
export async function removeNfcTag(db: AdminDb, checkpointId: string): Promise<AdminResult<Checkpoint>> {
  return run(async () => {
    const { data, error } = await db
      .from('checkpoints')
      .update({ nfc_uid: null })
      .eq('id', checkpointId)
      .select(CHECKPOINT_COLUMNS)
      .single();
    if (error) return checkpointFail(error);
    const checkpoint = singleCheckpoint(data);
    if (checkpoint.nfcUidSha256) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server still reports a tag on this checkpoint.' } };
    }
    return { ok: true, value: checkpoint };
  });
}

export type MoveTagResult =
  | { ok: true; value: TagEnrolment; released?: Checkpoint }
  | { ok: false; error: AdminError; stage: 'release' | 'enrol'; released?: Checkpoint };

/**
 * Moves a tag from the checkpoint(s) currently holding it to `toCheckpointId`: first clears it
 * from each holder (so the unique index allows the move), then registers it here. When the
 * second step fails the result says so (stage 'enrol', released set): the tag is then on no
 * checkpoint, which is what the database holds.
 */
export async function moveNfcTag(
  db: AdminDb,
  holderIds: readonly string[],
  toCheckpointId: string,
  serialRead: string
): Promise<MoveTagResult> {
  let released: Checkpoint | undefined;
  for (const holderId of holderIds) {
    if (holderId === toCheckpointId) continue;
    const removed = await removeNfcTag(db, holderId);
    if (!removed.ok) return { ok: false, error: removed.error, stage: 'release', released };
    released = removed.value;
  }
  const enrolled = await enrolNfcTag(db, toCheckpointId, serialRead);
  if (!enrolled.ok) return { ok: false, error: enrolled.error, stage: 'enrol', released };
  return { ok: true, value: enrolled.value, released };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const STAFF_PROFILE_COLUMNS =
  'id, organisation_id, first_name, last_name, employee_number, phone_number, preferred_language, is_active, created_at';

interface StaffProfileRow {
  id: string;
  organisation_id: string;
  first_name: string;
  last_name: string;
  employee_number: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  is_active: boolean;
  created_at: string | null;
}

export interface StaffMember {
  id: string;
  organisationId: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string;
  phoneNumber?: string;
  preferredLanguage: SupportedLanguage;
  isActive: boolean;
  createdAt?: string;
  roles: UserRole[];
  siteIds: string[];
}

const ROLE_ORDER: readonly UserRole[] = ['super_admin', 'admin', 'supervisor', 'guard', 'client_viewer'];

function sortRoles(roles: UserRole[]): UserRole[] {
  return [...new Set(roles)].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
}

function toLanguage(value: string | null): SupportedLanguage {
  return value === 'af' || value === 'zu' ? value : 'en';
}

function assembleStaff(
  profiles: StaffProfileRow[],
  roles: Array<{ user_id: string; role: string }>,
  assignments: Array<{ user_id: string; site_id: string }>
): StaffMember[] {
  return profiles.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    firstName: row.first_name,
    lastName: row.last_name,
    employeeNumber: row.employee_number ?? undefined,
    phoneNumber: row.phone_number ?? undefined,
    preferredLanguage: toLanguage(row.preferred_language),
    isActive: row.is_active === true,
    createdAt: row.created_at ?? undefined,
    roles: sortRoles(roles.filter((r) => r.user_id === row.id).map((r) => r.role).filter(isUserRole)),
    siteIds: assignments.filter((a) => a.user_id === row.id).map((a) => a.site_id)
  }));
}

/** Everyone in the admin's organisation with their roles and site assignments. */
export async function loadStaff(db: AdminDb): Promise<AdminResult<StaffMember[]>> {
  return run(async () => {
    const [profiles, roles, assignments] = await Promise.all([
      db.from('profiles').select(STAFF_PROFILE_COLUMNS).order('last_name', { ascending: true }).order('first_name', { ascending: true }),
      db.from('user_roles').select('user_id, role'),
      db.from('site_assignments').select('user_id, site_id')
    ]);
    if (profiles.error) return fail(profiles.error);
    if (roles.error) return fail(roles.error);
    if (assignments.error) return fail(assignments.error);
    return {
      ok: true,
      value: assembleStaff(
        (profiles.data ?? []) as unknown as StaffProfileRow[],
        (roles.data ?? []) as Array<{ user_id: string; role: string }>,
        (assignments.data ?? []) as Array<{ user_id: string; site_id: string }>
      )
    };
  });
}

/** Re-reads one person (after a change) so the UI shows what the database now holds. */
export async function loadStaffMember(db: AdminDb, userId: string): Promise<AdminResult<StaffMember>> {
  return run(async () => {
    const [profile, roles, assignments] = await Promise.all([
      db.from('profiles').select(STAFF_PROFILE_COLUMNS).eq('id', userId).maybeSingle(),
      db.from('user_roles').select('user_id, role').eq('user_id', userId),
      db.from('site_assignments').select('user_id, site_id').eq('user_id', userId)
    ]);
    if (profile.error) return fail(profile.error);
    if (roles.error) return fail(roles.error);
    if (assignments.error) return fail(assignments.error);
    if (!profile.data) return { ok: false, error: { kind: 'not_found', message: 'Person not found.' } };
    const [member] = assembleStaff(
      [profile.data as unknown as StaffProfileRow],
      (roles.data ?? []) as Array<{ user_id: string; role: string }>,
      (assignments.data ?? []) as Array<{ user_id: string; site_id: string }>
    );
    return { ok: true, value: member };
  });
}

/** Grants or revokes one role, then re-reads the person. The database refuses own roles. */
export async function setStaffRole(
  db: AdminDb,
  userId: string,
  role: UserRole,
  granted: boolean
): Promise<AdminResult<StaffMember>> {
  return run(async () => {
    if (granted) {
      const { error } = await db.from('user_roles').insert({ user_id: userId, role }).select('user_id, role').single();
      if (error && toAdminError(error).kind !== 'conflict') return fail(error);
    } else {
      const { data, error } = await db.from('user_roles').delete().eq('user_id', userId).eq('role', role).select('user_id');
      if (error) return fail(error);
      if (((data ?? []) as unknown[]).length === 0) {
        return { ok: false, error: { kind: 'not_found', message: 'No role was removed (not found or not allowed).' } };
      }
    }
    const member = await loadStaffMember(db, userId);
    if (!member.ok) return member;
    if (member.value.roles.includes(role) !== granted) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the role change.' } };
    }
    return member;
  });
}

/** Assigns or unassigns one site, then re-reads the person. */
export async function setStaffSite(
  db: AdminDb,
  userId: string,
  siteId: string,
  assigned: boolean
): Promise<AdminResult<StaffMember>> {
  return run(async () => {
    if (assigned) {
      const { error } = await db
        .from('site_assignments')
        .insert({ user_id: userId, site_id: siteId })
        .select('user_id, site_id')
        .single();
      if (error && toAdminError(error).kind !== 'conflict') return fail(error);
    } else {
      const { data, error } = await db
        .from('site_assignments')
        .delete()
        .eq('user_id', userId)
        .eq('site_id', siteId)
        .select('user_id');
      if (error) return fail(error);
      if (((data ?? []) as unknown[]).length === 0) {
        return { ok: false, error: { kind: 'not_found', message: 'No assignment was removed (not found or not allowed).' } };
      }
    }
    const member = await loadStaffMember(db, userId);
    if (!member.ok) return member;
    if (member.value.siteIds.includes(siteId) !== assigned) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the site change.' } };
    }
    return member;
  });
}

/** Deactivates / reactivates an account (profiles.is_active). Disabled accounts lose all access. */
export async function setStaffActive(db: AdminDb, userId: string, active: boolean): Promise<AdminResult<StaffMember>> {
  return run(async () => {
    const { data, error } = await db
      .from('profiles')
      .update({ is_active: active })
      .eq('id', userId)
      .select('id, is_active')
      .single();
    if (error) return fail(error);
    if ((data as { is_active: boolean }).is_active !== active) {
      return { ok: false, error: { kind: 'not_confirmed', message: 'The server did not confirm the change.' } };
    }
    return loadStaffMember(db, userId);
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export const AUDIT_PAGE_SIZE = 25;

/** One page of audit_logs, newest first (offset pagination; `hasMore` = an older page exists). */
export async function loadAuditPage(
  db: Pick<SupabaseClient, 'from'>,
  offset: number,
  pageSize: number = AUDIT_PAGE_SIZE
): Promise<AdminResult<{ entries: AuditEntry[]; hasMore: boolean }>> {
  return run(async () => {
    const { data, error } = await db
      .from('audit_logs')
      .select('id, actor_id, action, resource_type, resource_id, details, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize);
    if (error) return fail(error);
    const rows = (data ?? []) as Array<{
      id: string;
      actor_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      details: Record<string, unknown> | null;
      created_at: string;
    }>;
    return {
      ok: true,
      value: {
        hasMore: rows.length > pageSize,
        entries: rows.slice(0, pageSize).map((row) => ({
          id: row.id,
          actorId: row.actor_id,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          details: row.details && typeof row.details === 'object' ? row.details : null,
          createdAt: row.created_at
        }))
      }
    };
  });
}

/**
 * Keys whose values are secrets and must not be shown in the audit view: the printed QR token
 * (a bearer secret) and raw NFC tag serials (admins read those only through the audited
 * get_checkpoint_secrets RPC). Their SHA-256 fingerprints (qr_token_sha256, nfc_uid_sha256)
 * stay visible, so changes remain traceable.
 */
const SECRET_AUDIT_KEYS = new Set(['qr_code_hash', 'nfc_uid', 'nfc_uid_old', 'nfc_uid_new']);

export const AUDIT_HIDDEN_MARKER = '[hidden]';

/**
 * Copy of audit details with secret values replaced by `marker`. The audit trigger records every
 * changed column, including a rotated token or an enrolled serial; an admin screen (or a photo
 * of it) must not reveal them. A null value (nothing there) is kept as null.
 */
export function redactAuditDetails(value: unknown, marker: string = AUDIT_HIDDEN_MARKER): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAuditDetails(item, marker));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_AUDIT_KEYS.has(key) ? (inner === null ? null : marker) : redactAuditDetails(inner, marker);
    }
    return out;
  }
  return value;
}
