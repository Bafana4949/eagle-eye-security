import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateShiftBounds,
  determineShiftForClockIn,
  generateShiftRounds,
  getActiveShiftWindow,
  formatTimeHM,
  formatDuration,
  parseTimeOfDay,
  type SiteShiftConfig
} from './shiftCalculator';

// Expectations are SAST wall-clock instants (UTC+2), independent of the machine's time zone.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 2, mi);

/** Runs fn with process.env.TZ temporarily set (Node applies TZ changes at runtime). */
function withTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('Shift and Round Calculations', () => {
  it('calculates daytime shift bounds correctly on same day', () => {
    const { startTime, endTime } = calculateShiftBounds('2026-09-30', 'day', '06:00', '18:00');
    assert.strictEqual(startTime, at(2026, 9, 30, 6));
    assert.strictEqual(endTime, at(2026, 9, 30, 18));
  });

  it('calculates nighttime shift bounds spanning across midnight', () => {
    const { startTime, endTime } = calculateShiftBounds('2026-09-30', 'night', '06:00', '18:00', '18:00', '06:00');
    assert.strictEqual(startTime, at(2026, 9, 30, 18));
    assert.strictEqual(endTime, at(2026, 10, 1, 6));
  });

  it('accepts Postgres HH:MM:SS times and rolls over year end', () => {
    const { startTime, endTime } = calculateShiftBounds('2026-12-31', 'night', '06:00:00', '18:00:00', '19:00:00', '05:00:00');
    assert.strictEqual(startTime, at(2026, 12, 31, 19));
    assert.strictEqual(endTime, at(2027, 1, 1, 5));
  });

  it('rejects malformed times and dates instead of producing NaN', () => {
    assert.throws(() => calculateShiftBounds('2026-09-30', 'day', '', '18:00'), RangeError);
    assert.throws(() => calculateShiftBounds('2026-09-30', 'day', '25:00', '18:00'), RangeError);
    assert.throws(() => calculateShiftBounds('30/09/2026', 'day'), RangeError);
    assert.throws(() => calculateShiftBounds('2026-02-30', 'day'), RangeError);
    assert.deepStrictEqual(parseTimeOfDay('06:30:00'), { hours: 6, minutes: 30 });
  });

  it('computes SAST instants even when the phone runs on UTC or another zone (audit case)', () => {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      withTimeZone(tz, () => {
        const night = calculateShiftBounds('2026-09-30', 'night', '06:00', '18:00', '18:00', '06:00');
        assert.strictEqual(new Date(night.startTime).toISOString(), '2026-09-30T16:00:00.000Z', tz);
        assert.strictEqual(new Date(night.endTime).toISOString(), '2026-10-01T04:00:00.000Z', tz);
        assert.strictEqual(formatTimeHM(night.startTime), '18:00', tz);
      });
    }
  });

  it('generates correct hourly round windows', () => {
    const shiftWindow = {
      date: '2026-09-30',
      shiftType: 'day' as const,
      startTime: at(2026, 9, 30, 6),
      endTime: at(2026, 9, 30, 18),
      isInShift: true,
      roundIntervalMinutes: 60,
      totalRounds: 12
    };

    const rounds = generateShiftRounds(shiftWindow, at(2026, 9, 30, 8, 30));
    assert.strictEqual(rounds.length, 12);
    assert.strictEqual(rounds[0].roundNumber, 1);
    assert.strictEqual(rounds[0].isPast, true);
    // Round 3 is 08:00 to 09:00
    assert.strictEqual(rounds[2].roundNumber, 3);
    assert.strictEqual(rounds[2].isCurrent, true);
    assert.strictEqual(rounds[3].isCurrent, false);
  });

  it('clamps the last round of a 90-minute schedule to the shift end', () => {
    const rounds = generateShiftRounds({ startTime: at(2026, 9, 30, 18), endTime: at(2026, 10, 1, 6), roundIntervalMinutes: 90 });
    assert.strictEqual(rounds.length, 8);
    assert.strictEqual(rounds[7].windowEnd, at(2026, 10, 1, 6));
    const r45 = generateShiftRounds({ startTime: at(2026, 9, 30, 18), endTime: at(2026, 10, 1, 6), roundIntervalMinutes: 45 });
    assert.strictEqual(r45.length, 16);
  });

  it('refuses a zero, negative or NaN round interval (was an infinite loop)', () => {
    const w = { startTime: at(2026, 9, 30, 6), endTime: at(2026, 9, 30, 18) };
    for (const roundIntervalMinutes of [0, -60, Number.NaN]) {
      assert.throws(() => generateShiftRounds({ ...w, roundIntervalMinutes }), RangeError);
    }
    assert.throws(() => getActiveShiftWindow(Date.now(), 0), RangeError);
  });

  it('getActiveShiftWindow returns the next shift due between shifts, not always night', () => {
    // Day 07–17, night 19–05. At 06:00 the next shift due is today's day shift.
    const w = getActiveShiftWindow(at(2026, 9, 30, 6), 60, '07:00', '17:00', '19:00', '05:00');
    assert.strictEqual(w.isInShift, false);
    assert.strictEqual(w.shiftType, 'day');
    assert.strictEqual(w.startTime, at(2026, 9, 30, 7));
    // At 00:30 we are inside yesterday's night shift.
    const n = getActiveShiftWindow(at(2026, 10, 1, 0, 30), 60, '07:00', '17:00', '19:00', '05:00');
    assert.strictEqual(n.isInShift, true);
    assert.strictEqual(n.shiftType, 'night');
    assert.strictEqual(n.date, '2026-09-30');
  });

  it('formats duration and time cleanly', () => {
    assert.strictEqual(formatDuration(45 * 60000), '45m');
    assert.strictEqual(formatDuration(8 * 3600000 + 15 * 60000), '8h 15m');
    const formatted = formatTimeHM(at(2026, 9, 30, 14, 25));
    assert.strictEqual(formatted, '14:25');
  });
});

describe('determineShiftForClockIn', () => {
  const standard: SiteShiftConfig = { dayShiftStart: '06:00', dayShiftEnd: '18:00', nightShiftStart: '18:00', nightShiftEnd: '06:00' };
  const gapped: SiteShiftConfig = { dayShiftStart: '07:00:00', dayShiftEnd: '17:00:00', nightShiftStart: '19:00:00', nightShiftEnd: '05:00:00' };

  it('mid-day → current day shift, no confirmation needed', () => {
    const s = determineShiftForClockIn(standard, at(2026, 9, 30, 10));
    assert.deepStrictEqual(s, {
      shiftType: 'day',
      scheduledStart: at(2026, 9, 30, 6),
      scheduledEnd: at(2026, 9, 30, 18),
      date: '2026-09-30',
      reason: 'in_window',
      alternative: null,
      needsConfirmation: false
    });
  });

  it('night guard arriving at 17:50 → tonight’s night shift (audit case), not day', () => {
    const s = determineShiftForClockIn(standard, at(2026, 9, 30, 17, 50));
    assert.strictEqual(s.shiftType, 'night');
    assert.strictEqual(s.scheduledStart, at(2026, 9, 30, 18));
    assert.strictEqual(s.scheduledEnd, at(2026, 10, 1, 6));
    assert.strictEqual(s.reason, 'early_for_next');
    assert.strictEqual(s.needsConfirmation, false);
  });

  it('picks the SAST schedule on a phone set to UTC (review reproduction: 17:50 SAST = 15:50Z)', () => {
    for (const tz of ['UTC', 'Africa/Johannesburg', 'America/Los_Angeles']) {
      const s = withTimeZone(tz, () => determineShiftForClockIn(standard, Date.parse('2026-09-30T15:50:00Z')));
      assert.strictEqual(s.shiftType, 'night', tz);
      assert.strictEqual(s.reason, 'early_for_next', tz);
      assert.strictEqual(new Date(s.scheduledStart).toISOString(), '2026-09-30T16:00:00.000Z', tz);
      assert.strictEqual(new Date(s.scheduledEnd).toISOString(), '2026-10-01T04:00:00.000Z', tz);
      assert.strictEqual(s.date, '2026-09-30', tz);
    }
  });

  it('a night guard arriving at 16:30 gets the day shift but is offered the night shift to confirm', () => {
    const s = determineShiftForClockIn(standard, at(2026, 9, 30, 16, 30));
    assert.strictEqual(s.shiftType, 'day');
    assert.strictEqual(s.reason, 'in_window');
    assert.strictEqual(s.needsConfirmation, true);
    assert.deepStrictEqual(s.alternative, {
      shiftType: 'night',
      scheduledStart: at(2026, 9, 30, 18),
      scheduledEnd: at(2026, 10, 1, 6),
      date: '2026-09-30'
    });
    // Well inside the day shift there is no plausible alternative.
    assert.strictEqual(determineShiftForClockIn(standard, at(2026, 9, 30, 15, 59)).alternative, null);
  });

  it('day guard arriving at 05:15 → today’s day shift', () => {
    const s = determineShiftForClockIn(standard, at(2026, 10, 1, 5, 15));
    assert.strictEqual(s.shiftType, 'day');
    assert.strictEqual(s.scheduledStart, at(2026, 10, 1, 6));
    assert.strictEqual(s.reason, 'early_for_next');
  });

  it('after midnight inside a night shift → the night shift that started yesterday', () => {
    const s = determineShiftForClockIn(standard, at(2026, 10, 1, 1, 30));
    assert.strictEqual(s.shiftType, 'night');
    assert.strictEqual(s.date, '2026-09-30');
    assert.strictEqual(s.scheduledStart, at(2026, 9, 30, 18));
    assert.strictEqual(s.reason, 'in_window');
  });

  it('a late night guard at 19:30 is still in the night window', () => {
    const s = determineShiftForClockIn(standard, at(2026, 9, 30, 19, 30));
    assert.strictEqual(s.shiftType, 'night');
    assert.strictEqual(s.reason, 'in_window');
  });

  it('uses the SITE times: gap between 05:00 and 07:00, early for the 07:00 day shift', () => {
    const s = determineShiftForClockIn(gapped, at(2026, 9, 30, 6, 10));
    assert.strictEqual(s.shiftType, 'day');
    assert.strictEqual(s.scheduledStart, at(2026, 9, 30, 7));
    assert.strictEqual(s.scheduledEnd, at(2026, 9, 30, 17));
    assert.strictEqual(s.reason, 'early_for_next');
  });

  it('between shifts → the NEXT shift due (never one that already ended), flagged for confirmation', () => {
    // 17:20 with day 07–17 / night 19–05: day ended 20 min ago, night starts in 100 min.
    const s = determineShiftForClockIn(gapped, at(2026, 9, 30, 17, 20));
    assert.strictEqual(s.shiftType, 'night');
    assert.strictEqual(s.reason, 'next_due');
    assert.strictEqual(s.needsConfirmation, true);
    assert.strictEqual(s.scheduledStart, at(2026, 9, 30, 19));
    // Agrees with getActiveShiftWindow at the same instant (review: the two used to contradict).
    const w = getActiveShiftWindow(at(2026, 9, 30, 17, 20), 60, '07:00', '17:00', '19:00', '05:00');
    assert.strictEqual(w.shiftType, s.shiftType);
    assert.strictEqual(w.startTime, s.scheduledStart);
    // 18:10: night starts in 50 min → early clock-in for night.
    const n = determineShiftForClockIn(gapped, at(2026, 9, 30, 18, 10));
    assert.strictEqual(n.shiftType, 'night');
    assert.strictEqual(n.reason, 'early_for_next');
  });

  it('never returns a shift whose scheduled end is not after the clock-in (review probe times)', () => {
    const wide: SiteShiftConfig = { dayShiftStart: '07:00', dayShiftEnd: '15:00', nightShiftStart: '19:00', nightShiftEnd: '03:00' };
    const cases: Array<[number, 'day' | 'night', number]> = [
      [at(2026, 9, 30, 16, 0), 'night', at(2026, 9, 30, 19)],
      [at(2026, 9, 30, 16, 30), 'night', at(2026, 9, 30, 19)],
      [at(2026, 9, 30, 16, 59), 'night', at(2026, 9, 30, 19)],
      [at(2026, 10, 1, 4, 0), 'day', at(2026, 10, 1, 7)]
    ];
    for (const [t, type, start] of cases) {
      const s = determineShiftForClockIn(wide, t);
      assert.ok(s.scheduledEnd > t, `${new Date(t).toISOString()} returned an ended shift`);
      assert.strictEqual(s.shiftType, type);
      assert.strictEqual(s.scheduledStart, start);
      assert.strictEqual(s.reason, 'next_due');
    }
    // Exhaustive sweep over a day in 5-minute steps for both configurations.
    for (const config of [standard, gapped, wide]) {
      for (let t = at(2026, 9, 30, 0); t < at(2026, 10, 1, 0); t += 5 * 60000) {
        assert.ok(determineShiftForClockIn(config, t).scheduledEnd > t);
      }
    }
  });

  it('exact boundaries: 18:00 is night, 06:00 is day', () => {
    assert.strictEqual(determineShiftForClockIn(standard, at(2026, 9, 30, 18)).shiftType, 'night');
    assert.strictEqual(determineShiftForClockIn(standard, at(2026, 10, 1, 6)).shiftType, 'day');
  });

  it('respects a custom early window (the next shift is still offered to confirm)', () => {
    const s = determineShiftForClockIn(standard, at(2026, 9, 30, 17, 50), 0);
    assert.strictEqual(s.shiftType, 'day');
    assert.strictEqual(s.reason, 'in_window');
    assert.strictEqual(s.alternative?.shiftType, 'night');
    assert.strictEqual(s.needsConfirmation, true);
  });

  it('rejects an invalid clock-in time', () => {
    assert.throws(() => determineShiftForClockIn(standard, Number.NaN), RangeError);
  });
});
