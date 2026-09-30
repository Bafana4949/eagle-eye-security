/**
 * WhatsApp shift summary.
 *
 * - computeShiftStats() derives every figure from the guard's REAL local events (shift,
 *   scans with their GPS confidence, incidents, SOS alerts, gate entries). Nothing is
 *   defaulted or invented: when nothing was due, completion is null ("–"), not 100%.
 *   A finished shift is judged against its whole schedule (an early clock-out leaves rounds
 *   uncovered, it does not shorten the shift); the still-open round of an unfinished shift is
 *   reported as "in progress", never as missed.
 * - Times are printed in SAST (site time), independent of the phone's time-zone setting.
 * - formatWhatsAppShiftSummary() produces the text. It is a summary PREPARED by the app on
 *   the guard's phone; the app cannot know whether WhatsApp delivered it, so the text and the
 *   UI must never claim that it was sent or delivered (use "Prepared" / "Opened in WhatsApp").
 * - buildWhatsAppLink() only builds a wa.me URL; the guard presses send inside WhatsApp.
 */

import type { GpsConfidence, ShiftType, SupportedLanguage } from '@/types/models';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';

// ---------------------------------------------------------------------------
// South African mobile numbers
// ---------------------------------------------------------------------------

export type MobileNumberRejection =
  | 'empty'
  | 'invalid_characters'
  | 'not_south_african'
  | 'wrong_length'
  | 'not_mobile';

export type NormalizedMobile =
  | { ok: true; digits: string; e164: string; display: string }
  | { ok: false; reason: MobileNumberRejection };

/**
 * Normalises a South African mobile number to international digits '27XXXXXXXXX' for wa.me.
 *
 * Accepted: 0XXXXXXXXX, 27XXXXXXXXX, +27XXXXXXXXX, 0027XXXXXXXXX, '+27 (0)82 …' / '+27 082 …'
 * (trunk 0 after the country code), with spaces, dashes, dots and brackets.
 * Also accepted (documented decision): 9 national digits without the trunk 0 when they start
 * with 6, 7 or 8 (e.g. '821234567' → '27821234567'); wa.me would otherwise read '82…' as
 * South Korea's country code.
 * The national number must be 9 digits starting with 6, 7 or 8 (SA mobile ranges); landlines,
 * foreign numbers and anything else are rejected with a reason instead of being passed through.
 */
export function normalizeSouthAfricanMobile(input: string | null | undefined): NormalizedMobile {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^[+\d\s().\-/]+$/.test(trimmed)) return { ok: false, reason: 'invalid_characters' };

  // '+27 (0)82 …' – the bracketed trunk 0 is not dialled internationally.
  const withoutTrunk = trimmed.replace(/\(\s*0\s*\)/g, '');
  const hasPlus = withoutTrunk.startsWith('+');
  if ((withoutTrunk.match(/\+/g) ?? []).length > (hasPlus ? 1 : 0)) {
    return { ok: false, reason: 'invalid_characters' };
  }
  const digits = withoutTrunk.replace(/\D/g, '');
  if (digits === '') return { ok: false, reason: 'invalid_characters' };

  let national: string;
  if (hasPlus || digits.startsWith('00')) {
    const international = hasPlus ? digits : digits.slice(2);
    if (!international.startsWith('27')) return { ok: false, reason: 'not_south_african' };
    national = international.slice(2);
    // '+27 082 …': a trunk 0 typed after the country code is dropped.
    if (national.length === 10 && national.startsWith('0')) national = national.slice(1);
  } else if (digits.startsWith('27') && digits.length === 11) {
    national = digits.slice(2);
  } else if (digits.startsWith('270') && digits.length === 12) {
    national = digits.slice(3);
  } else if (digits.startsWith('0')) {
    if (digits.length !== 10) return { ok: false, reason: 'wrong_length' };
    national = digits.slice(1);
  } else if (digits.length === 9) {
    national = digits;
  } else {
    return { ok: false, reason: digits.length > 11 ? 'not_south_african' : 'wrong_length' };
  }

  if (national.length !== 9) return { ok: false, reason: 'wrong_length' };
  if (!/^[678]/.test(national)) return { ok: false, reason: 'not_mobile' };

  const intl = `27${national}`;
  return {
    ok: true,
    digits: intl,
    e164: `+${intl}`,
    display: `+27 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`
  };
}

/**
 * @deprecated Use normalizeSouthAfricanMobile (which reports why a number is rejected).
 * Returns the normalised digits, or '' when the number is not a valid SA mobile number.
 */
export function sanitizeWhatsAppNumber(phone: string): string {
  const result = normalizeSouthAfricanMobile(phone);
  return result.ok ? result.digits : '';
}

/**
 * Builds a wa.me link. `recipient` may be a raw or already-normalised SA mobile number.
 * Pass null to let the guard choose the chat inside WhatsApp (no recipient configured).
 * Throws when a recipient is given but is not a valid SA mobile number: validate with
 * normalizeSouthAfricanMobile first and show the reason to the user.
 */
export function buildWhatsAppLink(recipient: string | null, text: string): string {
  const encoded = encodeURIComponent(text);
  if (recipient === null || recipient.trim() === '') return `https://wa.me/?text=${encoded}`;
  const normalized = normalizeSouthAfricanMobile(recipient);
  if (!normalized.ok) throw new RangeError(`Invalid South African mobile number (${normalized.reason})`);
  return `https://wa.me/${normalized.digits}?text=${encoded}`;
}

/** Structural subset of `window` used by openWhatsAppLink (injectable for tests). */
export interface WhatsAppWindowLike {
  open(url: string, target?: string, features?: string): { opener: unknown } | null;
  location: { href: string };
}

/**
 * Opens a wa.me link in a new tab/intent. Only when the popup is blocked does it navigate the
 * current tab instead (reference app behaviour).
 *
 * The 'noopener' feature must NOT be passed to window.open: with it the HTML spec makes
 * window.open return null even when the window opened, which made every call look blocked and
 * also navigate the guard's app tab (WhatsApp opened twice, the PWA left mid-shift). The opener
 * reference is cut manually instead.
 *
 * Returns how it was opened; it can NOT tell whether the message was sent – the guard must
 * press send in WhatsApp ("Opened in WhatsApp", never "Sent").
 */
export function openWhatsAppLink(
  url: string,
  win: WhatsAppWindowLike | null = typeof window !== 'undefined' ? (window as unknown as WhatsAppWindowLike) : null
): 'new_window' | 'same_tab' | 'unavailable' {
  if (!win) return 'unavailable';
  let opened: { opener: unknown } | null = null;
  try {
    opened = win.open(url, '_blank');
  } catch {
    opened = null;
  }
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      // Cross-origin by now; the new tab cannot reach the app anyway.
    }
    return 'new_window';
  }
  win.location.href = url;
  return 'same_tab';
}

/**
 * Copies summary text to user clipboard
 */
export async function copySummaryToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below (e.g. permission denied or insecure context)
    }
  }

  if (typeof document === 'undefined') return false;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
  }
}

// ---------------------------------------------------------------------------
// Shift statistics
// ---------------------------------------------------------------------------

type TimeInput = string | number | Date;

export interface ShiftStatsInput {
  siteName: string;
  guardName: string;
  shift: {
    id: string;
    shiftType: ShiftType;
    scheduledStart: TimeInput;
    scheduledEnd: TimeInput;
    actualStart?: TimeInput | null;
    actualEnd?: TimeInput | null;
  };
  /** The site's round interval (sites.round_interval_minutes). */
  roundIntervalMinutes: number;
  /** The site's checkpoints; inactive ones are not expected. */
  checkpoints: ReadonlyArray<{ id: string; name: string; isActive?: boolean }>;
  /** This shift's scans (caller filters by shift id). */
  scans: ReadonlyArray<{ checkpointId: string; timestamp: TimeInput; gpsConfidence?: GpsConfidence | null }>;
  /** Events recorded by this guard during this shift (caller filters by shift id). */
  incidents: ReadonlyArray<{ timestamp: TimeInput }>;
  panicAlerts: ReadonlyArray<{ timestamp: TimeInput }>;
  gateEntries: ReadonlyArray<{ timestamp: TimeInput; direction: 'in' | 'out' }>;
  /** Items of this guard still waiting in the offline queue (from the sync engine). */
  pendingUploadCount?: number;
  failedUploadCount?: number;
  /** Defaults to Date.now(); used for an unfinished shift. */
  now?: number;
}

export interface RoundMisses {
  roundNumber: number;
  windowStart: number;
  windowEnd: number;
  missedCheckpoints: string[];
}

/** The round of an unfinished shift whose window has not closed yet (nothing in it is "missed" yet). */
export interface RoundInProgress {
  roundNumber: number;
  windowStart: number;
  windowEnd: number;
  visitedCount: number;
  openCheckpoints: string[];
}

export interface ShiftStats {
  siteName: string;
  guardName: string;
  shiftId: string;
  shiftType: ShiftType;
  scheduledStart: number;
  scheduledEnd: number;
  actualStart: number | null;
  actualEnd: number | null;
  /**
   * Rounds are evaluated from scheduledStart up to periodEnd. A finished shift (clocked out) is
   * judged against its WHOLE schedule, so leaving early cannot raise compliance; an unfinished
   * shift is evaluated up to now.
   */
  periodEnd: number;
  roundIntervalMinutes: number;
  roundsScheduled: number;
  /** Rounds whose window has closed (for a finished shift: every scheduled round). */
  roundsDue: number;
  /** Rounds in which every active checkpoint was scanned. */
  roundsCompleted: number;
  /** Unfinished shift only: the current round, reported separately from due/missed rounds. */
  roundInProgress: RoundInProgress | null;
  /** Clocked out this long before the scheduled end (0 when not clocked out early). */
  leftEarlyMs: number;
  /** Due rounds that started at or after the clock-out, i.e. not patrolled because the guard had left. */
  roundsAfterClockOut: number;
  expectedCheckpointVisits: number;
  checkpointVisits: number;
  /** null when nothing was due yet (never shown as 100%). */
  completionPercent: number | null;
  missedByRound: RoundMisses[];
  missedByCheckpoint: Array<{ checkpointId: string; name: string; missedCount: number }>;
  totalScans: number;
  scansVerified: number;
  scansLikely: number;
  scansLowConfidence: number;
  scansOutsideRadius: number;
  scansNoGps: number;
  scansNoReference: number;
  scansUnclassified: number;
  longestGapMs: number;
  longestGapStart: number | null;
  longestGapEnd: number | null;
  incidentCount: number;
  sosCount: number;
  vehiclesIn: number;
  vehiclesOut: number;
  pendingUploadCount: number | null;
  failedUploadCount: number | null;
}

/** Upper bound on rounds per shift (48 h at 15 min); protects against a misconfigured interval. */
const MAX_ROUNDS = 192;

function toMs(value: TimeInput | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Computes shift statistics from real events. Throws RangeError on an invalid schedule. */
export function computeShiftStats(input: ShiftStatsInput): ShiftStats {
  const interval = input.roundIntervalMinutes;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError(`Invalid round interval: ${interval} minutes`);
  }
  const scheduledStart = toMs(input.shift.scheduledStart);
  const scheduledEnd = toMs(input.shift.scheduledEnd);
  if (scheduledStart === null || scheduledEnd === null || scheduledEnd <= scheduledStart) {
    throw new RangeError('Invalid shift schedule (start/end missing or end not after start)');
  }
  const ivMs = interval * 60000;
  const roundsScheduled = Math.ceil((scheduledEnd - scheduledStart) / ivMs);
  if (roundsScheduled > MAX_ROUNDS) throw new RangeError(`Too many rounds (${roundsScheduled}) for this schedule`);

  const now = input.now ?? Date.now();
  const actualStart = toMs(input.shift.actualStart);
  const actualEnd = toMs(input.shift.actualEnd);
  // A finished shift is judged against its whole schedule: rounds after an early clock-out were
  // not patrolled and count as missed (reported as roundsAfterClockOut). Using the clock-out as
  // the end would turn "patrolled 4 of 12 hours" into 100 % compliance.
  const periodEnd = actualEnd !== null ? scheduledEnd : Math.min(now, scheduledEnd);
  const roundsStarted = Math.min(roundsScheduled, Math.max(0, Math.ceil((periodEnd - scheduledStart) / ivMs)));
  const leftEarlyMs = actualEnd !== null && actualEnd < scheduledEnd ? scheduledEnd - actualEnd : 0;

  const active = input.checkpoints.filter((cp) => cp.isActive !== false);
  const scans = input.scans
    .map((s) => ({ checkpointId: s.checkpointId, at: toMs(s.timestamp), confidence: s.gpsConfidence ?? null }))
    .filter((s): s is { checkpointId: string; at: number; confidence: GpsConfidence | null } => s.at !== null)
    .sort((a, b) => a.at - b.at);

  // Round grid: first scan of each checkpoint in each round whose window has closed.
  let roundsDue = 0;
  let checkpointVisits = 0;
  let roundsCompleted = 0;
  let roundsAfterClockOut = 0;
  let roundInProgress: RoundInProgress | null = null;
  const missedByRound: RoundMisses[] = [];
  const missedCount = new Map<string, number>();
  for (let k = 0; k < roundsStarted; k++) {
    const windowStart = scheduledStart + k * ivMs;
    const windowEnd = Math.min(windowStart + ivMs, scheduledEnd);
    const visited = new Set(
      scans.filter((s) => s.at >= windowStart && s.at < windowEnd).map((s) => s.checkpointId)
    );
    const missed = active.filter((cp) => !visited.has(cp.id));
    if (windowEnd > periodEnd) {
      // Only an unfinished shift gets here: the round is still open, so nothing in it is missed yet.
      roundInProgress = {
        roundNumber: k + 1,
        windowStart,
        windowEnd,
        visitedCount: active.length - missed.length,
        openCheckpoints: missed.map((cp) => cp.name)
      };
      continue;
    }
    roundsDue++;
    if (actualEnd !== null && windowStart >= actualEnd) roundsAfterClockOut++;
    checkpointVisits += active.length - missed.length;
    if (active.length > 0 && missed.length === 0) roundsCompleted++;
    if (missed.length > 0) {
      missedByRound.push({ roundNumber: k + 1, windowStart, windowEnd, missedCheckpoints: missed.map((cp) => cp.name) });
      for (const cp of missed) missedCount.set(cp.id, (missedCount.get(cp.id) ?? 0) + 1);
    }
  }
  const expectedCheckpointVisits = roundsDue * active.length;

  // Longest gap without a scan inside [scheduledStart, periodEnd] (reference app definition).
  let longestGapMs = 0;
  let longestGapStart: number | null = null;
  let longestGapEnd: number | null = null;
  if (periodEnd > scheduledStart) {
    const points = [
      scheduledStart,
      ...scans.filter((s) => s.at > scheduledStart && s.at < periodEnd).map((s) => s.at),
      periodEnd
    ];
    for (let i = 1; i < points.length; i++) {
      const gap = points[i] - points[i - 1];
      if (gap > longestGapMs) {
        longestGapMs = gap;
        longestGapStart = points[i - 1];
        longestGapEnd = points[i];
      }
    }
  }

  const count = (c: GpsConfidence) => scans.filter((s) => s.confidence === c).length;

  return {
    siteName: input.siteName,
    guardName: input.guardName,
    shiftId: input.shift.id,
    shiftType: input.shift.shiftType,
    scheduledStart,
    scheduledEnd,
    actualStart,
    actualEnd,
    periodEnd,
    roundIntervalMinutes: interval,
    roundsScheduled,
    roundsDue,
    roundsCompleted,
    roundInProgress,
    leftEarlyMs,
    roundsAfterClockOut,
    expectedCheckpointVisits,
    checkpointVisits,
    completionPercent:
      expectedCheckpointVisits > 0 ? Math.round((checkpointVisits / expectedCheckpointVisits) * 100) : null,
    missedByRound,
    missedByCheckpoint: active
      .filter((cp) => missedCount.has(cp.id))
      .map((cp) => ({ checkpointId: cp.id, name: cp.name, missedCount: missedCount.get(cp.id) ?? 0 })),
    totalScans: scans.length,
    scansVerified: count('verified'),
    scansLikely: count('likely'),
    scansLowConfidence: count('low_confidence'),
    scansOutsideRadius: count('outside'),
    scansNoGps: count('no_fix'),
    scansNoReference: count('no_reference'),
    scansUnclassified: scans.filter((s) => s.confidence === null).length,
    longestGapMs,
    longestGapStart,
    longestGapEnd,
    incidentCount: input.incidents.filter((e) => toMs(e.timestamp) !== null).length,
    sosCount: input.panicAlerts.filter((e) => toMs(e.timestamp) !== null).length,
    vehiclesIn: input.gateEntries.filter((e) => e.direction === 'in').length,
    vehiclesOut: input.gateEntries.filter((e) => e.direction === 'out').length,
    pendingUploadCount: input.pendingUploadCount ?? null,
    failedUploadCount: input.failedUploadCount ?? null
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

interface SummaryLabels {
  title: string;
  prepared: string;
  site: string;
  guard: string;
  shift: string;
  dayShift: string;
  nightShift: string;
  customShift: string;
  onDuty: string;
  notClockedOut: string;
  completion: string;
  rounds: string;
  roundInProgress: string;
  clockedOutEarly: string;
  roundsNotCovered: string;
  scans: string;
  gap: string;
  missed: string;
  none: string;
  gpsTitle: string;
  verified: string;
  likely: string;
  lowConfidence: string;
  outside: string;
  noGps: string;
  noReference: string;
  unclassified: string;
  incidents: string;
  sos: string;
  vehiclesIn: string;
  vehiclesOut: string;
  uploads: string;
  allUploaded: string;
  waiting: string;
  failed: string;
  unknownUploads: string;
}

// Wording deliberately avoids any claim that the report was transmitted or received.
const LABELS: Record<SupportedLanguage, SummaryLabels> = {
  en: {
    title: 'EAGLE EYE – SHIFT SUMMARY',
    prepared: 'Prepared by the Eagle Eye app on the guard’s phone',
    site: 'Site',
    guard: 'Guard',
    shift: 'Shift',
    dayShift: 'Day shift',
    nightShift: 'Night shift',
    customShift: 'Custom shift',
    onDuty: 'On duty',
    notClockedOut: 'not clocked out',
    completion: 'Compliance',
    rounds: 'Complete rounds',
    roundInProgress: 'Round in progress',
    clockedOutEarly: 'Clocked out early',
    roundsNotCovered: 'rounds not covered',
    scans: 'Scans',
    gap: 'Longest gap',
    missed: 'Missed',
    none: 'none',
    gpsTitle: 'Scan location',
    verified: 'verified',
    likely: 'likely',
    lowConfidence: 'low confidence',
    outside: 'away from point',
    noGps: 'no GPS',
    noReference: 'point has no location',
    unclassified: 'not yet checked by server',
    incidents: 'Incidents',
    sos: 'SOS alerts',
    vehiclesIn: 'Vehicles in',
    vehiclesOut: 'Vehicles out',
    uploads: 'Uploads',
    allUploaded: 'all records uploaded',
    waiting: 'waiting to upload',
    failed: 'failed – needs retry',
    unknownUploads: 'unknown'
  },
  af: {
    title: 'EAGLE EYE – SKOFOPSOMMING',
    prepared: 'Opgestel deur die Eagle Eye-toep op die wag se foon',
    site: 'Perseel',
    guard: 'Wag',
    shift: 'Skof',
    dayShift: 'Dagskof',
    nightShift: 'Nagskof',
    customShift: 'Pasgemaakte skof',
    onDuty: 'Op diens',
    notClockedOut: 'nie uitgeteken nie',
    completion: 'Nakoming',
    rounds: 'Volledige rondtes',
    roundInProgress: 'Rondte aan die gang',
    clockedOutEarly: 'Vroeg uitgeteken',
    roundsNotCovered: 'rondtes nie gedek nie',
    scans: 'Skanderings',
    gap: 'Langste gaping',
    missed: 'Gemis',
    none: 'geen',
    gpsTitle: 'Skanderingsligging',
    verified: 'bevestig',
    likely: 'waarskynlik',
    lowConfidence: 'lae betroubaarheid',
    outside: 'ver van punt',
    noGps: 'geen GPS',
    noReference: 'punt het geen ligging',
    unclassified: 'nog nie deur bediener nagegaan nie',
    incidents: 'Voorvalle',
    sos: 'SOS-alarms',
    vehiclesIn: 'Voertuie in',
    vehiclesOut: 'Voertuie uit',
    uploads: 'Oplaai',
    allUploaded: 'alle rekords opgelaai',
    waiting: 'wag om op te laai',
    failed: 'misluk – probeer weer',
    unknownUploads: 'onbekend'
  },
  zu: {
    title: 'EAGLE EYE – ISIFINYEZO SESHIFU',
    prepared: 'Kulungiswe uhlelo lwe-Eagle Eye efonini yonogada',
    site: 'Indawo',
    guard: 'Unogada',
    shift: 'Ishifu',
    dayShift: 'Ishifu semini',
    nightShift: 'Ishifu sasebusuku',
    customShift: 'Ishifu ekhethekile',
    onDuty: 'Emsebenzini',
    notClockedOut: 'akakaphumi',
    completion: 'Okwenziwe',
    rounds: 'Imizuliswano ephelele',
    roundInProgress: 'Umzuliswano oqhubekayo',
    clockedOutEarly: 'Uphume ngaphambi kwesikhathi',
    roundsNotCovered: 'imizuliswano engenziwanga',
    scans: 'Okuskeniwe',
    gap: 'Igebe elide kakhulu',
    missed: 'Okuphuthiwe',
    none: 'lutho',
    gpsTitle: 'Indawo yokuskena',
    verified: 'kuqinisekisiwe',
    likely: 'kungenzeka',
    lowConfidence: 'ukwethembeka okuphansi',
    outside: 'kude nendawo',
    noGps: 'ayikho i-GPS',
    noReference: 'indawo ayinayo i-GPS',
    unclassified: 'akukahlolwa yiseva',
    incidents: 'Izehlakalo',
    sos: 'Ama-alamu e-SOS',
    vehiclesIn: 'Izimoto ezingenile',
    vehiclesOut: 'Izimoto eziphumile',
    uploads: 'Ukulayisha',
    allUploaded: 'wonke amarekhodi alayishiwe',
    waiting: 'alinde ukulayishwa',
    failed: 'kuhlulekile – zama futhi',
    unknownUploads: 'akwaziwa'
  }
};

export interface SummaryFormatOptions {
  lang?: SupportedLanguage;
  /** Formats an epoch-ms time as HH:MM (defaults to SAST, whatever the phone's time zone). */
  formatTime?: (ms: number) => string;
  /** Formats the shift date (defaults to the SAST YYYY-MM-DD of scheduledStart). */
  formatDate?: (ms: number) => string;
}

const pad = (n: number) => String(n).padStart(2, '0');
function formatGap(ms: number): string {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}

/** Formats the summary text. Wording never claims the message was transmitted or received. */
export function formatWhatsAppShiftSummary(stats: ShiftStats, options: SummaryFormatOptions = {}): string {
  const L = LABELS[options.lang ?? 'en'] ?? LABELS.en;
  const time = options.formatTime ?? sastTimeHM;
  const date = options.formatDate ?? sastDateString;
  const shiftName =
    stats.shiftType === 'day' ? L.dayShift : stats.shiftType === 'night' ? L.nightShift : L.customShift;

  const onDuty =
    stats.actualStart !== null
      ? `${time(stats.actualStart)} – ${stats.actualEnd !== null ? time(stats.actualEnd) : L.notClockedOut}`
      : null;

  const completion =
    stats.completionPercent === null
      ? '–'
      : `${stats.completionPercent}% (${stats.checkpointVisits}/${stats.expectedCheckpointVisits})`;

  const missedLine = stats.missedByCheckpoint.length
    ? stats.missedByCheckpoint.map((m) => `${m.name} x${m.missedCount}`).join(', ')
    : L.none;

  const gapLine =
    stats.longestGapStart !== null && stats.longestGapEnd !== null
      ? `${formatGap(stats.longestGapMs)} (${time(stats.longestGapStart)}–${time(stats.longestGapEnd)})`
      : '–';

  const gps = [
    `${stats.scansVerified} ${L.verified}`,
    `${stats.scansLikely} ${L.likely}`,
    `${stats.scansLowConfidence} ${L.lowConfidence}`,
    `${stats.scansOutsideRadius} ${L.outside}`,
    `${stats.scansNoGps} ${L.noGps}`
  ];
  if (stats.scansNoReference > 0) gps.push(`${stats.scansNoReference} ${L.noReference}`);
  // Scans not yet classified by the server (still queued) are listed so the breakdown adds up.
  if (stats.scansUnclassified > 0) gps.push(`${stats.scansUnclassified} ${L.unclassified}`);

  let uploads: string;
  if (stats.pendingUploadCount === null && stats.failedUploadCount === null) {
    uploads = L.unknownUploads;
  } else {
    const parts: string[] = [];
    if ((stats.pendingUploadCount ?? 0) > 0) parts.push(`${stats.pendingUploadCount} ${L.waiting}`);
    if ((stats.failedUploadCount ?? 0) > 0) parts.push(`${stats.failedUploadCount} ${L.failed}`);
    uploads = parts.length ? parts.join(', ') : L.allUploaded;
  }

  const lines = [
    `🦅 ${L.title}`,
    `${L.site}: ${stats.siteName}`,
    `${L.guard}: ${stats.guardName}`,
    `${L.shift}: ${shiftName} ${date(stats.scheduledStart)} ${time(stats.scheduledStart)}–${time(stats.scheduledEnd)}`
  ];
  if (onDuty) lines.push(`${L.onDuty}: ${onDuty}`);
  lines.push(
    '',
    `${L.completion}: ${completion}`,
    `${L.rounds}: ${stats.roundsCompleted}/${stats.roundsDue}`
  );
  if (stats.leftEarlyMs > 0) {
    lines.push(`${L.clockedOutEarly}: ${formatGap(stats.leftEarlyMs)} – ${stats.roundsAfterClockOut} ${L.roundsNotCovered}`);
  }
  if (stats.roundInProgress) {
    const r = stats.roundInProgress;
    const total = r.visitedCount + r.openCheckpoints.length;
    lines.push(`${L.roundInProgress} ${time(r.windowStart)}–${time(r.windowEnd)}: ${r.visitedCount}/${total}`);
  }
  lines.push(
    `${L.scans}: ${stats.totalScans}`,
    `${L.gap}: ${gapLine}`,
    `${L.missed}: ${missedLine}`,
    `${L.gpsTitle}: ${gps.join(', ')}`,
    '',
    `${L.incidents}: ${stats.incidentCount}`,
    `${L.sos}: ${stats.sosCount}`,
    `${L.vehiclesIn}: ${stats.vehiclesIn} · ${L.vehiclesOut}: ${stats.vehiclesOut}`,
    `${L.uploads}: ${uploads}`,
    '',
    `(${L.prepared})`
  );
  return lines.join('\n');
}
