import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  LATE_ACK_SNOOZE_MS,
  acknowledgeAlarm,
  evaluatePatrolAlarm,
  isAlarmVisible,
  triggerAlarmBeep
} from './alarm';

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

  it('uses the site round interval (90-minute rounds)', () => {
    // 80 min into a 90-minute round → 10 min left with open checkpoints → soon
    const soon = evaluatePatrolAlarm(shiftStartMs + 80 * 60000, shiftStartMs, shiftEndMs, 90, checkpointIds, [
      { checkpointId: 'CP1', timestampMs: shiftStartMs + 5 * 60000 }
    ]);
    assert.strictEqual(soon?.type, 'soon');
    assert.strictEqual(soon?.roundKey, shiftStartMs);
    // With 90-minute rounds, 95 min without a scan is not yet late (late after 100 min)
    const notLate = evaluatePatrolAlarm(shiftStartMs + 95 * 60000, shiftStartMs, shiftEndMs, 90, checkpointIds, []);
    assert.notStrictEqual(notLate?.type, 'late');
    const late = evaluatePatrolAlarm(shiftStartMs + 101 * 60000, shiftStartMs, shiftEndMs, 90, checkpointIds, []);
    assert.strictEqual(late?.type, 'late');
  });

  it('clamps the last round to the shift end', () => {
    // 12 h shift, 100-min rounds: the 8th round (700–800 min) is clamped to 720 min; 5 min before the end → soon
    const alarm = evaluatePatrolAlarm(shiftEndMs - 5 * 60000, shiftStartMs, shiftEndMs, 100, checkpointIds, [
      { checkpointId: 'CP1', timestampMs: shiftEndMs - 20 * 60000 }
    ]);
    assert.strictEqual(alarm?.type, 'soon');
    assert.strictEqual(alarm?.remainingMs, 5 * 60000);
    assert.strictEqual(alarm?.roundKey, shiftStartMs + 700 * 60000);
  });

  it('rejects a zero, negative or NaN interval instead of silently misbehaving', () => {
    for (const interval of [0, -60, Number.NaN]) {
      assert.throws(
        () => evaluatePatrolAlarm(shiftStartMs + 1, shiftStartMs, shiftEndMs, interval, checkpointIds, []),
        RangeError
      );
    }
  });

  it('acknowledging hides a soon alarm for that round only and snoozes a late alarm for 5 minutes', () => {
    const now = shiftStartMs + 55 * 60000;
    const soon = evaluatePatrolAlarm(now, shiftStartMs, shiftEndMs, 60, checkpointIds, [])!;
    assert.ok(soon);
    const ack = acknowledgeAlarm({ ...soon, type: 'soon' }, {}, now);
    assert.strictEqual(isAlarmVisible({ ...soon, type: 'soon' }, ack, now), false);
    assert.strictEqual(isAlarmVisible({ type: 'soon', roundKey: soon.roundKey! + 3600000 }, ack, now), true);

    const late = { type: 'late' as const, sinceMs: 80 * 60000 };
    const lateAck = acknowledgeAlarm(late, ack, now);
    assert.strictEqual(isAlarmVisible(late, lateAck, now + LATE_ACK_SNOOZE_MS - 1), false);
    assert.strictEqual(isAlarmVisible(late, lateAck, now + LATE_ACK_SNOOZE_MS), true);
    assert.strictEqual(isAlarmVisible(null, {}, now), false);
  });

  it('throttles late and soon beeps separately; force always plays (device test)', () => {
    assert.strictEqual(triggerAlarmBeep(false), true);
    assert.strictEqual(triggerAlarmBeep(false), false, 'second soon beep is throttled');
    assert.strictEqual(triggerAlarmBeep(true), true, 'a late beep is not blocked by a recent soon beep');
    assert.strictEqual(triggerAlarmBeep(true), false);
    assert.strictEqual(triggerAlarmBeep(true, true), true, 'manual test tone is never throttled');
  });

  it('plays the tone once a suspended audio context has resumed (resume() is asynchronous)', async () => {
    let oscillators = 0;
    class FakeAudioContext {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve().then(() => {
          this.state = 'running';
        });
      }
      createOscillator() {
        oscillators++;
        return { type: '', frequency: { value: 0 }, connect: () => undefined, start: () => undefined, stop: () => undefined };
      }
      createGain() {
        return { gain: { setValueAtTime: () => undefined }, connect: () => undefined };
      }
    }
    const g = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in g;
    g.window = { AudioContext: FakeAudioContext };
    try {
      assert.strictEqual(triggerAlarmBeep(true, true), true);
      assert.strictEqual(oscillators, 0, 'not running yet');
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(oscillators, 1, 'the beep is played after resume, not dropped');
    } finally {
      if (hadWindow) g.window = undefined;
      else delete g.window;
    }
  });
});

