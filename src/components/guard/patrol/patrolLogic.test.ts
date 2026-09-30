import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { LocalEventRecord } from '@/lib/offline/db';
import { assessCheckpointProximity } from '@/lib/gps/haversine';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import type { Checkpoint } from '@/types/models';
import type { CheckpointScanPayload } from '@/types/offline';
import {
  DUPLICATE_SCAN_WINDOW_MS,
  ageParts,
  buildCheckpointScanPayload,
  computeRoundProgress,
  confidenceTone,
  durationParts,
  findRecentScan,
  patrolCheckpoints,
  shiftScanFromLocalEvent,
  syncTone
} from './patrolLogic';

const SHIFT_ID = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';
const MIN = 60_000;

function checkpoint(id: string, orderIndex: number, extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id,
    siteId: 'site',
    name: `Point ${id}`,
    permittedRadiusMeters: 50,
    orderIndex,
    isActive: true,
    ...extra
  };
}

function scanEvent(id: string, payload: Partial<CheckpointScanPayload>, createdAt: string): LocalEventRecord {
  return {
    id,
    userId: 'user',
    organisationId: 'org',
    siteId: 'site',
    shiftId: SHIFT_ID,
    type: 'checkpoint_scan',
    sequenceNumber: 1,
    createdAt,
    payload: {
      shiftId: SHIFT_ID,
      checkpointId: 'cp-1',
      method: 'qr',
      payloadType: 'secure_token',
      ...payload
    } as CheckpointScanPayload,
    mediaFields: []
  };
}

describe('findRecentScan (120 s duplicate suppression, reference behaviour)', () => {
  const now = Date.UTC(2026, 8, 30, 22, 0, 0);

  it('reports the same checkpoint scanned less than 120 s ago', () => {
    const scans = [{ checkpointId: 'cp-1', atMs: now - 119_999 }];
    assert.deepStrictEqual(findRecentScan(scans, 'cp-1', now), scans[0]);
  });

  it('allows the scan again once 120 s have passed', () => {
    assert.strictEqual(findRecentScan([{ checkpointId: 'cp-1', atMs: now - DUPLICATE_SCAN_WINDOW_MS }], 'cp-1', now), null);
  });

  it('only looks at the same checkpoint and uses its latest scan', () => {
    const scans = [
      { checkpointId: 'cp-2', atMs: now - 1_000 },
      { checkpointId: 'cp-1', atMs: now - 500_000 },
      { checkpointId: 'cp-1', atMs: now - 30_000 }
    ];
    assert.strictEqual(findRecentScan(scans, 'cp-1', now)?.atMs, now - 30_000);
    assert.strictEqual(findRecentScan(scans, 'cp-3', now), null);
  });

  it('treats a scan dated after now (clock stepped back) as recent', () => {
    assert.ok(findRecentScan([{ checkpointId: 'cp-1', atMs: now + 5 * MIN }], 'cp-1', now));
  });
});

describe('computeRoundProgress', () => {
  const start = Date.UTC(2026, 8, 30, 16, 0, 0); // 18:00 SAST
  const end = start + 12 * 60 * MIN;
  const checkpoints = [checkpoint('b', 2), checkpoint('a', 1), checkpoint('off', 3, { isActive: false })];

  it('lists active checkpoints of the current round in order with their first scan time', () => {
    const now = start + 90 * MIN; // round 2 (19:00–20:00 SAST)
    const progress = computeRoundProgress({
      scheduledStartMs: start,
      scheduledEndMs: end,
      roundIntervalMinutes: 60,
      checkpoints,
      scans: [
        { checkpointId: 'a', atMs: start + 30 * MIN }, // previous round: does not count
        { checkpointId: 'a', atMs: start + 70 * MIN },
        { checkpointId: 'a', atMs: start + 65 * MIN },
        { checkpointId: 'off', atMs: start + 66 * MIN }
      ],
      nowMs: now
    });
    assert.strictEqual(progress.kind, 'in_round');
    if (progress.kind !== 'in_round') return;
    assert.strictEqual(progress.roundNumber, 2);
    assert.strictEqual(progress.totalRounds, 12);
    assert.strictEqual(progress.windowStart, start + 60 * MIN);
    assert.deepStrictEqual(
      progress.items.map((item) => [item.checkpoint.id, item.scannedAtMs]),
      [
        ['a', start + 65 * MIN],
        ['b', null]
      ]
    );
    assert.strictEqual(progress.doneCount, 1);
  });

  it('says so before the shift starts and after it ends', () => {
    const base = { scheduledStartMs: start, scheduledEndMs: end, roundIntervalMinutes: 60, checkpoints, scans: [] };
    assert.deepStrictEqual(computeRoundProgress({ ...base, nowMs: start - MIN }), { kind: 'before_start', startMs: start });
    assert.deepStrictEqual(computeRoundProgress({ ...base, nowMs: end }), { kind: 'after_end', endMs: end });
  });

  it('reports an invalid round interval instead of hiding it', () => {
    const progress = computeRoundProgress({
      scheduledStartMs: start,
      scheduledEndMs: end,
      roundIntervalMinutes: 0,
      checkpoints,
      scans: [],
      nowMs: start + MIN
    });
    assert.strictEqual(progress.kind, 'config_error');
  });
});

describe('buildCheckpointScanPayload', () => {
  const cp = checkpoint('0b7f9f1e-1111-4a2b-8c3d-5e6f7a8b9c0d', 1, { latitude: -33.9, longitude: 18.4 });

  it('carries the real shift id, exactly what was read and the scan-time location', () => {
    const fix = {
      status: 'ok' as const,
      latitude: -33.9,
      longitude: 18.40005,
      accuracy: 4,
      timestamp: Date.UTC(2026, 8, 30, 20, 0, 0),
      ageMs: 1000
    };
    const assessment = assessCheckpointProximity(fix, cp);
    const payload = buildCheckpointScanPayload({
      shiftId: SHIFT_ID,
      checkpoint: cp,
      method: 'nfc',
      payloadType: 'nfc_uid',
      rawPayload: '04:A2:3B:1C:5D:80:00',
      location: eventLocationFromFix(fix),
      assessment
    });
    assert.strictEqual(payload.shiftId, SHIFT_ID);
    assert.strictEqual(payload.checkpointId, cp.id);
    assert.strictEqual(payload.rawPayload, '04:A2:3B:1C:5D:80:00');
    assert.strictEqual(payload.latitude, -33.9);
    assert.strictEqual(payload.accuracyMeters, 4);
    assert.strictEqual(payload.gpsError, null);
    assert.strictEqual(payload.gpsConfidence, 'verified');
    assert.strictEqual(payload.isValidProximity, true);
  });

  it('records a failed fix as no_fix with its error kind and no coordinates', () => {
    const fix = { status: 'permission_denied' as const, message: 'denied' };
    const assessment = assessCheckpointProximity(null, cp);
    const payload = buildCheckpointScanPayload({
      shiftId: SHIFT_ID,
      checkpoint: cp,
      method: 'qr',
      payloadType: 'secure_token',
      rawPayload: 'EE-CP-0123456789ABCDEF0123456789ABCDEF',
      location: eventLocationFromFix(fix),
      assessment
    });
    assert.strictEqual(payload.latitude, null);
    assert.strictEqual(payload.gpsError, 'permission_denied');
    assert.strictEqual(payload.gpsConfidence, 'no_fix');
    assert.strictEqual(payload.isValidProximity, false);
  });
});

describe('shiftScanFromLocalEvent', () => {
  it('maps a local scan event and its queue state', () => {
    const scan = shiftScanFromLocalEvent(
      scanEvent('e1', { checkpointId: 'cp-9', checkpointName: 'Gate', gpsConfidence: 'outside', distanceToCheckpointMeters: 140 }, '2026-09-30T20:00:00.000Z'),
      { syncState: 'failed', lastError: 'rejected' }
    );
    assert.ok(scan);
    assert.strictEqual(scan.checkpointId, 'cp-9');
    assert.strictEqual(scan.checkpointName, 'Gate');
    assert.strictEqual(scan.atMs, Date.parse('2026-09-30T20:00:00.000Z'));
    assert.strictEqual(scan.gpsConfidence, 'outside');
    assert.strictEqual(scan.distanceMeters, 140);
    assert.strictEqual(scan.syncState, 'failed');
    assert.strictEqual(scan.lastError, 'rejected');
  });

  it('never invents an upload state and ignores other event types', () => {
    const scan = shiftScanFromLocalEvent(scanEvent('e2', {}, '2026-09-30T20:00:00.000Z'));
    assert.strictEqual(scan?.syncState, 'unknown');
    const other = { ...scanEvent('e3', {}, '2026-09-30T20:00:00.000Z'), type: 'incident' as const };
    assert.strictEqual(shiftScanFromLocalEvent(other), null);
  });
});

describe('tones and formatting helpers', () => {
  it('only verified / likely GPS and synced uploads are green', () => {
    assert.strictEqual(confidenceTone('verified'), 'success');
    assert.strictEqual(confidenceTone('likely'), 'success-soft');
    assert.strictEqual(confidenceTone('low_confidence'), 'warning');
    assert.strictEqual(confidenceTone('no_fix'), 'warning');
    assert.strictEqual(confidenceTone('outside'), 'danger');
    assert.strictEqual(confidenceTone('no_reference'), 'muted');
    assert.strictEqual(syncTone('synced'), 'success');
    assert.strictEqual(syncTone('pending'), 'warning');
    assert.strictEqual(syncTone('syncing'), 'warning');
    assert.strictEqual(syncTone('failed'), 'danger');
    assert.strictEqual(syncTone('unknown'), 'muted');
  });

  it('orders patrol checkpoints and drops inactive ones', () => {
    const list = patrolCheckpoints([checkpoint('c', 3), checkpoint('x', 1, { isActive: false }), checkpoint('a', 1)]);
    assert.deepStrictEqual(
      list.map((cp) => cp.id),
      ['a', 'c']
    );
  });

  it('splits ages and durations', () => {
    assert.deepStrictEqual(ageParts(30_000), { unit: 'now', value: 0 });
    assert.deepStrictEqual(ageParts(5 * MIN), { unit: 'min', value: 5 });
    assert.deepStrictEqual(ageParts(3 * 60 * MIN), { unit: 'h', value: 3 });
    assert.deepStrictEqual(ageParts(3 * 24 * 60 * MIN), { unit: 'days', value: 3 });
    assert.deepStrictEqual(durationParts(75 * MIN), { hours: 1, minutes: 15 });
    assert.deepStrictEqual(durationParts(-5), { hours: 0, minutes: 0 });
  });
});
