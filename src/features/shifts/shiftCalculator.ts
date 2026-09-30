import { ShiftType } from '@/types/models';
import { DAY_MS, addDaysToDateString, parseDateString, sastDateString, sastInstant, sastTimeHM } from '@/lib/config/siteTime';

/**
 * Shift and round calculations. Times of day ('HH:MM' or Postgres 'HH:MM:SS') are the site's
 * configured times and are always interpreted as SAST (Africa/Johannesburg, fixed UTC+2),
 * NOT in the phone's time zone: a phone left on UTC must still record the right schedule.
 * Night shifts whose end is not after their start roll over past midnight.
 */

export interface ShiftWindow {
  date: string;
  shiftType: ShiftType;
  startTime: number;
  endTime: number;
  isInShift: boolean;
  roundIntervalMinutes: number;
  totalRounds: number;
}

export interface RoundWindow {
  roundNumber: number;
  windowStart: number;
  windowEnd: number;
  isCurrent: boolean;
  isPast: boolean;
}

/** The site's shift schedule (sites.day_shift_start … night_shift_end). */
export interface SiteShiftConfig {
  dayShiftStart: string;
  dayShiftEnd: string;
  nightShiftStart: string;
  nightShiftEnd: string;
}

/** One scheduled shift a guard can clock in for. */
export interface ClockInOption {
  shiftType: 'day' | 'night';
  /** Epoch ms. */
  scheduledStart: number;
  scheduledEnd: number;
  /** SAST calendar date (YYYY-MM-DD) on which the shift starts. */
  date: string;
}

export interface ClockInShift extends ClockInOption {
  /**
   * in_window: now is inside the shift; early_for_next: the shift starts within the early
   * clock-in window; next_due: between shifts, the next shift due (the guard must confirm).
   * A shift that has already ended is never returned.
   */
  reason: 'in_window' | 'early_for_next' | 'next_due';
  /**
   * The other shift the guard may plausibly be clocking in for (e.g. a night guard arriving at
   * 16:30 while the day shift still runs until 18:00). null when there is no plausible choice.
   */
  alternative: ClockInOption | null;
  /** true when the UI must show the chosen schedule and let the guard confirm or switch. */
  needsConfirmation: boolean;
}

/** A guard may clock in this long before the next shift starts. */
export const EARLY_CLOCK_IN_MINUTES = 60;
/** Inside a shift, the next shift is offered as an alternative when it starts within this time. */
export const CLOCK_IN_CONFIRM_WINDOW_MINUTES = 120;
/** Refuse schedules that would produce an absurd number of rounds (48 h at 15-minute rounds). */
const MAX_ROUNDS = 192;

/** Parses 'HH:MM' or 'HH:MM:SS'. Throws RangeError on anything else (never yields NaN). */
export function parseTimeOfDay(value: string): { hours: number; minutes: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec((value ?? '').trim());
  if (!m) throw new RangeError(`Invalid time of day: "${value}"`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new RangeError(`Invalid time of day: "${value}"`);
  return { hours, minutes };
}

/** Throws RangeError unless the round interval is a positive, finite number of minutes. */
export function assertValidRoundInterval(roundIntervalMinutes: number): void {
  if (!Number.isFinite(roundIntervalMinutes) || roundIntervalMinutes <= 0) {
    throw new RangeError(`Invalid round interval: ${roundIntervalMinutes} minutes`);
  }
}

/**
 * Calculates start and end timestamps for a specific shift on a given SAST calendar date.
 */
export function calculateShiftBounds(
  dateStr: string, // 'YYYY-MM-DD' (SAST)
  shiftType: ShiftType,
  dayStart: string = '06:00',
  dayEnd: string = '18:00',
  nightStart: string = '18:00',
  nightEnd: string = '06:00'
): { startTime: number; endTime: number } {
  parseDateString(dateStr);
  const startStr = shiftType === 'day' ? dayStart : nightStart;
  const endStr = shiftType === 'day' ? dayEnd : nightEnd;

  const s = parseTimeOfDay(startStr);
  const e = parseTimeOfDay(endStr);

  const startTime = sastInstant(dateStr, s.hours, s.minutes);
  let endTime = sastInstant(dateStr, e.hours, e.minutes);

  // If end time is earlier or equal to start time, it spans past midnight into the next morning
  // (SAST has no daylight saving, so a calendar day is always 24 h).
  if (endTime <= startTime) endTime += DAY_MS;

  return { startTime, endTime };
}

interface Candidate {
  date: string;
  shiftType: 'day' | 'night';
  startTime: number;
  endTime: number;
}

function candidateShifts(now: number, config: SiteShiftConfig): Candidate[] {
  const today = sastDateString(now);
  const out: Candidate[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = addDaysToDateString(today, offset);
    for (const shiftType of ['day', 'night'] as const) {
      const { startTime, endTime } = calculateShiftBounds(
        date,
        shiftType,
        config.dayShiftStart,
        config.dayShiftEnd,
        config.nightShiftStart,
        config.nightShiftEnd
      );
      out.push({ date, shiftType, startTime, endTime });
    }
  }
  return out;
}

/**
 * Chooses the shift a guard is clocking in for, from the SITE's configured times (SAST).
 * 1. If a shift starts within the early window (60 min) and the guard is either between shifts
 *    or in the last hour of the current one → that upcoming shift (early clock-in, e.g. the
 *    night guard arriving at 17:40 for an 18:00 start).
 * 2. Otherwise the shift whose window contains now (latest start wins if windows overlap).
 *    When the next shift starts within CLOCK_IN_CONFIRM_WINDOW_MINUTES it is offered as the
 *    `alternative` and the guard must confirm (a night guard arriving at 16:30).
 * 3. Otherwise (between shifts) the NEXT shift due, reason 'next_due', needing confirmation –
 *    the same rule as getActiveShiftWindow and the reference app.
 * A shift whose scheduled end is not after now is never returned: its rounds could no longer be
 * patrolled and the (guard-immutable) schedule would score a full patrol as 0 %.
 */
export function determineShiftForClockIn(
  siteConfig: SiteShiftConfig,
  now: number | Date = Date.now(),
  earlyWindowMinutes: number = EARLY_CLOCK_IN_MINUTES
): ClockInShift {
  const t = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(t)) throw new RangeError('Invalid clock-in time');
  const earlyMs = Math.max(0, earlyWindowMinutes) * 60000;
  const confirmMs = Math.max(earlyMs, CLOCK_IN_CONFIRM_WINDOW_MINUTES * 60000);
  const candidates = candidateShifts(t, siteConfig);

  const current = candidates
    .filter((c) => t >= c.startTime && t < c.endTime)
    .sort((a, b) => b.startTime - a.startTime)[0] as Candidate | undefined;
  // Candidates cover yesterday..tomorrow, so a later shift always exists.
  const next = candidates.filter((c) => c.startTime > t).sort((a, b) => a.startTime - b.startTime)[0];

  const option = (c: Candidate): ClockInOption => ({
    shiftType: c.shiftType,
    scheduledStart: c.startTime,
    scheduledEnd: c.endTime,
    date: c.date
  });
  const toResult = (c: Candidate, reason: ClockInShift['reason'], alternative: Candidate | null): ClockInShift => ({
    ...option(c),
    reason,
    alternative: alternative ? option(alternative) : null,
    needsConfirmation: reason === 'next_due' || alternative !== null
  });

  if (next && next.startTime - t <= earlyMs && (!current || current.endTime - t <= earlyMs)) {
    return toResult(next, 'early_for_next', null);
  }
  if (current) {
    const plausibleNext = next && next.startTime - t <= confirmMs ? next : null;
    return toResult(current, 'in_window', plausibleNext);
  }
  return toResult(next, 'next_due', null);
}

/**
 * Determines current active shift window based on system time.
 * Between shifts it returns the NEXT shift due (reference app behaviour), not always night.
 */
export function getActiveShiftWindow(
  now: number = Date.now(),
  roundIntervalMinutes: number = 60,
  dayStart: string = '06:00',
  dayEnd: string = '18:00',
  nightStart: string = '18:00',
  nightEnd: string = '06:00'
): ShiftWindow {
  assertValidRoundInterval(roundIntervalMinutes);
  const config: SiteShiftConfig = {
    dayShiftStart: dayStart,
    dayShiftEnd: dayEnd,
    nightShiftStart: nightStart,
    nightShiftEnd: nightEnd
  };
  const candidates = candidateShifts(now, config);
  const ivMs = roundIntervalMinutes * 60000;

  // If misconfigured windows overlap, the shift that started most recently wins.
  const containing = candidates
    .filter((c) => now >= c.startTime && now < c.endTime)
    .sort((a, b) => b.startTime - a.startTime)[0] as Candidate | undefined;
  const chosen =
    containing ??
    candidates.filter((c) => c.startTime > now).sort((a, b) => a.startTime - b.startTime)[0];

  return {
    date: chosen.date,
    shiftType: chosen.shiftType,
    startTime: chosen.startTime,
    endTime: chosen.endTime,
    isInShift: containing !== undefined,
    roundIntervalMinutes,
    totalRounds: Math.ceil((chosen.endTime - chosen.startTime) / ivMs)
  };
}

/**
 * Generates all round windows for a given shift.
 */
export function generateShiftRounds(
  shiftWindow: Pick<ShiftWindow, 'startTime' | 'endTime' | 'roundIntervalMinutes'>,
  currentTime: number = Date.now()
): RoundWindow[] {
  const { startTime, endTime, roundIntervalMinutes } = shiftWindow;
  assertValidRoundInterval(roundIntervalMinutes);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new RangeError('Invalid shift window');
  }
  const intervalMs = roundIntervalMinutes * 60000;
  if (Math.ceil((endTime - startTime) / intervalMs) > MAX_ROUNDS) {
    throw new RangeError('Round interval too small for this shift');
  }
  const rounds: RoundWindow[] = [];

  let currentStart = startTime;
  let roundNum = 1;

  while (currentStart < endTime) {
    const currentEnd = Math.min(currentStart + intervalMs, endTime);
    const isCurrent = currentTime >= currentStart && currentTime < currentEnd;
    const isPast = currentTime >= currentEnd;

    rounds.push({
      roundNumber: roundNum,
      windowStart: currentStart,
      windowEnd: currentEnd,
      isCurrent,
      isPast
    });

    currentStart += intervalMs;
    roundNum++;
  }

  return rounds;
}

/**
 * Formats an instant as SAST HH:MM (site time, independent of the phone's time-zone setting).
 */
export function formatTimeHM(timestamp: number | string | Date): string {
  return sastTimeHM(timestamp);
}

/**
 * Formats duration in hours and minutes (e.g. "8h 15m")
 */
export function formatDuration(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}
