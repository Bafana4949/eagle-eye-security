/**
 * Loads the signed-in user's profile, roles and visible sites from Supabase (RLS-scoped),
 * maps snake_case rows to the app models, and caches the result per user in localStorage so
 * the guard app can boot while offline.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Site, SupportedLanguage, UserProfile, UserRole } from '@/types/models';
import { isNetworkFailure } from './authErrors';
import { isUserRole } from './routeAccess';

/** Explicit column lists (never select '*'; profiles no longer carry secrets but stay explicit). */
export const PROFILE_COLUMNS =
  'id, organisation_id, first_name, last_name, employee_number, phone_number, preferred_language, is_active';
export const SITE_COLUMNS =
  'id, organisation_id, name, code, address, latitude, longitude, default_radius_meters, day_shift_start, day_shift_end, night_shift_start, night_shift_end, round_interval_minutes, emergency_phone, police_phone, whatsapp_dispatch_number, is_active, allow_legacy_qr';

export interface ProfileRow {
  id: string;
  organisation_id: string;
  first_name: string;
  last_name: string;
  employee_number: string | null;
  phone_number: string | null;
  preferred_language: string | null;
  is_active: boolean;
}

export interface SiteRow {
  id: string;
  organisation_id: string;
  name: string;
  code: string;
  address: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  default_radius_meters: number | string | null;
  day_shift_start: string;
  day_shift_end: string;
  night_shift_start: string;
  night_shift_end: string;
  round_interval_minutes: number | string;
  emergency_phone: string | null;
  police_phone: string | null;
  whatsapp_dispatch_number: string | null;
  is_active: boolean;
  /** Added by migration 20261001000000 (whether PLAAS-CP legacy cards may be scanned). */
  allow_legacy_qr?: boolean | null;
}

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toLanguage(value: string | null): SupportedLanguage {
  return value === 'af' || value === 'zu' || value === 'en' ? value : 'en';
}

/** Postgres TIME ('18:00:00') → 'HH:MM'. */
function toClock(value: string | null | undefined): string {
  return typeof value === 'string' ? value.slice(0, 5) : '';
}

export function mapProfileRow(row: ProfileRow, roles: UserRole[]): UserProfile {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    firstName: row.first_name,
    lastName: row.last_name,
    employeeNumber: row.employee_number ?? undefined,
    phoneNumber: row.phone_number ?? undefined,
    preferredLanguage: toLanguage(row.preferred_language),
    roles,
    isActive: row.is_active === true
  };
}

export function mapSiteRow(row: SiteRow): Site {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    code: row.code,
    address: row.address ?? undefined,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    defaultRadiusMeters: toNumber(row.default_radius_meters) ?? 50,
    dayShiftStart: toClock(row.day_shift_start),
    dayShiftEnd: toClock(row.day_shift_end),
    nightShiftStart: toClock(row.night_shift_start),
    nightShiftEnd: toClock(row.night_shift_end),
    roundIntervalMinutes: toNumber(row.round_interval_minutes) ?? 60,
    emergencyPhone: row.emergency_phone ?? undefined,
    // No invented default: an empty value means "not configured" and the UI must say so.
    policePhone: row.police_phone ?? '',
    whatsappDispatchNumber: row.whatsapp_dispatch_number ?? undefined,
    isActive: row.is_active === true,
    allowLegacyQr: row.allow_legacy_qr === true
  };
}

export interface IdentitySnapshot {
  user: { id: string; email: string | null };
  profile: UserProfile;
  roles: UserRole[];
  sites: Site[];
  /** ISO time the snapshot was loaded from the server. */
  loadedAt: string;
}

export type LoadIdentityResult =
  | { kind: 'ok'; snapshot: IdentitySnapshot }
  | { kind: 'no_profile' }
  | { kind: 'disabled' }
  | { kind: 'unavailable'; network: boolean; message: string };

interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
  status?: number;
}

function unavailable(result: QueryResult<unknown>, what: string): LoadIdentityResult {
  return {
    kind: 'unavailable',
    network: isNetworkFailure(result.status, result.error),
    message: `Could not load ${what}: ${result.error?.message ?? 'unknown error'}`
  };
}

/** Reads profile → roles → sites for `user`. Never throws for server/network errors. */
export async function loadIdentity(
  supabase: Pick<SupabaseClient, 'from'>,
  user: { id: string; email: string | null },
  now: () => Date = () => new Date()
): Promise<LoadIdentityResult> {
  try {
    const profileResult = (await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle()) as QueryResult<ProfileRow>;
    if (profileResult.error) return unavailable(profileResult, 'your profile');
    if (!profileResult.data) return { kind: 'no_profile' };
    if (profileResult.data.is_active !== true) return { kind: 'disabled' };

    const rolesResult = (await supabase.from('user_roles').select('role').eq('user_id', user.id)) as QueryResult<
      Array<{ role: string }>
    >;
    if (rolesResult.error) return unavailable(rolesResult, 'your roles');
    const roles = (rolesResult.data ?? []).map((row) => row.role).filter(isUserRole);

    // RLS returns only the sites this user may see (assigned sites; whole org for admins).
    const sitesResult = (await supabase
      .from('sites')
      .select(SITE_COLUMNS)
      .order('name', { ascending: true })) as QueryResult<SiteRow[]>;
    if (sitesResult.error) return unavailable(sitesResult, 'your sites');
    const sites = (sitesResult.data ?? []).map(mapSiteRow);

    return {
      kind: 'ok',
      snapshot: {
        user,
        profile: mapProfileRow(profileResult.data, roles),
        roles,
        sites,
        loadedAt: now().toISOString()
      }
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      network: isNetworkFailure(undefined, error),
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

// ---------------------------------------------------------------------------
// Offline identity cache
// ---------------------------------------------------------------------------

/** Minimal Storage surface (window.localStorage in the browser, an in-memory map in tests). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const AUTH_CACHE_PREFIX = 'ee.authcache.';
/**
 * Points at the account that holds this device's session: the only cache that may be used to
 * boot offline. Set when a session is established (sign-in), cleared when it definitely ends.
 */
export const AUTH_CACHE_CURRENT_KEY = 'ee.authcache.current';
const ACTIVE_SITE_PREFIX = 'ee.activesite.';

/** window.localStorage, or null on the server / when storage is blocked. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function safeGet(storage: KeyValueStorage | null, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(storage: KeyValueStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota / private mode: offline boot is then unavailable, online use is unaffected.
  }
}

function safeRemove(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // ignore
  }
}

export function writeIdentityCache(storage: KeyValueStorage | null, snapshot: IdentitySnapshot): void {
  safeSet(storage, AUTH_CACHE_PREFIX + snapshot.user.id, JSON.stringify(snapshot));
  safeSet(storage, AUTH_CACHE_CURRENT_KEY, snapshot.user.id);
}

export function readIdentityCache(storage: KeyValueStorage | null, userId: string): IdentitySnapshot | null {
  const raw = safeGet(storage, AUTH_CACHE_PREFIX + userId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IdentitySnapshot;
    if (
      parsed?.user?.id !== userId ||
      parsed.profile?.id !== userId ||
      !Array.isArray(parsed.roles) ||
      !Array.isArray(parsed.sites) ||
      parsed.profile.isActive !== true
    ) {
      return null;
    }
    return { ...parsed, roles: parsed.roles.filter(isUserRole) };
  } catch {
    return null;
  }
}

export function readCurrentCachedUserId(storage: KeyValueStorage | null): string | null {
  return safeGet(storage, AUTH_CACHE_CURRENT_KEY);
}

/** Records that `userId` now holds this device's session (replaces any previous account). */
export function setCurrentUserPointer(storage: KeyValueStorage | null, userId: string): void {
  safeSet(storage, AUTH_CACHE_CURRENT_KEY, userId);
}

export function clearCurrentUserPointer(storage: KeyValueStorage | null): void {
  safeRemove(storage, AUTH_CACHE_CURRENT_KEY);
}

export function clearIdentityCache(storage: KeyValueStorage | null, userId: string): void {
  safeRemove(storage, AUTH_CACHE_PREFIX + userId);
  if (safeGet(storage, AUTH_CACHE_CURRENT_KEY) === userId) safeRemove(storage, AUTH_CACHE_CURRENT_KEY);
}

export function readActiveSiteId(storage: KeyValueStorage | null, userId: string): string | null {
  return safeGet(storage, ACTIVE_SITE_PREFIX + userId);
}

export function writeActiveSiteId(storage: KeyValueStorage | null, userId: string, siteId: string): void {
  safeSet(storage, ACTIVE_SITE_PREFIX + userId, siteId);
}

/** The stored active site when it is still visible, else the first active site, else the first site. */
export function pickActiveSite(sites: readonly Site[], preferredId: string | null): Site | null {
  const preferred = preferredId ? sites.find((site) => site.id === preferredId) : undefined;
  if (preferred) return preferred;
  return sites.find((site) => site.isActive) ?? sites[0] ?? null;
}
