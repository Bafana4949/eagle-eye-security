/**
 * Admin form validation (pure functions, no React). Error values are translation keys of the
 * admin area so the forms can show them in the admin's language. The database enforces the
 * same rules (and more); this only gives quick, specific feedback before a request is sent.
 */
import type { TranslationKey } from '@/lib/i18n/translations';
import type { Checkpoint, Site } from '@/types/models';
import { normalizeSouthAfricanMobile } from '@/lib/whatsapp/summary';
import type { CheckpointInput, SiteSettingsInput } from './adminData';

/** A GPS fix worse than this (metres) is only used after the admin confirms it. */
export const GPS_ACCEPTABLE_ACCURACY_M = 30;
export const RADIUS_MIN_M = 5;
export const RADIUS_MAX_M = 1000;
/** Offered round intervals (minutes). Values outside the list stay selectable when already stored. */
export const ROUND_INTERVAL_OPTIONS: readonly number[] = [15, 20, 30, 45, 60, 90, 120];
export const ROUND_INTERVAL_MIN = 15;
export const ROUND_INTERVAL_MAX = 720;
/** Same rule as parseCheckpointPayload for Dawie's PLAAS-CP:<code> cards. */
const LEGACY_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LEGACY_PREFIX = 'PLAAS-CP:';
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type FieldErrors<K extends string> = Partial<Record<K, TranslationKey>>;
export type Validated<T, K extends string> = { ok: true; value: T } | { ok: false; errors: FieldErrors<K> };

function toText(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseWholeNumber(text: string): number | null {
  const cleaned = text.trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

export type CoordinateResult =
  | { ok: true; latitude: number | null; longitude: number | null }
  | { ok: false; field: 'latitude' | 'longitude'; key: TranslationKey };

/** Both empty → no location; otherwise both must be valid decimal degrees. */
export function parseCoordinates(latitudeText: string, longitudeText: string): CoordinateResult {
  const latEmpty = latitudeText.trim() === '';
  const lngEmpty = longitudeText.trim() === '';
  if (latEmpty && lngEmpty) return { ok: true, latitude: null, longitude: null };
  if (latEmpty) return { ok: false, field: 'latitude', key: 'admErrCoordsBoth' };
  if (lngEmpty) return { ok: false, field: 'longitude', key: 'admErrCoordsBoth' };
  const latitude = parseDecimal(latitudeText);
  if (latitude === null || latitude < -90 || latitude > 90) return { ok: false, field: 'latitude', key: 'admErrLatitude' };
  const longitude = parseDecimal(longitudeText);
  if (longitude === null || longitude < -180 || longitude > 180) {
    return { ok: false, field: 'longitude', key: 'admErrLongitude' };
  }
  return { ok: true, latitude, longitude };
}

/**
 * Optional phone number for a tel: link (emergency / police): empty → null; otherwise digits
 * with optional leading '+', spaces, dashes and brackets, 3 to 15 digits (10111 is valid).
 */
export function validateOptionalPhone(text: string): { ok: true; value: string | null } | { ok: false; key: TranslationKey } {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\+?[\d\s()-]+$/.test(trimmed)) return { ok: false, key: 'admErrPhone' };
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 3 || digits.length > 15) return { ok: false, key: 'admErrPhone' };
  return { ok: true, value: trimmed };
}

const WHATSAPP_ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_characters: 'admErrWaChars',
  not_south_african: 'admErrWaNotSa',
  wrong_length: 'admErrWaLength',
  not_mobile: 'admErrWaNotMobile'
};

/** WhatsApp dispatch number: empty → null (not configured); otherwise an SA mobile stored as E.164. */
export function validateWhatsAppNumber(text: string): { ok: true; value: string | null } | { ok: false; key: TranslationKey } {
  if (text.trim() === '') return { ok: true, value: null };
  const result = normalizeSouthAfricanMobile(text);
  if (result.ok) return { ok: true, value: result.e164 };
  return { ok: false, key: WHATSAPP_ERROR_KEYS[result.reason] ?? 'admErrWaLength' };
}

/** Accepts 'CP1' or a full 'PLAAS-CP:CP1' card text; empty → null. */
export function validateLegacyCode(text: string): { ok: true; value: string | null } | { ok: false; key: TranslationKey } {
  let trimmed = text.trim();
  if (trimmed.toUpperCase().startsWith(LEGACY_PREFIX)) trimmed = trimmed.slice(LEGACY_PREFIX.length).trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!LEGACY_CODE_PATTERN.test(trimmed)) return { ok: false, key: 'admErrLegacyCode' };
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------------

export interface SiteFormValues {
  name: string;
  code: string;
  address: string;
  latitude: string;
  longitude: string;
  defaultRadius: string;
  dayStart: string;
  dayEnd: string;
  nightStart: string;
  nightEnd: string;
  roundInterval: string;
  emergencyPhone: string;
  policePhone: string;
  whatsapp: string;
  allowLegacyQr: boolean;
  isActive: boolean;
}

export type SiteFormField = keyof SiteFormValues;

/** Form values exactly as stored (no defaults are invented for empty columns). */
export function siteToFormValues(site: Site): SiteFormValues {
  return {
    name: site.name,
    code: site.code,
    address: site.address ?? '',
    latitude: toText(site.latitude),
    longitude: toText(site.longitude),
    defaultRadius: toText(site.defaultRadiusMeters),
    dayStart: site.dayShiftStart,
    dayEnd: site.dayShiftEnd,
    nightStart: site.nightShiftStart,
    nightEnd: site.nightShiftEnd,
    roundInterval: toText(site.roundIntervalMinutes),
    emergencyPhone: site.emergencyPhone ?? '',
    policePhone: site.policePhone ?? '',
    whatsapp: site.whatsappDispatchNumber ?? '',
    allowLegacyQr: site.allowLegacyQr,
    isActive: site.isActive
  };
}

export function validateSiteForm(values: SiteFormValues): Validated<SiteSettingsInput, SiteFormField> {
  const errors: FieldErrors<SiteFormField> = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > 255) errors.name = 'admErrName';
  const code = values.code.trim();
  if (code.length < 1 || code.length > 50 || /\s/.test(code)) errors.code = 'admErrSiteCode';
  const address = values.address.trim();

  const coords = parseCoordinates(values.latitude, values.longitude);
  if (!coords.ok) errors[coords.field] = coords.key;

  const radius = parseWholeNumber(values.defaultRadius);
  if (radius === null || radius < RADIUS_MIN_M || radius > RADIUS_MAX_M) errors.defaultRadius = 'admErrRadius';

  for (const field of ['dayStart', 'dayEnd', 'nightStart', 'nightEnd'] as const) {
    if (!TIME_PATTERN.test(values[field])) errors[field] = 'admErrTime';
  }
  if (!errors.dayStart && !errors.dayEnd && values.dayStart === values.dayEnd) errors.dayEnd = 'admErrShiftSameTimes';
  if (!errors.nightStart && !errors.nightEnd && values.nightStart === values.nightEnd) errors.nightEnd = 'admErrShiftSameTimes';

  const interval = parseWholeNumber(values.roundInterval);
  if (interval === null || interval < ROUND_INTERVAL_MIN || interval > ROUND_INTERVAL_MAX) errors.roundInterval = 'admErrInterval';

  const emergency = validateOptionalPhone(values.emergencyPhone);
  if (!emergency.ok) errors.emergencyPhone = emergency.key;
  const police = validateOptionalPhone(values.policePhone);
  if (!police.ok) errors.policePhone = police.key;
  const whatsapp = validateWhatsAppNumber(values.whatsapp);
  if (!whatsapp.ok) errors.whatsapp = whatsapp.key;

  if (Object.keys(errors).length > 0 || !coords.ok || !emergency.ok || !police.ok || !whatsapp.ok || radius === null || interval === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      code,
      address: address === '' ? null : address,
      latitude: coords.latitude,
      longitude: coords.longitude,
      defaultRadiusMeters: radius,
      dayShiftStart: values.dayStart,
      dayShiftEnd: values.dayEnd,
      nightShiftStart: values.nightStart,
      nightShiftEnd: values.nightEnd,
      roundIntervalMinutes: interval,
      emergencyPhone: emergency.value,
      policePhone: police.value,
      whatsappDispatchNumber: whatsapp.value,
      allowLegacyQr: values.allowLegacyQr,
      isActive: values.isActive
    }
  };
}

export function validateNewSite(values: { name: string; code: string }): Validated<{ name: string; code: string }, 'name' | 'code'> {
  const errors: FieldErrors<'name' | 'code'> = {};
  const name = values.name.trim();
  const code = values.code.trim();
  if (name.length < 1 || name.length > 255) errors.name = 'admErrName';
  if (code.length < 1 || code.length > 50 || /\s/.test(code)) errors.code = 'admErrSiteCode';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, code } };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointFormValues {
  name: string;
  description: string;
  radius: string;
  order: string;
  legacyCode: string;
  latitude: string;
  longitude: string;
}

export type CheckpointFormField = keyof CheckpointFormValues;

export function checkpointToFormValues(checkpoint: Checkpoint): CheckpointFormValues {
  return {
    name: checkpoint.name,
    description: checkpoint.description ?? '',
    radius: toText(checkpoint.permittedRadiusMeters),
    order: toText(checkpoint.orderIndex),
    legacyCode: checkpoint.legacyCode ?? '',
    latitude: toText(checkpoint.latitude),
    longitude: toText(checkpoint.longitude)
  };
}

/** A blank form for a new checkpoint: the site's default radius and the next order number. */
export function newCheckpointFormValues(defaultRadius: number, existing: readonly Checkpoint[]): CheckpointFormValues {
  const nextOrder = existing.reduce((max, cp) => Math.max(max, cp.orderIndex), 0) + 1;
  return {
    name: '',
    description: '',
    radius: toText(defaultRadius),
    order: String(nextOrder),
    legacyCode: '',
    latitude: '',
    longitude: ''
  };
}

export function validateCheckpointForm(values: CheckpointFormValues): Validated<CheckpointInput, CheckpointFormField> {
  const errors: FieldErrors<CheckpointFormField> = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > 255) errors.name = 'admErrName';
  const description = values.description.trim();
  if (description.length > 2000) errors.description = 'admErrDescription';
  const radius = parseWholeNumber(values.radius);
  if (radius === null || radius < RADIUS_MIN_M || radius > RADIUS_MAX_M) errors.radius = 'admErrRadius';
  const order = parseWholeNumber(values.order);
  if (order === null || order > 9999) errors.order = 'admErrOrder';
  const legacy = validateLegacyCode(values.legacyCode);
  if (!legacy.ok) errors.legacyCode = legacy.key;
  const coords = parseCoordinates(values.latitude, values.longitude);
  if (!coords.ok) errors[coords.field] = coords.key;

  if (Object.keys(errors).length > 0 || radius === null || order === null || !legacy.ok || !coords.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      description: description === '' ? null : description,
      permittedRadiusMeters: radius,
      orderIndex: order,
      legacyCode: legacy.value,
      latitude: coords.latitude,
      longitude: coords.longitude
    }
  };
}

/** Last characters of the printed token, shown on cards so an admin can tell reprints apart. */
export function cardReference(token: string): string {
  return token.slice(-6);
}
