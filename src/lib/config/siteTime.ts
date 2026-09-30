/**
 * Site time zone.
 *
 * Every Eagle Eye site is in South Africa: the shift times configured on a site
 * (sites.day_shift_start …) and every time shown to guards and supervisors are SAST.
 * SAST is a fixed UTC+02:00 (no daylight saving since 1944), so conversions use a constant
 * offset and never depend on the phone's own time-zone setting (budget phones after a reset,
 * or with automatic time zone switched off, often run on UTC).
 */

export const SITE_TIME_ZONE = 'Africa/Johannesburg';
export const SAST_OFFSET_MS = 2 * 3600000;
export const DAY_MS = 86400000;

const pad = (n: number) => String(n).padStart(2, '0');

function toMs(value: number | string | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
}

/** SAST calendar date (YYYY-MM-DD) of an instant. */
export function sastDateString(value: number | string | Date): string {
  const d = new Date(toMs(value) + SAST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** SAST wall-clock time (HH:MM) of an instant. */
export function sastTimeHM(value: number | string | Date): string {
  const d = new Date(toMs(value) + SAST_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Parses a YYYY-MM-DD calendar date. Throws RangeError for malformed or impossible dates. */
export function parseDateString(dateStr: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateStr === 'string' ? dateStr : '');
  if (!m) throw new RangeError(`Invalid date: "${dateStr}"`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`Invalid date: "${dateStr}"`);
  }
  return { year, month, day };
}

/** Epoch ms of a SAST wall-clock time on a SAST calendar date. */
export function sastInstant(dateStr: string, hours: number, minutes: number): number {
  const { year, month, day } = parseDateString(dateStr);
  return Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - SAST_OFFSET_MS;
}

/** Adds whole calendar days to a YYYY-MM-DD date. */
export function addDaysToDateString(dateStr: string, days: number): string {
  const { year, month, day } = parseDateString(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
