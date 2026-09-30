import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  calculateShiftBounds, 
  generateShiftRounds, 
  formatTimeHM, 
  formatDuration 
} from './shiftCalculator';

describe('Shift and Round Calculations', () => {
  it('calculates daytime shift bounds correctly on same day', () => {
    const { startTime, endTime } = calculateShiftBounds('2026-09-30', 'day', '06:00', '18:00');
    const start = new Date(startTime);
    const end = new Date(endTime);

    assert.strictEqual(start.getDate(), 30);
    assert.strictEqual(start.getHours(), 6);
    assert.strictEqual(end.getDate(), 30);
    assert.strictEqual(end.getHours(), 18);
  });

  it('calculates nighttime shift bounds spanning across midnight', () => {
    const { startTime, endTime } = calculateShiftBounds('2026-09-30', 'night', '06:00', '18:00', '18:00', '06:00');
    const start = new Date(startTime);
    const end = new Date(endTime);

    assert.strictEqual(start.getDate(), 30);
    assert.strictEqual(start.getHours(), 18);
    // Next morning
    assert.strictEqual(end.getDate(), 1); // Oct 1st
    assert.strictEqual(end.getHours(), 6);
  });

  it('generates correct hourly round windows', () => {
    const shiftWindow = {
      date: '2026-09-30',
      shiftType: 'day' as const,
      startTime: new Date(2026, 8, 30, 6, 0).getTime(),
      endTime: new Date(2026, 8, 30, 18, 0).getTime(),
      isInShift: true,
      roundIntervalMinutes: 60,
      totalRounds: 12
    };

    const currentTime = new Date(2026, 8, 30, 8, 30).getTime();
    const rounds = generateShiftRounds(shiftWindow, currentTime);

    assert.strictEqual(rounds.length, 12);
    assert.strictEqual(rounds[0].roundNumber, 1);
    assert.strictEqual(rounds[0].isPast, true);
    // Round 3 is 08:00 to 09:00
    assert.strictEqual(rounds[2].roundNumber, 3);
    assert.strictEqual(rounds[2].isCurrent, true);
    assert.strictEqual(rounds[3].isCurrent, false);
  });

  it('formats duration and time cleanly', () => {
    assert.strictEqual(formatDuration(45 * 60000), '45m');
    assert.strictEqual(formatDuration(8 * 3600000 + 15 * 60000), '8h 15m');
    const formatted = formatTimeHM(new Date(2026, 8, 30, 14, 25).getTime());
    assert.strictEqual(formatted, '14:25');
  });
});
