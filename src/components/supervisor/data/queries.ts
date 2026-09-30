/**
 * Read queries for the supervisor dashboard and the client viewer portal.
 *
 * Rules:
 * - Explicit column lists only (never '*'). Checkpoint secrets (qr_code_hash, nfc_uid) are not
 *   readable by any signed-in role and are never selected here.
 * - Every query is filtered to the caller's visible sites; RLS enforces the real boundary
 *   (supervisors: assigned sites, admins: organisation, client viewers: assigned sites without
 *   panic alerts or selfies).
 * - Only plain filters (eq / in / gte / order / limit) are used so the same code runs against
 *   hosted PostgREST and the test stand-ins.
 * - A query that returns exactly its row limit is reported in `partial` so the UI can say the
 *   list may be incomplete instead of presenting it as the whole picture.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isNetworkFailure } from '@/lib/auth/authErrors';
import type {
  CheckpointLite,
  GateRow,
  IncidentMediaRow,
  IncidentRow,
  OpsSnapshot,
  PanicRow,
  PartialSection,
  PersonInfo,
  ScanRow,
  ShiftRow
} from './types';

export type OpsClient = Pick<SupabaseClient, 'from' | 'rpc'>;

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;

/** Supervisor: shifts that started in this window are listed under "recent shifts". */
export const SUPERVISOR_RECENT_SHIFTS_MS = 48 * HOUR_MS;
/** Viewer: patrol compliance covers this many days. */
export const VIEWER_REPORT_DAYS = 7;
/** Resolved incidents / SOS shown to supervisors. */
export const SUPERVISOR_CLOSED_HISTORY_MS = 7 * DAY_MS;
/** Viewer incident list window. */
export const VIEWER_INCIDENT_MS = 30 * DAY_MS;
/** Gate entries loaded (vehicles still on the premises are found among these). */
export const GATE_WINDOW_MS = 30 * DAY_MS;

export const LIMITS = {
  activeShifts: 200,
  recentShifts: 400,
  checkpoints: 1000,
  scansPerChunk: 1000,
  openIncidents: 200,
  closedIncidents: 150,
  viewerIncidents: 300,
  openPanics: 100,
  closedPanics: 60,
  gate: 1000,
  media: 1000
} as const;

const SHIFT_COLUMNS_SUPERVISOR =
  'id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, actual_end, status, start_selfie_url, end_selfie_url, start_accuracy_meters, end_accuracy_meters, notes';
/** Client viewers: no selfie paths (they may not open selfies) and no notes. */
const SHIFT_COLUMNS_VIEWER =
  'id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, actual_end, status';
const SCAN_COLUMNS =
  'id, shift_id, site_id, checkpoint_id, guard_id, scan_timestamp_device, scan_timestamp_server, accuracy_meters, distance_to_checkpoint_meters, gps_confidence, gps_error, payload_type, payload_verified, method, checkpoint_radius_meters';
const CHECKPOINT_COLUMNS_LITE = 'id, site_id, name, order_index, is_active, deactivated_at, created_at';
const INCIDENT_COLUMNS =
  'id, site_id, shift_id, guard_id, incident_type, severity, description, latitude, longitude, accuracy_meters, status, reported_at, acknowledged_by, acknowledged_at, supervisor_notes, created_at';
const MEDIA_COLUMNS = 'id, incident_id, media_url, media_type';
const PANIC_COLUMNS =
  'id, site_id, shift_id, guard_id, latitude, longitude, accuracy_meters, status, triggered_at, acknowledged_by, acknowledged_at, resolution_notes, created_at';
const GATE_COLUMNS =
  'id, site_id, guard_id, direction, license_plate, make_model, vehicle_colour, vehicle_description, register_number, driver_name, company, visit_reason, person_visited, is_disc_scanned, disc_expiry_date, entry_time, exit_time, dwell_duration_seconds, vehicle_photo_url, linked_entry_id, created_at';

export type OpsLoadErrorKind = 'network' | 'not_allowed' | 'error';

/** A read that failed. `kind` drives the message: no connection vs. refused vs. server error. */
export class OpsLoadError extends Error {
  readonly section: string;
  readonly kind: OpsLoadErrorKind;
  readonly code?: string;
  constructor(section: string, kind: OpsLoadErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'OpsLoadError';
    this.section = section;
    this.kind = kind;
    this.code = code;
  }
}

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  status?: number;
}

function errorKind(status: number | undefined, error: unknown): OpsLoadErrorKind {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === '42501' || status === 401 || status === 403) return 'not_allowed';
  if (isNetworkFailure(status, error)) return 'network';
  return 'error';
}

async function rows<T>(section: string, query: PromiseLike<QueryResult>): Promise<T[]> {
  let result: QueryResult;
  try {
    result = await query;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpsLoadError(section, isNetworkFailure(undefined, error) ? 'network' : 'error', message);
  }
  if (result.error) {
    throw new OpsLoadError(section, errorKind(result.status, result.error), result.error.message, result.error.code);
  }
  return Array.isArray(result.data) ? (result.data as T[]) : [];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniqueById<T extends { id: string }>(...lists: T[][]): T[] {
  const map = new Map<string, T>();
  for (const list of lists) for (const item of list) map.set(item.id, item);
  return [...map.values()];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function loadScansForShifts(
  client: OpsClient,
  shiftIds: string[],
  partial: Set<PartialSection>
): Promise<ScanRow[]> {
  // Ten shifts per request keeps each response well under the row limit (a 12-hour shift with
  // hourly rounds and 10 checkpoints is 120 scans).
  const parts = await Promise.all(
    chunk(shiftIds, 10).map((ids) =>
      rows<ScanRow>(
        'patrol_scans',
        client
          .from('patrol_scans')
          .select(SCAN_COLUMNS)
          .in('shift_id', ids)
          .order('scan_timestamp_device', { ascending: false })
          .limit(LIMITS.scansPerChunk)
      )
    )
  );
  parts.forEach((part) => {
    if (part.length >= LIMITS.scansPerChunk) partial.add('scans');
  });
  return uniqueById(...parts);
}

async function loadMedia(client: OpsClient, incidentIds: string[], partial: Set<PartialSection>): Promise<IncidentMediaRow[]> {
  const parts = await Promise.all(
    chunk(incidentIds, 50).map((ids) =>
      rows<IncidentMediaRow>(
        'incident_media',
        client.from('incident_media').select(MEDIA_COLUMNS).in('incident_id', ids).limit(LIMITS.media)
      )
    )
  );
  parts.forEach((part) => {
    if (part.length >= LIMITS.media) partial.add('media');
  });
  return uniqueById(...parts);
}

interface ProfileNameRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_number?: string | null;
}

interface SitePeopleRow {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Names for the given user ids. Supervisors and admins read `profiles` (with phone numbers);
 * client viewers cannot, so they (and anyone a supervisor's profile read misses, e.g. a guard
 * who was since unassigned) go through the site_people() RPC, which returns names only.
 */
async function loadPeople(
  client: OpsClient,
  userIds: string[],
  siteIds: string[],
  options: { readProfiles: boolean },
  partial: Set<PartialSection>
): Promise<Record<string, PersonInfo>> {
  const people: Record<string, PersonInfo> = {};
  if (userIds.length === 0) return people;

  if (options.readProfiles) {
    const parts = await Promise.all(
      chunk(userIds, 100).map((ids) =>
        rows<ProfileNameRow>(
          'profiles',
          client.from('profiles').select('id, first_name, last_name, phone_number').in('id', ids)
        )
      )
    );
    for (const row of parts.flat()) {
      people[row.id] = {
        id: row.id,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        phone: row.phone_number ?? undefined
      };
    }
  }

  const missing = userIds.filter((id) => !people[id]);
  if (missing.length === 0) return people;

  const results = await Promise.allSettled(
    siteIds.map((siteId) => rows<SitePeopleRow>('site_people', client.rpc('site_people', { p_site_id: siteId })))
  );
  let failed = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      failed = true;
      continue;
    }
    for (const row of result.value) {
      if (!people[row.user_id]) {
        people[row.user_id] = { id: row.user_id, firstName: row.first_name ?? '', lastName: row.last_name ?? '' };
      }
    }
  }
  // Names are display data: a failed lookup shows "name unavailable" rather than blocking the
  // alerts and patrol data, but it is reported (never silently replaced by a made-up name).
  if (failed && userIds.some((id) => !people[id])) partial.add('people');
  return people;
}

function collectUserIds(parts: {
  shifts: ShiftRow[];
  scans: ScanRow[];
  incidents: IncidentRow[];
  panics: PanicRow[];
  gate: GateRow[];
}): string[] {
  const ids = new Set<string>();
  parts.shifts.forEach((row) => ids.add(row.guard_id));
  parts.scans.forEach((row) => ids.add(row.guard_id));
  parts.incidents.forEach((row) => {
    ids.add(row.guard_id);
    if (row.acknowledged_by) ids.add(row.acknowledged_by);
  });
  parts.panics.forEach((row) => {
    ids.add(row.guard_id);
    if (row.acknowledged_by) ids.add(row.acknowledged_by);
  });
  parts.gate.forEach((row) => ids.add(row.guard_id));
  return [...ids].filter(Boolean);
}

function markPartial<T>(list: T[], limit: number, section: PartialSection, partial: Set<PartialSection>): T[] {
  if (list.length >= limit) partial.add(section);
  return list;
}

function emptySnapshot(siteIds: string[], fetchedAt: number): OpsSnapshot {
  return {
    fetchedAt,
    siteIds,
    shifts: [],
    scans: [],
    checkpoints: [],
    incidents: [],
    incidentMedia: [],
    panicAlerts: [],
    gateEntries: [],
    people: {},
    partial: []
  };
}

/**
 * Everything the supervisor dashboard shows for the given sites: open and recent shifts with
 * their scans, checkpoints, open + recent incidents (with media), open + recent SOS alerts,
 * the last 30 days of gate entries and the names of everyone referenced.
 */
export async function loadSupervisorSnapshot(
  client: OpsClient,
  siteIds: string[],
  now: number = Date.now()
): Promise<OpsSnapshot> {
  if (siteIds.length === 0) return emptySnapshot(siteIds, now);
  const partial = new Set<PartialSection>();

  const [activeShifts, recentShifts, checkpoints, openIncidents, closedIncidents, openPanics, closedPanics, gate] =
    await Promise.all([
      rows<ShiftRow>(
        'shifts',
        client
          .from('shifts')
          .select(SHIFT_COLUMNS_SUPERVISOR)
          .in('site_id', siteIds)
          .eq('status', 'active')
          .order('scheduled_start', { ascending: false })
          .limit(LIMITS.activeShifts)
      ),
      rows<ShiftRow>(
        'shifts',
        client
          .from('shifts')
          .select(SHIFT_COLUMNS_SUPERVISOR)
          .in('site_id', siteIds)
          .gte('scheduled_start', iso(now - SUPERVISOR_RECENT_SHIFTS_MS))
          .order('scheduled_start', { ascending: false })
          .limit(LIMITS.recentShifts)
      ),
      rows<CheckpointLite>(
        'checkpoints',
        client
          .from('checkpoints')
          .select(CHECKPOINT_COLUMNS_LITE)
          .in('site_id', siteIds)
          .order('order_index', { ascending: true })
          .limit(LIMITS.checkpoints)
      ),
      rows<IncidentRow>(
        'incidents',
        client
          .from('incidents')
          .select(INCIDENT_COLUMNS)
          .in('site_id', siteIds)
          .in('status', ['reported', 'acknowledged', 'investigating'])
          .order('reported_at', { ascending: false })
          .limit(LIMITS.openIncidents)
      ),
      rows<IncidentRow>(
        'incidents',
        client
          .from('incidents')
          .select(INCIDENT_COLUMNS)
          .in('site_id', siteIds)
          .eq('status', 'resolved')
          .gte('reported_at', iso(now - SUPERVISOR_CLOSED_HISTORY_MS))
          .order('reported_at', { ascending: false })
          .limit(LIMITS.closedIncidents)
      ),
      rows<PanicRow>(
        'panic_alerts',
        client
          .from('panic_alerts')
          .select(PANIC_COLUMNS)
          .in('site_id', siteIds)
          .in('status', ['active', 'acknowledged'])
          .order('triggered_at', { ascending: false })
          .limit(LIMITS.openPanics)
      ),
      rows<PanicRow>(
        'panic_alerts',
        client
          .from('panic_alerts')
          .select(PANIC_COLUMNS)
          .in('site_id', siteIds)
          .eq('status', 'resolved')
          .gte('triggered_at', iso(now - SUPERVISOR_CLOSED_HISTORY_MS))
          .order('triggered_at', { ascending: false })
          .limit(LIMITS.closedPanics)
      ),
      rows<GateRow>(
        'gate_entries',
        client
          .from('gate_entries')
          .select(GATE_COLUMNS)
          .in('site_id', siteIds)
          .gte('entry_time', iso(now - GATE_WINDOW_MS))
          .order('entry_time', { ascending: false })
          .limit(LIMITS.gate)
      )
    ]);

  markPartial(activeShifts, LIMITS.activeShifts, 'shifts', partial);
  markPartial(recentShifts, LIMITS.recentShifts, 'shifts', partial);
  markPartial(checkpoints, LIMITS.checkpoints, 'checkpoints', partial);
  markPartial(openIncidents, LIMITS.openIncidents, 'incidents', partial);
  markPartial(closedIncidents, LIMITS.closedIncidents, 'incidents', partial);
  markPartial(openPanics, LIMITS.openPanics, 'panic', partial);
  markPartial(closedPanics, LIMITS.closedPanics, 'panic', partial);
  markPartial(gate, LIMITS.gate, 'gate', partial);

  const shifts = uniqueById(activeShifts, recentShifts);
  const incidents = uniqueById(openIncidents, closedIncidents);
  const panics = uniqueById(openPanics, closedPanics);

  const [scans, media] = await Promise.all([
    loadScansForShifts(
      client,
      shifts.map((s) => s.id),
      partial
    ),
    loadMedia(
      client,
      incidents.map((i) => i.id),
      partial
    )
  ]);

  const people = await loadPeople(
    client,
    collectUserIds({ shifts, scans, incidents, panics, gate }),
    siteIds,
    { readProfiles: true },
    partial
  );

  return {
    fetchedAt: now,
    siteIds,
    shifts,
    scans,
    checkpoints,
    incidents,
    incidentMedia: media,
    panicAlerts: panics,
    gateEntries: gate,
    people,
    partial: [...partial]
  };
}

/**
 * The client viewer report: the last 7 days of shifts with their scans, checkpoints, the last
 * 30 days of incidents (with media) and gate entries. No panic alerts, selfies or phone numbers.
 */
export async function loadViewerSnapshot(
  client: OpsClient,
  siteIds: string[],
  now: number = Date.now()
): Promise<OpsSnapshot> {
  if (siteIds.length === 0) return emptySnapshot(siteIds, now);
  const partial = new Set<PartialSection>();
  const reportStart = now - VIEWER_REPORT_DAYS * DAY_MS;

  const [activeShifts, recentShifts, checkpoints, incidents, gate] = await Promise.all([
    rows<ShiftRow>(
      'shifts',
      client
        .from('shifts')
        .select(SHIFT_COLUMNS_VIEWER)
        .in('site_id', siteIds)
        .eq('status', 'active')
        .order('scheduled_start', { ascending: false })
        .limit(LIMITS.activeShifts)
    ),
    rows<ShiftRow>(
      'shifts',
      client
        .from('shifts')
        .select(SHIFT_COLUMNS_VIEWER)
        .in('site_id', siteIds)
        .gte('scheduled_start', iso(reportStart - DAY_MS))
        .order('scheduled_start', { ascending: false })
        .limit(LIMITS.recentShifts)
    ),
    rows<CheckpointLite>(
      'checkpoints',
      client
        .from('checkpoints')
        .select(CHECKPOINT_COLUMNS_LITE)
        .in('site_id', siteIds)
        .order('order_index', { ascending: true })
        .limit(LIMITS.checkpoints)
    ),
    rows<IncidentRow>(
      'incidents',
      client
        .from('incidents')
        .select(INCIDENT_COLUMNS)
        .in('site_id', siteIds)
        .gte('reported_at', iso(now - VIEWER_INCIDENT_MS))
        .order('reported_at', { ascending: false })
        .limit(LIMITS.viewerIncidents)
    ),
    rows<GateRow>(
      'gate_entries',
      client
        .from('gate_entries')
        .select(GATE_COLUMNS)
        .in('site_id', siteIds)
        .gte('entry_time', iso(now - GATE_WINDOW_MS))
        .order('entry_time', { ascending: false })
        .limit(LIMITS.gate)
    )
  ]);

  markPartial(activeShifts, LIMITS.activeShifts, 'shifts', partial);
  markPartial(recentShifts, LIMITS.recentShifts, 'shifts', partial);
  markPartial(checkpoints, LIMITS.checkpoints, 'checkpoints', partial);
  markPartial(incidents, LIMITS.viewerIncidents, 'incidents', partial);
  markPartial(gate, LIMITS.gate, 'gate', partial);

  const shifts = uniqueById(activeShifts, recentShifts);
  const [scans, media] = await Promise.all([
    loadScansForShifts(
      client,
      shifts.map((s) => s.id),
      partial
    ),
    loadMedia(
      client,
      incidents.map((i) => i.id),
      partial
    )
  ]);

  const people = await loadPeople(
    client,
    collectUserIds({ shifts, scans, incidents, panics: [], gate }),
    siteIds,
    { readProfiles: false },
    partial
  );

  return {
    fetchedAt: now,
    siteIds,
    shifts,
    scans,
    checkpoints,
    incidents,
    incidentMedia: media,
    panicAlerts: [],
    gateEntries: gate,
    people,
    partial: [...partial]
  };
}

// ---------------------------------------------------------------------------
// Supervisor writes (status / notes only; the server stamps the acknowledgement)
// ---------------------------------------------------------------------------

export type WriteProblem = 'network' | 'not_allowed' | 'no_rows' | 'error';

export type WriteResult<T> = { ok: true; row: T } | { ok: false; problem: WriteProblem; message: string };

interface UpdateResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  status?: number;
}

async function runUpdate<T>(query: PromiseLike<UpdateResult>): Promise<WriteResult<T>> {
  let result: UpdateResult;
  try {
    result = await query;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: isNetworkFailure(undefined, error) ? 'network' : 'error', message };
  }
  if (result.error) {
    const kind = errorKind(result.status, result.error);
    return { ok: false, problem: kind === 'not_allowed' ? 'not_allowed' : kind, message: result.error.message };
  }
  const list = Array.isArray(result.data) ? (result.data as T[]) : [];
  // An UPDATE filtered away by RLS returns no error and no rows: it did NOT save.
  if (list.length === 0) return { ok: false, problem: 'no_rows', message: 'No row was updated' };
  return { ok: true, row: list[0] };
}

export type IncidentUpdate = { status?: 'acknowledged' | 'investigating' | 'resolved'; supervisorNotes?: string };

/**
 * Updates an incident's status and/or supervisor notes. Only these columns are sent: the
 * database sets acknowledged_by (the caller) and acknowledged_at (server time) itself.
 * Returns the row as stored by the server.
 */
export function updateIncident(client: OpsClient, incidentId: string, update: IncidentUpdate): Promise<WriteResult<IncidentRow>> {
  const values: Record<string, unknown> = {};
  if (update.status) values.status = update.status;
  if (update.supervisorNotes !== undefined) values.supervisor_notes = update.supervisorNotes;
  return runUpdate<IncidentRow>(client.from('incidents').update(values).eq('id', incidentId).select(INCIDENT_COLUMNS));
}

export type PanicUpdate = { status?: 'acknowledged' | 'resolved'; resolutionNotes?: string };

/** Acknowledges / resolves an SOS alert (status and resolution notes only). */
export function updatePanicAlert(client: OpsClient, alertId: string, update: PanicUpdate): Promise<WriteResult<PanicRow>> {
  const values: Record<string, unknown> = {};
  if (update.status) values.status = update.status;
  if (update.resolutionNotes !== undefined) values.resolution_notes = update.resolutionNotes;
  return runUpdate<PanicRow>(client.from('panic_alerts').update(values).eq('id', alertId).select(PANIC_COLUMNS));
}
