import { ShiftType } from '@/types/models';

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

/**
 * Calculates start and end timestamps for a specific shift on a given calendar date.
 */
export function calculateShiftBounds(
  dateStr: string, // 'YYYY-MM-DD'
  shiftType: ShiftType,
  dayStart: string = '06:00',
  dayEnd: string = '18:00',
  nightStart: string = '18:00',
  nightEnd: string = '06:00'
): { startTime: number; endTime: number } {
  const [year, month, day] = dateStr.split('-').map(Number);
  const startStr = shiftType === 'day' ? dayStart : nightStart;
  const endStr = shiftType === 'day' ? dayEnd : nightEnd;

  const [sHour, sMin] = startStr.split(':').map(Number);
  const [eHour, eMin] = endStr.split(':').map(Number);

  const start = new Date(year, month - 1, day, sHour, sMin, 0, 0);
  const end = new Date(year, month - 1, day, eHour, eMin, 0, 0);

  // If end time is earlier or equal to start time, it spans past midnight into the next morning
  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1);
  }

  return { startTime: start.getTime(), endTime: end.getTime() };
}

/**
 * Determines current active shift window based on system time.
 */
export function getActiveShiftWindow(
  now: number = Date.now(),
  roundIntervalMinutes: number = 60,
  dayStart: string = '06:00',
  dayEnd: string = '18:00',
  nightStart: string = '18:00',
  nightEnd: string = '06:00'
): ShiftWindow {
  const nowDate = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;

  const yesterdayDate = new Date(now - 86400000);
  const yesterdayStr = `${yesterdayDate.getFullYear()}-${pad(yesterdayDate.getMonth() + 1)}-${pad(yesterdayDate.getDate())}`;

  const candidates: { date: string; shiftType: ShiftType }[] = [
    { date: yesterdayStr, shiftType: 'night' },
    { date: yesterdayStr, shiftType: 'day' },
    { date: todayStr, shiftType: 'day' },
    { date: todayStr, shiftType: 'night' }
  ];

  // 1. Check if current time falls strictly within any shift
  for (const cand of candidates) {
    const { startTime, endTime } = calculateShiftBounds(
      cand.date,
      cand.shiftType,
      dayStart,
      dayEnd,
      nightStart,
      nightEnd
    );
    if (now >= startTime && now < endTime) {
      const totalRounds = Math.ceil((endTime - startTime) / (roundIntervalMinutes * 60000));
      return {
        date: cand.date,
        shiftType: cand.shiftType,
        startTime,
        endTime,
        isInShift: true,
        roundIntervalMinutes,
        totalRounds
      };
    }
  }

  // 2. Default to upcoming shift
  const defaultBounds = calculateShiftBounds(
    todayStr,
    'night',
    dayStart,
    dayEnd,
    nightStart,
    nightEnd
  );
  const totalRounds = Math.ceil((defaultBounds.endTime - defaultBounds.startTime) / (roundIntervalMinutes * 60000));

  return {
    date: todayStr,
    shiftType: 'night',
    startTime: defaultBounds.startTime,
    endTime: defaultBounds.endTime,
    isInShift: false,
    roundIntervalMinutes,
    totalRounds
  };
}

/**
 * Generates all round windows for a given shift.
 */
export function generateShiftRounds(
  shiftWindow: ShiftWindow,
  currentTime: number = Date.now()
): RoundWindow[] {
  const { startTime, endTime, roundIntervalMinutes } = shiftWindow;
  const intervalMs = roundIntervalMinutes * 60000;
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
 * Formats time as HH:MM
 */
export function formatTimeHM(timestamp: number | string | Date): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
