import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluatePatrolAlarm } from './alarm';

describe('Patrol Alarm State Evaluation', () => {
  const shiftStartMs = 1770000000000; // e.g. 18:00
  const shiftEndMs = shiftStartMs + 12 * 3600000; // +12 hours (06:00)
  const intervalMinutes = 60; // 60-minute rounds
  const checkpointIds = ['CP1', 'CP2', 'CP3', 'CP4'];

  it('returns null outside of shift hours', () => {
    // 1 hour before shift
    const beforeShift = evaluatePatrolAlarm(
      shiftStartMs - 3600000,
      shiftStartMs,
      shiftEndMs,
      intervalMinutes,
      checkpointIds,
      []
    );
    assert.strictEqual(beforeShift, null);

    // 1 hour after shift
    const afterShift = evaluatePatrolAlarm(
      shiftEndMs + 3600000,
      shiftStartMs,
      shiftEndMs,
      intervalMinutes,
      checkpointIds,
      []
    );
    assert.strictEqual(afterShift, null);
  });

  it('triggers late alarm if no scan for round interval + 10 minutes', () => {
    // 72 minutes after shift start with 0 scans
    const nowMs = shiftStartMs + 72 * 60000;
    const alarm = evaluatePatrolAlarm(
      nowMs,
      shiftStartMs,
      shiftEndMs,
      intervalMinutes,
      checkpointIds,
      []
    );

    assert.ok(alarm !== null);
    assert.strictEqual(alarm?.type, 'late');
    assert.strictEqual(alarm?.sinceMs, 72 * 60000);
  });

  it('triggers soon alarm if <= 10 minutes remaining in round with open checkpoints', () => {
    // 55 minutes into 60-minute round (5 minutes left)
    const nowMs = shiftStartMs + 55 * 60000;
    const scanLog = [
      { checkpointId: 'CP1', timestampMs: shiftStartMs + 10 * 60000 },
      { checkpointId: 'CP2', timestampMs: shiftStartMs + 20 * 60000 }
    ];

    const alarm = evaluatePatrolAlarm(
      nowMs,
      shiftStartMs,
      shiftEndMs,
      intervalMinutes,
      checkpointIds,
      scanLog
    );

    assert.ok(alarm !== null);
    assert.strictEqual(alarm?.type, 'soon');
    assert.deepStrictEqual(alarm?.openCheckpoints, ['CP3', 'CP4']);
    assert.strictEqual(alarm?.remainingMs, 5 * 60000);
  });

  it('returns null if all checkpoints were completed in the current round', () => {
    const nowMs = shiftStartMs + 55 * 60000;
    const scanLog = [
      { checkpointId: 'CP1', timestampMs: shiftStartMs + 10 * 60000 },
      { checkpointId: 'CP2', timestampMs: shiftStartMs + 20 * 60000 },
      { checkpointId: 'CP3', timestampMs: shiftStartMs + 30 * 60000 },
      { checkpointId: 'CP4', timestampMs: shiftStartMs + 40 * 60000 }
    ];

    const alarm = evaluatePatrolAlarm(
      nowMs,
      shiftStartMs,
      shiftEndMs,
      intervalMinutes,
      checkpointIds,
      scanLog
    );

    assert.strictEqual(alarm, null);
  });
});
