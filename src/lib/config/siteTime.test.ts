import { describe, it } from 'node:test';
import assert from 'node:assert';
import { addDaysToDateString, parseDateString, sastDateString, sastInstant, sastTimeHM } from './siteTime';

describe('SAST site time helpers', () => {
  it('derive the SAST calendar date and time regardless of the machine time zone', () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Pacific/Auckland', 'Africa/Johannesburg']) {
        process.env.TZ = tz;
        // 22:30Z on 30 Sep is 00:30 SAST on 1 Oct.
        assert.strictEqual(sastDateString(Date.parse('2026-09-30T22:30:00Z')), '2026-10-01', tz);
        assert.strictEqual(sastTimeHM(Date.parse('2026-09-30T22:30:00Z')), '00:30', tz);
        assert.strictEqual(sastTimeHM('2026-09-30T15:50:00Z'), '17:50', tz);
        assert.strictEqual(sastInstant('2026-09-30', 18, 0), Date.parse('2026-09-30T16:00:00Z'), tz);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('adds calendar days across month and year ends', () => {
    assert.strictEqual(addDaysToDateString('2026-09-30', 1), '2026-10-01');
    assert.strictEqual(addDaysToDateString('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(addDaysToDateString('2026-03-01', -1), '2026-02-28');
  });

  it('rejects malformed and impossible dates', () => {
    assert.deepStrictEqual(parseDateString('2024-02-29'), { year: 2024, month: 2, day: 29 });
    for (const bad of ['2026-02-29', '2026-13-01', '30/09/2026', '', '2026-9-30']) {
      assert.throws(() => parseDateString(bad), RangeError, bad);
    }
  });
});
