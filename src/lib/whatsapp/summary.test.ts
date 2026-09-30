import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildWhatsAppLink,
  computeShiftStats,
  formatWhatsAppShiftSummary,
  normalizeSouthAfricanMobile,
  openWhatsAppLink,
  sanitizeWhatsAppNumber,
  type ShiftStatsInput,
  type WhatsAppWindowLike
} from './summary';

describe('normalizeSouthAfricanMobile', () => {
  const accepted = [
    '0821234567',
    '082 123 4567',
    '+27 82 123 4567',
    '27821234567',
    '0027821234567',
    '(082) 123-4567',
    '+27 (0)82 123 4567',
    '082.123.4567',
    '+270821234567', // trunk 0 typed after the country code
    '270821234567',
    // Documented decision: 9 national digits (mobile ranges) without the trunk 0 are accepted.
    '821234567'
  ];
  for (const input of accepted) {
    it(`accepts ${JSON.stringify(input)} → 27821234567`, () => {
      const r = normalizeSouthAfricanMobile(input);
      assert.deepStrictEqual(r, { ok: true, digits: '27821234567', e164: '+27821234567', display: '+27 82 123 4567' });
    });
  }

  const rejected: Array<[string, string]> = [
    ['012345678', 'wrong_length'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'invalid_characters'],
    ['082 123 456a', 'invalid_characters'],
    ['+44 20 7946 0958', 'not_south_african'],
    ['0044 20 7946 0958', 'not_south_african'],
    ['0123456789', 'not_mobile'], // Pretoria landline
    ['+27 12 345 6789', 'not_mobile'],
    ['08212345', 'wrong_length'],
    ['+27 82 123 45678', 'wrong_length'],
    ['12345', 'wrong_length'],
    ['++27821234567', 'invalid_characters']
  ];
  for (const [input, reason] of rejected) {
    it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      assert.deepStrictEqual(normalizeSouthAfricanMobile(input), { ok: false, reason });
    });
  }

  it('deprecated sanitizeWhatsAppNumber returns digits or an empty string', () => {
    assert.strictEqual(sanitizeWhatsAppNumber('+27-82-999-4321'), '27829994321');
    assert.strictEqual(sanitizeWhatsAppNumber('821234567'), '27821234567');
    assert.strictEqual(sanitizeWhatsAppNumber('+44 20 7946 0958'), '');
  });
});

describe('buildWhatsAppLink', () => {
  it('builds a wa.me URL with the normalised number and an encoded message', () => {
    assert.strictEqual(buildWhatsAppLink('+27 82 123 4567', 'Hello Dawie'), 'https://wa.me/27821234567?text=Hello%20Dawie');
  });
  it('round-trips emoji, newlines and URL metacharacters', () => {
    const msg = '🦅 Line 1\nA & B #2 ?x=1 100%';
    const url = new URL(buildWhatsAppLink('27821234567', msg));
    assert.strictEqual(url.host, 'wa.me');
    assert.strictEqual(url.pathname, '/27821234567');
    assert.strictEqual(url.searchParams.get('text'), msg);
  });
  it('without a recipient lets the guard pick the chat in WhatsApp', () => {
    assert.strictEqual(buildWhatsAppLink(null, 'x'), 'https://wa.me/?text=x');
  });
  it('throws for an invalid recipient instead of guessing a country code', () => {
    assert.throws(() => buildWhatsAppLink('+44 20 7946 0958', 'x'), /not_south_african/);
  });
});

describe('openWhatsAppLink', () => {
  /**
   * Behaves like a real browser: per the HTML spec window.open returns null whenever the
   * 'noopener' (or 'noreferrer') feature is given, even though the tab opened.
   */
  function specWindow(popupBlocked = false) {
    const opened: Array<{ url: string; features?: string; handle: { opener: unknown } }> = [];
    const win: WhatsAppWindowLike = {
      location: { href: 'https://eagle-eye.example/guard' },
      open(url: string, _target?: string, features?: string) {
        if (popupBlocked) return null;
        const handle = { opener: win as unknown };
        opened.push({ url, features, handle });
        return /noopener|noreferrer/i.test(features ?? '') ? null : handle;
      }
    };
    return { win, opened };
  }

  it('opens WhatsApp once in a new tab and leaves the guard app where it is (review reproduction)', () => {
    const { win, opened } = specWindow();
    const url = 'https://wa.me/27821234567?text=Shift%20summary';
    assert.strictEqual(openWhatsAppLink(url, win), 'new_window');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].url, url);
    assert.strictEqual(win.location.href, 'https://eagle-eye.example/guard', 'app tab must not navigate');
    assert.strictEqual(opened[0].handle.opener, null, 'opener reference is cut manually');
  });

  it('navigates the current tab only when the popup is really blocked', () => {
    const { win, opened } = specWindow(true);
    const url = 'https://wa.me/?text=x';
    assert.strictEqual(openWhatsAppLink(url, win), 'same_tab');
    assert.strictEqual(opened.length, 0);
    assert.strictEqual(win.location.href, url);
  });

  it('reports unavailable outside a browser', () => {
    assert.strictEqual(openWhatsAppLink('https://wa.me/?text=x', null), 'unavailable');
  });
});

// Night shift 30 Sep 18:00 → 1 Oct 06:00 (SAST, UTC+2), 60-minute rounds, 3 checkpoints.
const T = (iso: string) => Date.parse(iso);
const START = '2026-09-30T16:00:00.000Z'; // 18:00 SAST
const END = '2026-10-01T04:00:00.000Z'; // 06:00 SAST
const min = (m: number) => T(START) + m * 60000;

function baseInput(over: Partial<ShiftStatsInput> = {}): ShiftStatsInput {
  return {
    siteName: 'Hoofplaas',
    guardName: 'Thabo Mokoena',
    shift: { id: 'shift-1', shiftType: 'night', scheduledStart: START, scheduledEnd: END, actualStart: min(-5), actualEnd: END },
    roundIntervalMinutes: 60,
    checkpoints: [
      { id: 'a', name: 'Main gate', isActive: true },
      { id: 'b', name: 'Sheep kraal', isActive: true },
      { id: 'c', name: 'Borehole', isActive: true },
      { id: 'z', name: 'Retired point', isActive: false }
    ],
    scans: [],
    incidents: [],
    panicAlerts: [],
    gateEntries: [],
    pendingUploadCount: 0,
    failedUploadCount: 0,
    now: T(END) + 60000,
    ...over
  };
}

describe('computeShiftStats (from real events)', () => {
  it('reports 0% compliance, every miss and a 12 h gap when nothing was scanned', () => {
    const s = computeShiftStats(baseInput());
    assert.strictEqual(s.roundsScheduled, 12);
    assert.strictEqual(s.roundsDue, 12);
    assert.strictEqual(s.roundsCompleted, 0);
    assert.strictEqual(s.expectedCheckpointVisits, 36);
    assert.strictEqual(s.checkpointVisits, 0);
    assert.strictEqual(s.completionPercent, 0);
    assert.strictEqual(s.totalScans, 0);
    assert.strictEqual(s.longestGapMs, 12 * 3600000);
    assert.deepStrictEqual(
      s.missedByCheckpoint.map((m) => [m.name, m.missedCount]),
      [['Main gate', 12], ['Sheep kraal', 12], ['Borehole', 12]]
    );
  });

  it('completion is null when no round is due yet (clock-in before the schedule starts)', () => {
    const s = computeShiftStats(baseInput({ shift: { ...baseInput().shift, actualEnd: null }, now: min(-10) }));
    assert.strictEqual(s.roundsDue, 0);
    assert.strictEqual(s.completionPercent, null);
    assert.strictEqual(s.longestGapStart, null);
  });

  it('computes rounds, per-round misses, GPS breakdown, gap and event counts', () => {
    const scans: ShiftStatsInput['scans'] = [
      // Round 1 (18:00–19:00): all three
      { checkpointId: 'a', timestamp: min(5), gpsConfidence: 'verified' },
      { checkpointId: 'b', timestamp: min(15), gpsConfidence: 'likely' },
      { checkpointId: 'c', timestamp: min(25), gpsConfidence: 'low_confidence' },
      // Round 2 (19:00–20:00): a twice, b; c missed
      { checkpointId: 'a', timestamp: min(65), gpsConfidence: 'outside' },
      { checkpointId: 'a', timestamp: min(70), gpsConfidence: 'verified' },
      { checkpointId: 'b', timestamp: min(80), gpsConfidence: 'no_fix' },
      // Round 5 (22:00–23:00): all three, one without classification (not yet synced)
      { checkpointId: 'a', timestamp: min(245), gpsConfidence: 'verified' },
      { checkpointId: 'b', timestamp: min(250), gpsConfidence: 'no_reference' },
      { checkpointId: 'c', timestamp: new Date(min(255)).toISOString() },
      // Scan of a retired point does not count towards the expected visits
      { checkpointId: 'z', timestamp: min(256), gpsConfidence: 'verified' }
    ];
    const s = computeShiftStats(
      baseInput({
        scans,
        incidents: [{ timestamp: min(100) }, { timestamp: min(300) }],
        panicAlerts: [{ timestamp: min(301) }],
        gateEntries: [
          { timestamp: min(10), direction: 'in' },
          { timestamp: min(20), direction: 'in' },
          { timestamp: min(200), direction: 'out' }
        ],
        pendingUploadCount: 3
      })
    );
    assert.strictEqual(s.roundsDue, 12);
    assert.strictEqual(s.roundsCompleted, 2);
    assert.strictEqual(s.checkpointVisits, 3 + 2 + 3);
    assert.strictEqual(s.expectedCheckpointVisits, 36);
    assert.strictEqual(s.completionPercent, Math.round((8 / 36) * 100));
    assert.deepStrictEqual(s.missedByRound[0], {
      roundNumber: 2,
      windowStart: min(60),
      windowEnd: min(120),
      missedCheckpoints: ['Borehole']
    });
    assert.strictEqual(s.missedByRound.length, 10);
    assert.strictEqual(s.totalScans, 10);
    assert.strictEqual(s.scansVerified, 4);
    assert.strictEqual(s.scansLikely, 1);
    assert.strictEqual(s.scansLowConfidence, 1);
    assert.strictEqual(s.scansOutsideRadius, 1);
    assert.strictEqual(s.scansNoGps, 1);
    assert.strictEqual(s.scansNoReference, 1);
    assert.strictEqual(s.scansUnclassified, 1);
    // Longest gap: last scan 22:16 → 06:00
    assert.strictEqual(s.longestGapStart, min(256));
    assert.strictEqual(s.longestGapEnd, T(END));
    assert.strictEqual(s.longestGapMs, T(END) - min(256));
    assert.strictEqual(s.incidentCount, 2);
    assert.strictEqual(s.sosCount, 1);
    assert.strictEqual(s.vehiclesIn, 2);
    assert.strictEqual(s.vehiclesOut, 1);
    assert.strictEqual(s.pendingUploadCount, 3);
  });

  it('an early clock-out is judged against the whole schedule (rounds after it are not covered)', () => {
    const s = computeShiftStats(
      baseInput({
        shift: { ...baseInput().shift, actualEnd: new Date(min(150)).toISOString() },
        scans: [
          { checkpointId: 'a', timestamp: min(1), gpsConfidence: 'verified' },
          { checkpointId: 'b', timestamp: min(2), gpsConfidence: 'verified' },
          { checkpointId: 'c', timestamp: min(3), gpsConfidence: 'verified' }
        ]
      })
    );
    assert.strictEqual(s.periodEnd, T(END));
    assert.strictEqual(s.roundsDue, 12);
    assert.strictEqual(s.roundsCompleted, 1);
    assert.strictEqual(s.completionPercent, Math.round((3 / 36) * 100));
    assert.strictEqual(s.leftEarlyMs, T(END) - min(150));
    // Rounds starting at 21:00 or later (after the 20:30 clock-out): 9 of 12.
    assert.strictEqual(s.roundsAfterClockOut, 9);
    assert.strictEqual(s.roundInProgress, null);
  });

  it('review reproduction: patrols 18:00–22:00 perfectly, clocks out at 22:00 → not 100 %', () => {
    // 2 checkpoints, every round 18:00–22:00 scanned, clock-out at 22:00 of an 18:00–06:00 shift.
    const scans: Array<ShiftStatsInput['scans'][number]> = [];
    for (let r = 0; r < 4; r++) {
      scans.push({ checkpointId: 'a', timestamp: min(r * 60 + 5), gpsConfidence: 'verified' });
      scans.push({ checkpointId: 'b', timestamp: min(r * 60 + 10), gpsConfidence: 'verified' });
    }
    const input = (now: number) =>
      baseInput({
        shift: { ...baseInput().shift, actualEnd: min(240) },
        checkpoints: [
          { id: 'a', name: 'Main gate', isActive: true },
          { id: 'b', name: 'Sheep kraal', isActive: true }
        ],
        scans,
        now
      });
    // Prepared at 07:00 the next morning, and right at clock-out (the usual flow).
    for (const now of [T(END) + 3600000, min(240)]) {
      const s = computeShiftStats(input(now));
      assert.strictEqual(s.roundsDue, 12);
      assert.strictEqual(s.roundsCompleted, 4);
      assert.strictEqual(s.completionPercent, 33);
      assert.strictEqual(s.roundsAfterClockOut, 8);
      assert.strictEqual(s.leftEarlyMs, 8 * 3600000);
      assert.strictEqual(s.longestGapStart, min(190));
      assert.strictEqual(s.longestGapEnd, T(END));
      assert.deepStrictEqual(
        s.missedByCheckpoint.map((m) => [m.name, m.missedCount]),
        [['Main gate', 8], ['Sheep kraal', 8]]
      );
      const text = formatWhatsAppShiftSummary(s);
      assert.ok(text.includes('Compliance: 33% (8/24)'), text);
      assert.ok(text.includes('Complete rounds: 4/12'), text);
      assert.ok(text.includes('Clocked out early: 8h 00m – 8 rounds not covered'), text);
      assert.ok(!text.includes('100%'));
    }
  });

  it('the open round of an unfinished shift is "in progress", not missed', () => {
    // 5 minutes into the shift, 1 of 3 points scanned.
    const s = computeShiftStats(
      baseInput({
        shift: { ...baseInput().shift, actualEnd: null },
        scans: [{ checkpointId: 'a', timestamp: min(2), gpsConfidence: 'verified' }],
        now: min(5)
      })
    );
    assert.strictEqual(s.roundsDue, 0);
    assert.strictEqual(s.completionPercent, null);
    assert.deepStrictEqual(s.missedByCheckpoint, []);
    assert.deepStrictEqual(s.roundInProgress, {
      roundNumber: 1,
      windowStart: min(0),
      windowEnd: min(60),
      visitedCount: 1,
      openCheckpoints: ['Sheep kraal', 'Borehole']
    });
    const text = formatWhatsAppShiftSummary(s);
    assert.ok(text.includes('Round in progress 18:00–19:00: 1/3'), text);
    assert.ok(text.includes('Missed: none'), text);

    // 90 minutes in: round 1 closed (judged), round 2 open.
    const later = computeShiftStats(
      baseInput({
        shift: { ...baseInput().shift, actualEnd: null },
        scans: [{ checkpointId: 'a', timestamp: min(2), gpsConfidence: 'verified' }],
        now: min(90)
      })
    );
    assert.strictEqual(later.roundsDue, 1);
    assert.strictEqual(later.roundInProgress?.roundNumber, 2);
    assert.strictEqual(later.completionPercent, 33);
    assert.strictEqual(later.leftEarlyMs, 0);
  });

  it("uses the site's round interval", () => {
    const s = computeShiftStats(baseInput({ roundIntervalMinutes: 90 }));
    assert.strictEqual(s.roundsScheduled, 8);
    const s45 = computeShiftStats(baseInput({ roundIntervalMinutes: 45 }));
    assert.strictEqual(s45.roundsScheduled, 16);
  });

  it('rejects an invalid interval or schedule', () => {
    assert.throws(() => computeShiftStats(baseInput({ roundIntervalMinutes: 0 })), RangeError);
    assert.throws(() => computeShiftStats(baseInput({ roundIntervalMinutes: Number.NaN })), RangeError);
    assert.throws(
      () => computeShiftStats(baseInput({ shift: { ...baseInput().shift, scheduledEnd: START } })),
      RangeError
    );
  });
});

describe('formatWhatsAppShiftSummary', () => {
  const sast = (ms: number) => new Date(ms + 2 * 3600000).toISOString().slice(11, 16);
  const sastDate = (ms: number) => new Date(ms + 2 * 3600000).toISOString().slice(0, 10);
  const stats = computeShiftStats(
    baseInput({
      scans: [
        { checkpointId: 'a', timestamp: min(5), gpsConfidence: 'verified' },
        { checkpointId: 'b', timestamp: min(15), gpsConfidence: 'outside' },
        { checkpointId: 'c', timestamp: min(25), gpsConfidence: 'no_fix' }
      ],
      incidents: [{ timestamp: min(30) }],
      panicAlerts: [],
      gateEntries: [{ timestamp: min(40), direction: 'in' }],
      pendingUploadCount: 2,
      failedUploadCount: 1
    })
  );

  it('prints the real figures', () => {
    const text = formatWhatsAppShiftSummary(stats, { formatTime: sast, formatDate: sastDate });
    assert.ok(text.includes('Site: Hoofplaas'));
    assert.ok(text.includes('Guard: Thabo Mokoena'));
    assert.ok(text.includes('Shift: Night shift 2026-09-30 18:00–06:00'));
    assert.ok(text.includes('On duty: 17:55 – 06:00'));
    assert.ok(text.includes('Compliance: 8% (3/36)'));
    assert.ok(text.includes('Complete rounds: 1/12'));
    assert.ok(text.includes('Scans: 3'));
    assert.ok(text.includes('Longest gap: 11h 35m (18:25–06:00)'));
    assert.ok(text.includes('Missed: Main gate x11, Sheep kraal x11, Borehole x11'));
    assert.ok(text.includes('1 verified, 0 likely, 0 low confidence, 1 away from point, 1 no GPS'));
    assert.ok(text.includes('Incidents: 1'));
    assert.ok(text.includes('SOS alerts: 0'));
    assert.ok(text.includes('Vehicles in: 1 · Vehicles out: 0'));
    assert.ok(text.includes('Uploads: 2 waiting to upload, 1 failed – needs retry'));
    assert.ok(text.includes('Prepared by the Eagle Eye app'));
  });

  it('shows "–" rather than a fabricated 100% when nothing was due', () => {
    const empty = computeShiftStats(baseInput({ shift: { ...baseInput().shift, actualEnd: null }, now: min(-1) }));
    const text = formatWhatsAppShiftSummary(empty, { formatTime: sast, formatDate: sastDate });
    assert.ok(text.includes('Compliance: –'));
    assert.ok(!text.includes('100%'));
    assert.ok(text.includes('not clocked out'));
  });

  it('never claims the summary was sent or delivered, in any language', () => {
    for (const lang of ['en', 'af', 'zu'] as const) {
      const text = formatWhatsAppShiftSummary(stats, { lang, formatTime: sast, formatDate: sastDate }).toLowerCase();
      for (const word of ['sent', 'delivered', 'gestuur', 'afgelewer', 'ithunyelwe', 'kuthunyelwe']) {
        assert.ok(!text.includes(word), `${lang} summary contains "${word}"`);
      }
    }
  });

  it('prints SAST times by default, even when the phone is set to UTC', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const text = formatWhatsAppShiftSummary(stats);
      assert.ok(text.includes('Shift: Night shift 2026-09-30 18:00–06:00'), text);
      assert.ok(text.includes('On duty: 17:55 – 06:00'), text);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('lists scans the server has not classified yet, so the breakdown adds up', () => {
    const s = computeShiftStats(
      baseInput({
        scans: [
          { checkpointId: 'a', timestamp: min(2) },
          { checkpointId: 'b', timestamp: min(3), gpsConfidence: null },
          { checkpointId: 'c', timestamp: min(4), gpsConfidence: 'verified' }
        ]
      })
    );
    const text = formatWhatsAppShiftSummary(s, { formatTime: sast, formatDate: sastDate });
    assert.ok(text.includes('Scans: 3'));
    assert.ok(text.includes('1 verified, 0 likely, 0 low confidence, 0 away from point, 0 no GPS, 2 not yet checked by server'), text);
  });

  it('localises labels (Afrikaans)', () => {
    const text = formatWhatsAppShiftSummary(stats, { lang: 'af', formatTime: sast, formatDate: sastDate });
    assert.ok(text.includes('Nakoming: 8% (3/36)'));
    assert.ok(text.includes('Skof: Nagskof'));
    assert.ok(text.includes('Voorvalle: 1'));
  });
});
