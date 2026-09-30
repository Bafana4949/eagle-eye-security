/**
 * South African Motor Vehicle Licence (MVL) Disc Barcode Parser
 * Decodes the '%'-delimited text in the PDF417 barcode on South African vehicle licence discs,
 * e.g. '%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%CJZ297GP%JYJ128C%Sedan (closed top)%TOYOTA%COROLLA%White%AHTBB3QE300012345%2ZR1234567%2019-11-30%'
 *
 * Field offsets are identical to the reference app's parseDisc(): with i = index of the MVL
 * header field (1 when the text starts with '%'):
 *   plate = i+5, register number = i+6, description = i+7, make = i+8, model = i+9,
 *   colour = i+10, VIN = i+11, engine number = i+12, expiry = first valid YYYY-MM-DD field.
 * Missing fields stay undefined; nothing is invented. The barcode is not a proof of
 * authenticity – the UI must describe a successful parse as "disc read", never "verified".
 */

import type { LicenseDiscData } from '@/types/models';

/** Header field, e.g. 'MVL1CC61' (reference app: /^MVL/i). */
const MVL_HEADER = /^MVL[0-9A-Z]*$/i;
/** AIM symbology identifier some scanners prepend to PDF417 data (']L0'…']L2'). */
const AIM_PREFIX = /^\]L\d$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ParseDiscOptions {
  /** Current instant (defaults to now); expiry is compared with this date in SAST. */
  now?: Date | number;
  /** Override "today" directly as YYYY-MM-DD (SAST). Takes precedence over `now`. */
  today?: string;
}

/** true for a real calendar date in YYYY-MM-DD form (rejects 2019-13-45, 2023-02-29 …). */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Today's calendar date in Africa/Johannesburg (SAST, UTC+2, no DST) as YYYY-MM-DD. */
export function todayInSouthAfrica(now: Date | number = Date.now()): string {
  const instant = now instanceof Date ? now : new Date(now);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const d = get('day');
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fall through: runtime without the time-zone database.
  }
  // SAST has been a fixed UTC+2 since 1944.
  return new Date(instant.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Removes all whitespace and upper-cases a registration/licence number. */
export function normalizePlate(plate: string): string {
  return (plate ?? '').replace(/\s+/g, '').toUpperCase();
}

function field(parts: string[], index: number): string | undefined {
  const value = parts[index];
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Parses a disc barcode. Returns null unless the MVL header is the first field (or the second
 * when the text starts with '%', which is the normal case).
 */
export function parseSouthAfricanLicenseDisc(
  rawBarcodeText: string,
  options: ParseDiscOptions = {}
): LicenseDiscData | null {
  if (!rawBarcodeText || typeof rawBarcodeText !== 'string') {
    return null;
  }

  const parts = rawBarcodeText.split('%').map((t) => t.trim());
  // Normal: '%MVL…' → parts[0] === '' and parts[1] is the header (an AIM symbology prefix such
  // as ']L2' is tolerated). Some decoders drop the leading '%': then parts[0] is the header.
  // Anything else (e.g. a URL or ID barcode that happens to contain '%MVL') is not a disc.
  let i: number;
  if (MVL_HEADER.test(parts[1] ?? '') && (parts[0] === '' || AIM_PREFIX.test(parts[0]))) i = 1;
  else if (MVL_HEADER.test(parts[0] ?? '')) i = 0;
  else return null;

  const plate = normalizePlate(field(parts, i + 5) ?? '');
  const expiryDate = parts.slice(i + 1).find((token) => isValidIsoDate(token));
  const today = options.today && isValidIsoDate(options.today) ? options.today : todayInSouthAfrica(options.now);

  return {
    plate,
    regNumber: field(parts, i + 6),
    description: field(parts, i + 7),
    make: field(parts, i + 8),
    model: field(parts, i + 9),
    colour: field(parts, i + 10),
    vin: field(parts, i + 11),
    engineNumber: field(parts, i + 12),
    expiryDate,
    // The expiry day itself is still valid; expired from the next SAST calendar day.
    isExpired: expiryDate !== undefined && expiryDate < today
  };
}

/** Three-way expiry state for the UI ('unknown' when no valid expiry date was found). */
export function discExpiryStatus(disc: Pick<LicenseDiscData, 'expiryDate' | 'isExpired'>): 'valid' | 'expired' | 'unknown' {
  if (!disc.expiryDate) return 'unknown';
  return disc.isExpired ? 'expired' : 'valid';
}

/** Longest value accepted by gate_entries.license_plate. */
export const MAX_PLATE_LENGTH = 50;

/**
 * Loose plausibility check for SA registration numbers (provincial formats and personalised
 * plates vary widely). Used ONLY to show a warning – never to block a guard from saving.
 * After removing spaces and dashes: 2–10 characters, letters and digits only.
 */
export function isValidSouthAfricanPlate(plate: string): boolean {
  const clean = (plate ?? '').replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(clean);
}

/** Returns a human-readable warning for an unusual plate, or null when it looks plausible. */
export function plateFormatWarning(plate: string): string | null {
  const clean = (plate ?? '').replace(/[\s-]/g, '');
  if (clean === '') return 'Registration number is empty.';
  if (clean.length > MAX_PLATE_LENGTH) return `Registration number is longer than ${MAX_PLATE_LENGTH} characters.`;
  if (/[^A-Za-z0-9]/.test(clean)) return 'Registration number contains unusual characters – check it.';
  if (clean.length < 2 || clean.length > 10) return 'Registration number has an unusual length – check it.';
  return null;
}
