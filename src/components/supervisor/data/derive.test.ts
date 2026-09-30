import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '@/types/models';
import {
  aggregateCompliance,
  buildActivityFeed,
  buildRoundGrid,
  buildShiftReport,
  checkpointsForPeriod,
  complianceTone,
  formatSpan,
  formatWhen,
  gateEventMs,
  lastActivityByGuard,
  personName,
  sortIncidents,
  sosDeliveryDelayMs,
  splitPanicAlerts,
  uncoveredShiftWindows,
  uploadDelayMs,
  vehiclePresence
} from './derive';
import type { CheckpointLite, GateRow, IncidentRow, PanicRow, ScanRow, ShiftRow } from './types';

const SITE_ID = '0b7c7f0e-1d4e-4e59-9d3f-6b1b6c9d0a11';
const GUARD = '5a2f0f38-8c0a-4a53-8f8a-8c4a3f7c2b01';
const SUPERVISOR = '8d3c1a55-2e4b-4a3d-9a8b-1c2d3e4f5a6b';

const site: Site = {
  id: SITE_ID,
  organisationId: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
  name: 'Test Farm',
  code: 'TF-01',
  defaultRadiusMeters: 50,
  dayShiftStart: '06:00',
  dayShiftEnd: '18:00',
  nightShiftStart: '18:00',
  nightShiftEnd: '06:00',
  roundIntervalMinutes: 60,
  policePhone: '',
  isActive: true,
  allowLegacyQr: false
};

// 2026-09-29 18:00 SAST = 16:00 UTC
const NIGHT_START = Date.UTC(2026, 8, 29, 16, 0);
const NIGHT_END = NIGHT_START + 12 * 3600000;
const iso = (ms: number) => new Date(ms).toISOString();

function checkpoint(id: string, name: string, order: number, extra: Partial<CheckpointLite> = {}): CheckpointLite {
  return { id, site_id: SITE_ID, name, order_index: order, is_active: true, deactivated_at: null, created_at: iso(NIGHT_START - 86400000), ...extra };
}

const CP_A = '11111111-aaaa-4aaa-8aaa-000000000001';
const CP_B = '11111111-aaaa-4aaa-8aaa-000000000002';
const checkpoints = [checkpoint(CP_A, 'Main gate', 1), checkpoint(CP_B, 'Dam', 2)];

function shift(extra: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    site_id: SITE_ID,
    guard_id: GUARD,
    shift_type: 'night',
    scheduled_start: iso(NIGHT_START),
    scheduled_end: iso(NIGHT_END),
    actual_start: iso(NIGHT_START + 5 * 60000),
    actual_end: null,
    status: 'active',
    ...extra
  };
}

let scanSeq = 0;
function scan(checkpointId: string, at: number, extra: Partial<ScanRow> = {}): ScanRow {
  scanSeq++;
  return {
    id: `bbbbbbbb-0000-4000-8000-${String(scanSeq).padStart(12, '0')}`,
    shift_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    site_id: SITE_ID,
    checkpoint_id: checkpointId,
    guard_id: GUARD,
    scan_timestamp_device: iso(at),
    scan_timestamp_server: iso(at + 1000),
    accuracy_meters: 8,
    distance_to_checkpoint_meters: 12,
    gps_confidence: 'verified',
    gps_error: null,
    payload_type: 'secure_token',
    payload_verified: true,
    method: 'qr',
    checkpoint_radius_meters: 50,
    ...extra
  };
}

function gate(id: string, direction: 'in' | 'out', plate: string, entry: number, extra: Partial<GateRow> = {}): GateRow {
  return {
    id,
    site_id: SITE_ID,
    guard_id: GUARD,
    direction,
    license_plate: plate,
    make_model: null,
    vehicle_colour: null,
    vehicle_description: null,
    register_number: null,
    driver_name: null,
    company: null,
    visit_reason: null,
    person_visited: null,
    is_disc_scanned: false,
    disc_expiry_date: null,
    entry_time: iso(entry),
    exit_time: null,
    dwell_duration_seconds: null,
    vehicle_photo_url: null,
    linked_entry_id: null,
    created_at: iso(entry),
    ...extra
  };
}

describe('formatting helpers', () => {
  it('formats SAST times, with the date when not today', () => {
    const now = NIGHT_START + 3600000; // 19:00 SAST on the 29th
    assert.equal(formatWhen(NIGHT_START, now), '18:00');
    assert.equal(formatWhen(NIGHT_START - 86400000, now), '2026-09-28 18:00');
    assert.equal(formatWhen(null, now), '–');
  });

  it('formats spans without going negative', () => {
    assert.equal(formatSpan(-5000), '0m');
    assert.equal(formatSpan(65 * 60000), '1h 05m');
    assert.equal(formatSpan(50 * 3600000), '2d 2h');
  });

  it('personName never invents a name', () => {
    assert.equal(personName({}, GUARD), null);
    assert.equal(personName({ [GUARD]: { id: GUARD, firstName: 'Sipho', lastName: 'Dlamini' } }, GUARD), 'Sipho Dlamini');
    assert.equal(personName({ [GUARD]: { id: GUARD, firstName: '', lastName: '' } }, GUARD), null);
  });

  it('compliance tones follow the reference thresholds', () => {
    assert.equal(complianceTone(null), 'muted');
    assert.equal(complianceTone(95), 'success');
    assert.equal(complianceTone(75), 'warning');
    assert.equal(complianceTone(40), 'danger');
  });
});

describe('scan timing', () => {
  it('computes the upload delay from server minus device time', () => {
    const at = NIGHT_START + 600000;
    assert.equal(uploadDelayMs(scan(CP_A, at, { scan_timestamp_server: iso(at + 7200000) })), 7200000);
    assert.equal(uploadDelayMs(scan(CP_A, at, { scan_timestamp_server: null })), null);
  });
});

describe('checkpointsForPeriod', () => {
  it('excludes checkpoints created after the period and keeps ones deactivated during it', () => {
    const list = [
      checkpoint(CP_A, 'A', 1),
      checkpoint(CP_B, 'B', 2, { is_active: false, deactivated_at: iso(NIGHT_START + 3600000) }),
      checkpoint('11111111-aaaa-4aaa-8aaa-000000000003', 'C', 3, { created_at: iso(NIGHT_END + 1000) }),
      checkpoint('11111111-aaaa-4aaa-8aaa-000000000004', 'D', 4, { is_active: false, deactivated_at: iso(NIGHT_START - 1000) })
    ];
    const expected = checkpointsForPeriod(list, SITE_ID, NIGHT_START, NIGHT_END);
    assert.deepEqual(
      expected.map((cp) => [cp.name, cp.isActive]),
      [
        ['A', true],
        ['B', true],
        ['D', false]
      ]
    );
  });
});

describe('buildShiftReport', () => {
  it('reports real round compliance for an open shift and no fake 100 % before anything is due', () => {
    const now = NIGHT_START + 30 * 60000;
    const report = buildShiftReport(shift(), site, checkpoints, [], now);
    assert.equal(report.problem, null);
    assert.ok(report.stats);
    assert.equal(report.stats.completionPercent, null);
    assert.equal(report.stats.roundsDue, 0);
    assert.equal(report.isOpen, true);
  });

  it('flags an overdue round when nothing was scanned for an interval plus grace', () => {
    const now = NIGHT_START + 75 * 60000;
    const report = buildShiftReport(shift(), site, checkpoints, [], now);
    assert.equal(report.alarm?.type, 'late');
  });

  it('counts completed and missed rounds from scans', () => {
    const now = NIGHT_START + 2.5 * 3600000;
    const scans = [
      scan(CP_A, NIGHT_START + 10 * 60000),
      scan(CP_B, NIGHT_START + 20 * 60000),
      scan(CP_A, NIGHT_START + 70 * 60000)
    ];
    const report = buildShiftReport(shift(), site, checkpoints, scans, now);
    assert.ok(report.stats);
    assert.equal(report.stats.roundsDue, 2);
    assert.equal(report.stats.roundsCompleted, 1);
    assert.equal(report.stats.checkpointVisits, 3);
    assert.equal(report.stats.expectedCheckpointVisits, 4);
    assert.equal(report.stats.completionPercent, 75);
    const grid = buildRoundGrid(report, now);
    assert.ok(grid);
    assert.equal(grid.rounds.length, 12);
    assert.deepEqual(
      grid.rounds.slice(0, 4).map((r) => r.state),
      ['past', 'past', 'current', 'future']
    );
    assert.equal(grid.rows[1].name, 'Dam');
    assert.equal(grid.rows[1].cells[0], NIGHT_START + 20 * 60000);
    assert.equal(grid.rows[1].cells[1], null);
  });

  it('flags an open shift long past its scheduled end (clock-out not received)', () => {
    const report = buildShiftReport(shift(), site, checkpoints, [], NIGHT_END + 2 * 3600000);
    assert.equal(report.clockOutOverdue, true);
  });

  it('reports a missing site or impossible schedule instead of numbers', () => {
    assert.equal(buildShiftReport(shift(), null, checkpoints, [], NIGHT_START).problem, 'no_site');
    const broken = shift({ scheduled_end: iso(NIGHT_START - 1000) });
    assert.equal(buildShiftReport(broken, site, checkpoints, [], NIGHT_START).problem, 'invalid_schedule');
    const badInterval = { ...site, roundIntervalMinutes: 0 };
    const report = buildShiftReport(shift(), badInterval, checkpoints, [], NIGHT_START + 3600000);
    assert.equal(report.problem, 'invalid_schedule');
    assert.equal(report.stats, null);
  });

  it('aggregates compliance only over shifts that had rounds due', () => {
    const now = NIGHT_START + 2.5 * 3600000;
    const withScans = buildShiftReport(shift(), site, checkpoints, [scan(CP_A, NIGHT_START + 10 * 60000)], now);
    const notDue = buildShiftReport(shift({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), site, checkpoints, [], NIGHT_START + 60000);
    const total = aggregateCompliance([withScans, notDue]);
    assert.equal(total.shiftsCounted, 1);
    assert.equal(total.expected, 4);
    assert.equal(total.visits, 1);
    assert.equal(total.percent, 25);
    assert.equal(aggregateCompliance([]).percent, null);
  });
});

describe('uncoveredShiftWindows', () => {
  it('lists scheduled shifts nobody clocked in for, after the first recorded shift', () => {
    const lastNight = shift({
      actual_end: iso(NIGHT_END),
      status: 'completed'
    });
    const now = NIGHT_END + 36 * 3600000; // 2026-10-01 18:00 SAST
    const windows = uncoveredShiftWindows(site, [lastNight], NIGHT_START - 5 * 86400000, now);
    // Day 30th, night 30th, day 1st and night 1st (started exactly at now) are uncovered.
    assert.deepEqual(
      windows.map((w) => `${w.date} ${w.shiftType}`),
      ['2026-10-01 night', '2026-10-01 day', '2026-09-30 night', '2026-09-30 day']
    );
  });

  it('returns nothing when the site has no shifts in the data', () => {
    assert.deepEqual(uncoveredShiftWindows(site, [], NIGHT_START - 86400000, NIGHT_END), []);
  });
});

describe('vehiclePresence', () => {
  it('keeps IN entries without a linked OUT on site and separates unlinked exits', () => {
    const t0 = NIGHT_START;
    const rows = [
      gate('c0000000-0000-4000-8000-000000000001', 'in', 'CA 123-456', t0),
      gate('c0000000-0000-4000-8000-000000000002', 'out', 'CA 123-456', t0, {
        exit_time: iso(t0 + 3600000),
        linked_entry_id: 'c0000000-0000-4000-8000-000000000001'
      }),
      gate('c0000000-0000-4000-8000-000000000003', 'in', 'ND 55 GP', t0 + 600000),
      gate('c0000000-0000-4000-8000-000000000004', 'in', 'CJZ297GP', t0 + 1200000),
      gate('c0000000-0000-4000-8000-000000000005', 'out', 'cjz 297 gp', t0 + 1800000, { exit_time: iso(t0 + 1800000) })
    ];
    const now = t0 + 2 * 3600000;
    const presence = vehiclePresence(rows, now);
    assert.deepEqual(
      presence.onSite.map((v) => v.entry.license_plate),
      ['ND 55 GP']
    );
    assert.equal(presence.onSite[0].dwellMs, now - (t0 + 600000));
    assert.deepEqual(
      presence.unlinkedExit.map((v) => v.exit.id),
      ['c0000000-0000-4000-8000-000000000005']
    );
  });

  it('uses the exit time as the event time of an OUT row', () => {
    const row = gate('c0000000-0000-4000-8000-000000000009', 'out', 'X', NIGHT_START, { exit_time: iso(NIGHT_START + 5000) });
    assert.equal(gateEventMs(row), NIGHT_START + 5000);
  });
});

describe('SOS and incidents', () => {
  const alert = (id: string, status: PanicRow['status'], at: number, extra: Partial<PanicRow> = {}): PanicRow => ({
    id,
    site_id: SITE_ID,
    shift_id: null,
    guard_id: GUARD,
    latitude: null,
    longitude: null,
    accuracy_meters: null,
    status,
    triggered_at: iso(at),
    acknowledged_by: status === 'active' ? null : SUPERVISOR,
    acknowledged_at: status === 'active' ? null : iso(at + 60000),
    resolution_notes: null,
    created_at: iso(at + 1000),
    ...extra
  });

  it('splits alerts by status, newest first, regardless of a missing shift link', () => {
    const groups = splitPanicAlerts([
      alert('d0000000-0000-4000-8000-000000000001', 'active', NIGHT_START),
      alert('d0000000-0000-4000-8000-000000000002', 'active', NIGHT_START + 60000),
      alert('d0000000-0000-4000-8000-000000000003', 'acknowledged', NIGHT_START),
      alert('d0000000-0000-4000-8000-000000000004', 'resolved', NIGHT_START)
    ]);
    assert.deepEqual(
      groups.active.map((a) => a.id.slice(-1)),
      ['2', '1']
    );
    assert.equal(groups.acknowledged.length, 1);
    assert.equal(groups.resolved.length, 1);
  });

  it('reports late SOS delivery only when it is notable', () => {
    assert.equal(sosDeliveryDelayMs(alert('d0000000-0000-4000-8000-000000000005', 'active', NIGHT_START)), null);
    const late = alert('d0000000-0000-4000-8000-000000000006', 'active', NIGHT_START, { created_at: iso(NIGHT_START + 12 * 60000) });
    assert.equal(sosDeliveryDelayMs(late), 12 * 60000);
  });

  it('sorts new incidents first, then by severity and time', () => {
    const inc = (id: string, status: IncidentRow['status'], severity: IncidentRow['severity'], at: number): IncidentRow => ({
      id,
      site_id: SITE_ID,
      shift_id: null,
      guard_id: GUARD,
      incident_type: 'fence',
      severity,
      description: null,
      latitude: null,
      longitude: null,
      accuracy_meters: null,
      status,
      reported_at: iso(at),
      acknowledged_by: null,
      acknowledged_at: null,
      supervisor_notes: null,
      created_at: iso(at)
    });
    const sorted = sortIncidents([
      inc('1', 'resolved', 'critical', NIGHT_START + 5),
      inc('2', 'investigating', 'low', NIGHT_START),
      inc('3', 'reported', 'low', NIGHT_START + 3),
      inc('4', 'reported', 'critical', NIGHT_START + 1)
    ]);
    assert.deepEqual(
      sorted.map((i) => i.id),
      ['4', '3', '2', '1']
    );
  });
});

describe('activity feed', () => {
  it('merges real events newest first and tracks each guard’s last activity', () => {
    const s = shift();
    const scans = [scan(CP_A, NIGHT_START + 10 * 60000, { gps_confidence: 'outside' })];
    const gates = [gate('c0000000-0000-4000-8000-000000000010', 'in', 'ABC123', NIGHT_START + 20 * 60000)];
    const snapshot = { shifts: [s], scans, checkpoints, incidents: [], panicAlerts: [], gateEntries: gates };
    const feed = buildActivityFeed(snapshot);
    assert.deepEqual(
      feed.map((f) => f.kind),
      ['gate_in', 'scan', 'shift_start']
    );
    assert.equal(feed[1].detail, 'Main gate');
    assert.equal(feed[1].tone, 'danger');
    assert.equal(lastActivityByGuard(snapshot).get(GUARD)?.kind, 'gate_in');
  });
});
