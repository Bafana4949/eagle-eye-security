/**
 * Pure derivations for the supervisor dashboard and the client viewer portal.
 *
 * Every figure is computed from rows the server returned (see ./queries.ts); nothing is
 * defaulted or invented. When nothing was due, compliance is null ("–"), never 100 %.
 * Only data that has reached the server is visible here: scans still queued on a guard's phone
 * appear once that phone syncs, so the UI labels these figures as "received by the server".
 */
import type { Site } from '@/types/models';
import { computeShiftStats, type ShiftStats } from '@/lib/whatsapp/summary';
import { evaluatePatrolAlarm, type PatrolAlarmState } from '@/lib/patrol/alarm';
import { calculateShiftBounds } from '@/features/shifts/shiftCalculator';
import { addDaysToDateString, sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import { normalizePlate } from '@/lib/license-disc/parser';
import type { CheckpointLite, GateRow, IncidentRow, OpsSnapshot, PanicRow, PersonInfo, ScanRow, ShiftRow } from './types';

export const MINUTE_MS = 60000;
/** A scan that reached the server this much later than the phone recorded it is flagged. */
export const LATE_UPLOAD_MS = 5 * MINUTE_MS;
/** An open shift this long past its scheduled end is flagged "clock-out not received". */
export const OVERDUE_CLOCK_OUT_MS = 60 * MINUTE_MS;
/** An SOS that reached the server this much after it was triggered shows the delay. */
export const LATE_SOS_MS = 2 * MINUTE_MS;
/** Longest schedule we evaluate (mirrors computeShiftStats' guard against misconfigured sites). */
const MAX_ROUNDS = 192;

export function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "First Last" for a user id, or null when the name is not readable / unknown. */
export function personName(people: Readonly<Record<string, PersonInfo>>, id: string | null | undefined): string | null {
  if (!id) return null;
  const person = people[id];
  if (!person) return null;
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name || null;
}

export function sitesById(sites: readonly Site[]): Map<string, Site> {
  return new Map(sites.map((site) => [site.id, site]));
}

/** SAST "HH:MM" today, otherwise "YYYY-MM-DD HH:MM" (site time, independent of the phone's zone). */
export function formatWhen(ms: number | null, now: number): string {
  if (ms === null) return '–';
  const time = sastTimeHM(ms);
  return sastDateString(ms) === sastDateString(now) ? time : `${sastDateString(ms)} ${time}`;
}

/** "8h 05m" / "12m" (never negative). */
export function formatSpan(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/** Time between the phone recording a scan and the server receiving it (null when unknown). */
export function uploadDelayMs(scan: Pick<ScanRow, 'scan_timestamp_device' | 'scan_timestamp_server'>): number | null {
  const device = toMs(scan.scan_timestamp_device);
  const server = toMs(scan.scan_timestamp_server);
  if (device === null || server === null) return null;
  return Math.max(0, server - device);
}

export type Tone = 'success' | 'warning' | 'danger' | 'muted';

/** Colour tone of a server-computed GPS confidence (always shown together with its label). */
export function confidenceTone(confidence: ScanRow['gps_confidence']): Tone {
  switch (confidence) {
    case 'verified':
    case 'likely':
      return 'success';
    case 'low_confidence':
    case 'no_fix':
      return 'warning';
    case 'outside':
      return 'danger';
    default:
      return 'muted';
  }
}

/** Dawie's report colours: ≥ 90 % ok, ≥ 70 % check, below that bad; null = nothing due. */
export function complianceTone(percent: number | null): Tone {
  if (percent === null) return 'muted';
  if (percent >= 90) return 'success';
  if (percent >= 70) return 'warning';
  return 'danger';
}

export function groupScansByShift(scans: readonly ScanRow[]): Map<string, ScanRow[]> {
  const map = new Map<string, ScanRow[]>();
  for (const scan of scans) {
    const list = map.get(scan.shift_id);
    if (list) list.push(scan);
    else map.set(scan.shift_id, [scan]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (toMs(a.scan_timestamp_device) ?? 0) - (toMs(b.scan_timestamp_device) ?? 0));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Shift compliance
// ---------------------------------------------------------------------------

export interface ExpectedCheckpoint {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * The site's checkpoints as they were during [periodStart, periodEnd): a checkpoint created
 * after the period is not expected, one deactivated before it started is not expected, one
 * deactivated during or after it still is (scans captured before deactivation count).
 */
export function checkpointsForPeriod(
  checkpoints: readonly CheckpointLite[],
  siteId: string,
  periodStart: number,
  periodEnd: number
): ExpectedCheckpoint[] {
  return checkpoints
    .filter((cp) => cp.site_id === siteId)
    .filter((cp) => {
      const created = toMs(cp.created_at);
      return created === null || created < periodEnd;
    })
    .sort((a, b) => a.order_index - b.order_index || a.name.localeCompare(b.name))
    .map((cp) => {
      const deactivated = toMs(cp.deactivated_at);
      const isActive = cp.is_active || (deactivated !== null && deactivated > periodStart);
      return { id: cp.id, name: cp.name, isActive };
    });
}

export type ShiftProblem = 'no_site' | 'invalid_schedule' | null;

export interface ShiftReport {
  shift: ShiftRow;
  site: Site | null;
  /** This shift's scans (oldest first). */
  scans: ScanRow[];
  expected: ExpectedCheckpoint[];
  stats: ShiftStats | null;
  problem: ShiftProblem;
  /** Open shifts only: round overdue ('late') or closing soon with open checkpoints ('soon'). */
  alarm: PatrolAlarmState | null;
  lastScanAt: number | null;
  isOpen: boolean;
  /** Open shift whose scheduled end passed more than an hour ago (clock-out not received). */
  clockOutOverdue: boolean;
}

export function isOpenShift(shift: ShiftRow): boolean {
  return shift.status === 'active' && !shift.actual_end;
}

export function buildShiftReport(
  shift: ShiftRow,
  site: Site | null,
  checkpoints: readonly CheckpointLite[],
  shiftScans: readonly ScanRow[],
  now: number
): ShiftReport {
  const scans = [...shiftScans].sort(
    (a, b) => (toMs(a.scan_timestamp_device) ?? 0) - (toMs(b.scan_timestamp_device) ?? 0)
  );
  const lastScan = scans.length > 0 ? toMs(scans[scans.length - 1].scan_timestamp_device) : null;
  const open = isOpenShift(shift);
  const scheduledStart = toMs(shift.scheduled_start);
  const scheduledEnd = toMs(shift.scheduled_end);
  const clockOutOverdue = open && scheduledEnd !== null && now - scheduledEnd > OVERDUE_CLOCK_OUT_MS;
  const base = { shift, site, scans, lastScanAt: lastScan, isOpen: open, clockOutOverdue };

  if (!site) return { ...base, expected: [], stats: null, problem: 'no_site', alarm: null };
  if (scheduledStart === null || scheduledEnd === null || scheduledEnd <= scheduledStart) {
    return { ...base, expected: [], stats: null, problem: 'invalid_schedule', alarm: null };
  }
  const expected = checkpointsForPeriod(checkpoints, shift.site_id, scheduledStart, scheduledEnd);

  let stats: ShiftStats | null = null;
  try {
    stats = computeShiftStats({
      siteName: site.name,
      guardName: '',
      shift: {
        id: shift.id,
        shiftType: shift.shift_type,
        scheduledStart,
        scheduledEnd,
        actualStart: shift.actual_start,
        actualEnd: shift.actual_end
      },
      roundIntervalMinutes: site.roundIntervalMinutes,
      checkpoints: expected,
      scans: scans.map((s) => ({
        checkpointId: s.checkpoint_id,
        timestamp: s.scan_timestamp_device,
        gpsConfidence: s.gps_confidence
      })),
      incidents: [],
      panicAlerts: [],
      gateEntries: [],
      now
    });
  } catch {
    return { ...base, expected, stats: null, problem: 'invalid_schedule', alarm: null };
  }

  let alarm: PatrolAlarmState | null = null;
  if (open) {
    try {
      alarm = evaluatePatrolAlarm(
        now,
        scheduledStart,
        scheduledEnd,
        site.roundIntervalMinutes,
        expected.filter((cp) => cp.isActive).map((cp) => cp.id),
        scans
          .map((s) => ({ checkpointId: s.checkpoint_id, timestampMs: toMs(s.scan_timestamp_device) ?? NaN }))
          .filter((s) => Number.isFinite(s.timestampMs))
      );
    } catch {
      alarm = null;
    }
  }
  return { ...base, expected, stats, problem: null, alarm };
}

export function buildShiftReports(
  snapshot: Pick<OpsSnapshot, 'shifts' | 'scans' | 'checkpoints'>,
  sites: ReadonlyMap<string, Site>,
  now: number
): ShiftReport[] {
  const byShift = groupScansByShift(snapshot.scans);
  return snapshot.shifts
    .map((shift) =>
      buildShiftReport(shift, sites.get(shift.site_id) ?? null, snapshot.checkpoints, byShift.get(shift.id) ?? [], now)
    )
    .sort((a, b) => (toMs(b.shift.scheduled_start) ?? 0) - (toMs(a.shift.scheduled_start) ?? 0));
}

export interface ComplianceTotal {
  visits: number;
  expected: number;
  percent: number | null;
  shiftsCounted: number;
}

/** Checkpoint visits over expected visits across shifts (shifts with nothing due are skipped). */
export function aggregateCompliance(reports: readonly ShiftReport[]): ComplianceTotal {
  let visits = 0;
  let expected = 0;
  let shiftsCounted = 0;
  for (const report of reports) {
    if (!report.stats || report.stats.expectedCheckpointVisits === 0) continue;
    visits += report.stats.checkpointVisits;
    expected += report.stats.expectedCheckpointVisits;
    shiftsCounted++;
  }
  return { visits, expected, percent: expected > 0 ? Math.round((visits / expected) * 100) : null, shiftsCounted };
}

export interface RoundColumn {
  roundNumber: number;
  windowStart: number;
  windowEnd: number;
  state: 'past' | 'current' | 'future';
}

export interface RoundGrid {
  rounds: RoundColumn[];
  rows: Array<{ checkpointId: string; name: string; cells: Array<number | null> }>;
}

/**
 * Dawie's report grid: one row per expected checkpoint, one column per round of the shift's
 * schedule; a cell holds the time of the first scan of that checkpoint in that round.
 */
export function buildRoundGrid(report: ShiftReport, now: number): RoundGrid | null {
  if (!report.site || report.problem) return null;
  const start = toMs(report.shift.scheduled_start);
  const end = toMs(report.shift.scheduled_end);
  const interval = report.site.roundIntervalMinutes;
  if (start === null || end === null || end <= start || !Number.isFinite(interval) || interval <= 0) return null;
  const ivMs = interval * MINUTE_MS;
  const count = Math.ceil((end - start) / ivMs);
  if (count > MAX_ROUNDS) return null;

  const rounds: RoundColumn[] = [];
  for (let k = 0; k < count; k++) {
    const windowStart = start + k * ivMs;
    const windowEnd = Math.min(windowStart + ivMs, end);
    const state = now >= windowEnd ? 'past' : now >= windowStart ? 'current' : 'future';
    rounds.push({ roundNumber: k + 1, windowStart, windowEnd, state });
  }
  const rows = report.expected
    .filter((cp) => cp.isActive)
    .map((cp) => ({
      checkpointId: cp.id,
      name: cp.name,
      cells: rounds.map((round) => {
        let first: number | null = null;
        for (const scan of report.scans) {
          if (scan.checkpoint_id !== cp.id) continue;
          const at = toMs(scan.scan_timestamp_device);
          if (at === null || at < round.windowStart || at >= round.windowEnd) continue;
          if (first === null || at < first) first = at;
        }
        return first;
      })
    }));
  return { rounds, rows };
}

export interface UncoveredWindow {
  siteId: string;
  shiftType: 'day' | 'night';
  date: string;
  start: number;
  end: number;
}

/**
 * Scheduled day / night shifts of a site (from its configured SAST times) that started within
 * [fromMs, now] while no guard's shift overlapped them. Like Dawie's weekly report, windows
 * before the first shift recorded for the site in the data are ignored (a new site is not
 * reported as unguarded for the days before it went live).
 */
export function uncoveredShiftWindows(site: Site, shifts: readonly ShiftRow[], fromMs: number, now: number): UncoveredWindow[] {
  const siteShifts = shifts.filter((s) => s.site_id === site.id);
  if (siteShifts.length === 0) return [];
  const firstStart = Math.min(
    ...siteShifts.map((s) => toMs(s.actual_start) ?? toMs(s.scheduled_start) ?? Number.POSITIVE_INFINITY)
  );
  const from = Math.max(fromMs, firstStart);
  if (!Number.isFinite(from) || from > now) return [];

  const presence = siteShifts.map((s) => {
    const start = toMs(s.actual_start) ?? toMs(s.scheduled_start) ?? 0;
    const end = toMs(s.actual_end) ?? (isOpenShift(s) ? now : Math.min(now, toMs(s.scheduled_end) ?? now));
    return { start, end: Math.max(start, end) };
  });

  const out: UncoveredWindow[] = [];
  let date = addDaysToDateString(sastDateString(from), -1);
  const lastDate = sastDateString(now);
  for (let guard = 0; guard < 400 && date <= lastDate; guard++) {
    for (const shiftType of ['day', 'night'] as const) {
      let bounds: { startTime: number; endTime: number };
      try {
        bounds = calculateShiftBounds(
          date,
          shiftType,
          site.dayShiftStart,
          site.dayShiftEnd,
          site.nightShiftStart,
          site.nightShiftEnd
        );
      } catch {
        return [];
      }
      if (bounds.startTime < from || bounds.startTime > now) continue;
      const windowEnd = Math.min(bounds.endTime, now);
      const covered = presence.some((p) => p.start < windowEnd && p.end > bounds.startTime);
      if (!covered) out.push({ siteId: site.id, shiftType, date, start: bounds.startTime, end: bounds.endTime });
    }
    date = addDaysToDateString(date, 1);
  }
  return out.sort((a, b) => b.start - a.start);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** When the vehicle passed the gate: an OUT row's event time is its exit. */
export function gateEventMs(row: Pick<GateRow, 'direction' | 'entry_time' | 'exit_time'>): number | null {
  if (row.direction === 'out') return toMs(row.exit_time) ?? toMs(row.entry_time);
  return toMs(row.entry_time);
}

export interface VehicleOnSite {
  entry: GateRow;
  enteredAt: number;
  dwellMs: number;
}

export interface VehiclePresence {
  /** IN entries with no exit linked to them. */
  onSite: VehicleOnSite[];
  /**
   * IN entries without a linked exit, but an unlinked OUT of the same plate was logged later
   * at the same site. Probably left; shown separately so nobody assumes either way.
   */
  unlinkedExit: Array<VehicleOnSite & { exit: GateRow }>;
}

export function vehiclePresence(rows: readonly GateRow[], now: number): VehiclePresence {
  const linked = new Set(rows.filter((r) => r.direction === 'out' && r.linked_entry_id).map((r) => r.linked_entry_id));
  const unlinkedOuts = rows.filter((r) => r.direction === 'out' && !r.linked_entry_id);
  const onSite: VehicleOnSite[] = [];
  const unlinkedExit: Array<VehicleOnSite & { exit: GateRow }> = [];
  for (const row of rows) {
    if (row.direction !== 'in' || linked.has(row.id)) continue;
    const enteredAt = toMs(row.entry_time);
    if (enteredAt === null) continue;
    const plate = normalizePlate(row.license_plate);
    const exit = unlinkedOuts
      .filter((out) => out.site_id === row.site_id && normalizePlate(out.license_plate) === plate)
      .filter((out) => (gateEventMs(out) ?? -Infinity) >= enteredAt)
      .sort((a, b) => (gateEventMs(a) ?? 0) - (gateEventMs(b) ?? 0))[0];
    const item = { entry: row, enteredAt, dwellMs: Math.max(0, now - enteredAt) };
    if (exit) unlinkedExit.push({ ...item, exit });
    else onSite.push(item);
  }
  onSite.sort((a, b) => a.enteredAt - b.enteredAt);
  unlinkedExit.sort((a, b) => a.enteredAt - b.enteredAt);
  return { onSite, unlinkedExit };
}

// ---------------------------------------------------------------------------
// SOS and incidents
// ---------------------------------------------------------------------------

export interface PanicGroups {
  active: PanicRow[];
  acknowledged: PanicRow[];
  resolved: PanicRow[];
}

export function splitPanicAlerts(rows: readonly PanicRow[]): PanicGroups {
  const byNewest = [...rows].sort((a, b) => (toMs(b.triggered_at) ?? 0) - (toMs(a.triggered_at) ?? 0));
  return {
    active: byNewest.filter((r) => r.status === 'active'),
    acknowledged: byNewest.filter((r) => r.status === 'acknowledged'),
    resolved: byNewest.filter((r) => r.status === 'resolved')
  };
}

/** How long after the trigger the SOS reached the server (null when not notably late). */
export function sosDeliveryDelayMs(row: Pick<PanicRow, 'triggered_at' | 'created_at'>): number | null {
  const triggered = toMs(row.triggered_at);
  const received = toMs(row.created_at);
  if (triggered === null || received === null) return null;
  const delay = received - triggered;
  return delay >= LATE_SOS_MS ? delay : null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<string, number> = { reported: 0, acknowledged: 1, investigating: 2, resolved: 3 };

/** Open incidents first (new before handled, severe before minor), then newest first. */
export function sortIncidents(rows: readonly IncidentRow[]): IncidentRow[] {
  return [...rows].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
      (a.status === 'resolved' ? 0 : (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)) ||
      (toMs(b.reported_at) ?? 0) - (toMs(a.reported_at) ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type ActivityKind = 'scan' | 'incident' | 'panic' | 'gate_in' | 'gate_out' | 'shift_start' | 'shift_end';

export interface ActivityItem {
  key: string;
  kind: ActivityKind;
  at: number;
  siteId: string;
  guardId: string;
  /** Checkpoint name (scan), plate (gate), incident type code (incident). */
  detail: string | null;
  tone: Tone;
  /** Scans: the server's GPS verdict (shown as text, never by colour alone). */
  gpsConfidence?: ScanRow['gps_confidence'];
}

export function buildActivityFeed(
  snapshot: Pick<OpsSnapshot, 'shifts' | 'scans' | 'checkpoints' | 'incidents' | 'panicAlerts' | 'gateEntries'>,
  limit = 30
): ActivityItem[] {
  const names = new Map(snapshot.checkpoints.map((cp) => [cp.id, cp.name]));
  const siteOfShift = new Map(snapshot.shifts.map((s) => [s.id, s.site_id]));
  const items: ActivityItem[] = [];
  for (const shift of snapshot.shifts) {
    const start = toMs(shift.actual_start);
    if (start !== null) {
      items.push({ key: `shift-start-${shift.id}`, kind: 'shift_start', at: start, siteId: shift.site_id, guardId: shift.guard_id, detail: null, tone: 'muted' });
    }
    const end = toMs(shift.actual_end);
    if (end !== null) {
      items.push({ key: `shift-end-${shift.id}`, kind: 'shift_end', at: end, siteId: shift.site_id, guardId: shift.guard_id, detail: null, tone: 'muted' });
    }
  }
  for (const scan of snapshot.scans) {
    const at = toMs(scan.scan_timestamp_device);
    if (at === null) continue;
    items.push({
      key: `scan-${scan.id}`,
      kind: 'scan',
      at,
      siteId: scan.site_id ?? siteOfShift.get(scan.shift_id) ?? '',
      guardId: scan.guard_id,
      detail: names.get(scan.checkpoint_id) ?? null,
      tone: confidenceTone(scan.gps_confidence),
      gpsConfidence: scan.gps_confidence
    });
  }
  for (const incident of snapshot.incidents) {
    const at = toMs(incident.reported_at);
    if (at === null) continue;
    items.push({ key: `incident-${incident.id}`, kind: 'incident', at, siteId: incident.site_id, guardId: incident.guard_id, detail: incident.incident_type, tone: 'warning' });
  }
  for (const alert of snapshot.panicAlerts) {
    const at = toMs(alert.triggered_at);
    if (at === null) continue;
    items.push({ key: `panic-${alert.id}`, kind: 'panic', at, siteId: alert.site_id, guardId: alert.guard_id, detail: null, tone: 'danger' });
  }
  for (const row of snapshot.gateEntries) {
    const at = gateEventMs(row);
    if (at === null) continue;
    items.push({
      key: `gate-${row.id}`,
      kind: row.direction === 'out' ? 'gate_out' : 'gate_in',
      at,
      siteId: row.site_id,
      guardId: row.guard_id,
      detail: row.license_plate,
      tone: 'muted'
    });
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Most recent activity per guard (device time of the latest event that reached the server). */
export function lastActivityByGuard(
  snapshot: Pick<OpsSnapshot, 'shifts' | 'scans' | 'checkpoints' | 'incidents' | 'panicAlerts' | 'gateEntries'>
): Map<string, ActivityItem> {
  const map = new Map<string, ActivityItem>();
  for (const item of buildActivityFeed(snapshot, Number.POSITIVE_INFINITY)) {
    if (!map.has(item.guardId)) map.set(item.guardId, item);
  }
  return map;
}
