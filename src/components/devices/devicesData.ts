/**
 * Patrol phones list for the "Patrol phones" panel, read AS THE SIGNED-IN admin / supervisor:
 * RLS returns only the phones of sites the caller manages (public.managed_site_ids()). The
 * secret hash column is not selectable by clients and is never asked for. Enrolment and
 * revocation go through the audited RPCs in src/lib/auth/patrolDevice.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { toAdminError, type AdminResult } from '@/components/admin/adminData';

/** Every column of public.patrol_devices except secret_sha256. */
export const PATROL_DEVICE_COLUMNS =
  'id, organisation_id, site_id, label, enrolled_by, enrolled_at, last_used_at, last_guard_id, revoked_at, revoked_by, created_at';

/** Upper bound for one listing (a farm group has a handful of gate / patrol phones). */
export const PATROL_DEVICE_LIST_LIMIT = 200;

export interface PatrolDeviceRow {
  id: string;
  organisation_id: string;
  site_id: string;
  label: string;
  enrolled_by: string | null;
  enrolled_at: string;
  last_used_at: string | null;
  last_guard_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

export interface PatrolDeviceList {
  devices: PatrolDeviceRow[];
  /** Display names of the people who enrolled / last used the phones, where RLS lets the caller see them. */
  names: Record<string, string>;
}

function time(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Active phones first (newest enrolment first), then revoked ones (most recently revoked first). */
export function sortPatrolDevices(rows: readonly PatrolDeviceRow[]): PatrolDeviceRow[] {
  return [...rows].sort((a, b) => {
    const aRevoked = a.revoked_at !== null;
    const bRevoked = b.revoked_at !== null;
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    if (aRevoked) return time(b.revoked_at) - time(a.revoked_at);
    return time(b.enrolled_at) - time(a.enrolled_at);
  });
}

export async function loadPatrolDevices(db: Pick<SupabaseClient, 'from'>): Promise<AdminResult<PatrolDeviceList>> {
  try {
    const { data, error } = await db
      .from('patrol_devices')
      .select(PATROL_DEVICE_COLUMNS)
      .order('enrolled_at', { ascending: false })
      .limit(PATROL_DEVICE_LIST_LIMIT);
    if (error) return { ok: false, error: toAdminError(error) };
    const devices = sortPatrolDevices((data ?? []) as unknown as PatrolDeviceRow[]);

    const ids = [
      ...new Set(devices.flatMap((device) => [device.enrolled_by, device.last_guard_id]).filter((id): id is string => !!id))
    ];
    const names: Record<string, string> = {};
    if (ids.length > 0) {
      // Names are a convenience: when they cannot be read the list still shows (as "not visible").
      const people = await db.from('profiles').select('id, first_name, last_name').in('id', ids);
      if (!people.error) {
        for (const person of (people.data ?? []) as unknown as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
          const name = `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim();
          if (name) names[person.id] = name;
        }
      }
    }
    return { ok: true, value: { devices, names } };
  } catch (error) {
    return { ok: false, error: toAdminError(error) };
  }
}

export interface QueuedCounts {
  /** Records not yet on the server, per user id (only users with at least one). */
  byUser: Record<string, number>;
  /** All records on this phone that are not on the server yet. */
  total: number;
}

/** Counts a phone's unsynced records per person, from the queue items' user ids. */
export function countQueuedByUser(userIds: readonly (string | null | undefined)[]): QueuedCounts {
  const byUser: Record<string, number> = {};
  let total = 0;
  for (const id of userIds) {
    total += 1;
    if (id) byUser[id] = (byUser[id] ?? 0) + 1;
  }
  return { byUser, total };
}
