/**
 * Pure logic of the vehicle gate screen (no React, no browser APIs), unit-tested in
 * gateLogic.test.ts.
 *
 * - "Vehicles on site" is derived from real records only: gate_entries rows of the site read
 *   from Supabase, gate events recorded on this phone (Dexie localEvents, possibly not uploaded
 *   yet) and, offline, the last server list kept on this phone. Nothing is invented.
 * - A vehicle leaving is a separate OUT row linked to its IN row (the gate log is append-only).
 * - Licence-disc fields are attached to an entry only when the disc's plate equals the plate
 *   that is being saved (the guard may have corrected or replaced the number).
 */
import type { LicenseDiscData, VehicleDirection } from '@/types/models';
import type { EventLocation, GateEntryPayload, SyncState } from '@/types/offline';
import type { TranslationKey } from '@/lib/i18n/translations';
import { MAX_PLATE_LENGTH, normalizePlate } from '@/lib/license-disc/parser';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import { formatDuration } from '@/features/shifts/shiftCalculator';

/** Vehicles booked in longer ago than this are no longer listed as on site (Dawie's onFarm window). */
export const ON_SITE_WINDOW_MS = 30 * 86_400_000;

/** Server rows read per site (Supabase's default PostgREST max-rows). */
export const GATE_SERVER_ROW_LIMIT = 1000;

/** Columns read for the on-site list. Never '*'. */
export const GATE_ENTRY_COLUMNS =
  'id, direction, license_plate, make_model, vehicle_colour, driver_name, driver_phone, company, visit_reason, person_visited, entry_time, exit_time, linked_entry_id, disc_expiry_date, is_disc_scanned';

/** A gate_entries row as selected with GATE_ENTRY_COLUMNS. */
export interface GateServerRow {
  id: string;
  direction: string;
  license_plate: string;
  make_model: string | null;
  vehicle_colour: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  company: string | null;
  visit_reason: string | null;
  person_visited: string | null;
  entry_time: string;
  exit_time: string | null;
  linked_entry_id: string | null;
  disc_expiry_date: string | null;
  is_disc_scanned: boolean | null;
}

/**
 * Where a record came from: 'server' = read from gate_entries just now; 'device' = recorded on
 * this phone (its upload state is `syncState`); 'cache' = the last server list kept on this phone.
 */
export type GateRecordSource = 'server' | 'device' | 'cache';

export interface GateRecord {
  /** Server row id = offline_uuid = the event id returned by syncEngine.enqueue. */
  id: string;
  direction: VehicleDirection;
  /** normalizePlate() form, used for matching. */
  plate: string;
  /** As recorded (trimmed). */
  displayPlate: string;
  entryTime: string;
  exitTime: string | null;
  linkedEntryId: string | null;
  makeModel: string | null;
  vehicleColour: string | null;
  driverName: string | null;
  driverPhone: string | null;
  company: string | null;
  visitReason: string | null;
  personVisited: string | null;
  discExpiryDate: string | null;
  isDiscScanned: boolean;
  source: GateRecordSource;
  /** Upload state of a record made on this phone (null for server/cache records). */
  syncState: SyncState | null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isDirection(value: unknown): value is VehicleDirection {
  return value === 'in' || value === 'out';
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function gateRecordFromServerRow(row: GateServerRow): GateRecord | null {
  if (!row || typeof row.id !== 'string' || !isDirection(row.direction) || !validTime(row.entry_time)) return null;
  const displayPlate = text(row.license_plate);
  if (!displayPlate) return null;
  return {
    id: row.id,
    direction: row.direction,
    plate: normalizePlate(displayPlate),
    displayPlate,
    entryTime: row.entry_time,
    exitTime: validTime(row.exit_time) ? row.exit_time : null,
    linkedEntryId: text(row.linked_entry_id),
    makeModel: text(row.make_model),
    vehicleColour: text(row.vehicle_colour),
    driverName: text(row.driver_name),
    driverPhone: text(row.driver_phone),
    company: text(row.company),
    visitReason: text(row.visit_reason),
    personVisited: text(row.person_visited),
    discExpiryDate: text(row.disc_expiry_date),
    isDiscScanned: row.is_disc_scanned === true,
    source: 'server',
    syncState: null
  };
}

/** A gate_entry event recorded on this phone (Dexie localEvents payload). */
export function gateRecordFromPayload(
  id: string,
  payload: Partial<GateEntryPayload> | null | undefined,
  syncState: SyncState | null
): GateRecord | null {
  if (!payload || typeof id !== 'string' || !isDirection(payload.direction) || !validTime(payload.entryTime)) return null;
  const displayPlate = text(payload.licensePlate);
  if (!displayPlate) return null;
  return {
    id,
    direction: payload.direction,
    plate: normalizePlate(displayPlate),
    displayPlate,
    entryTime: payload.entryTime,
    exitTime: validTime(payload.exitTime) ? payload.exitTime : null,
    linkedEntryId: text(payload.linkedEntryId),
    makeModel: text(payload.makeModel),
    vehicleColour: text(payload.vehicleColour),
    driverName: text(payload.driverName),
    driverPhone: text(payload.driverPhone),
    company: text(payload.company),
    visitReason: text(payload.visitReason),
    personVisited: text(payload.personVisited),
    discExpiryDate: text(payload.discExpiryDate),
    isDiscScanned: payload.isDiscScanned === true,
    source: 'device',
    syncState
  };
}

/**
 * One record per id. The server copy wins (it is what the supervisor sees); a phone record keeps
 * its upload state; the offline cache only fills gaps.
 */
export function mergeGateRecords(sources: {
  server?: readonly GateRecord[];
  device?: readonly GateRecord[];
  cached?: readonly GateRecord[];
}): GateRecord[] {
  const byId = new Map<string, GateRecord>();
  for (const record of sources.cached ?? []) byId.set(record.id, record);
  for (const record of sources.device ?? []) byId.set(record.id, record);
  for (const record of sources.server ?? []) {
    const local = byId.get(record.id);
    byId.set(record.id, local && local.source === 'device' ? { ...record, syncState: local.syncState } : record);
  }
  return [...byId.values()];
}

/** When the gate event happened: exit time for an OUT row, entry time for an IN row. */
export function gateEventTimeMs(record: Pick<GateRecord, 'direction' | 'entryTime' | 'exitTime'>): number {
  return Date.parse(record.direction === 'out' ? record.exitTime ?? record.entryTime : record.entryTime);
}

/**
 * Vehicles still on site: IN records of the last 30 days that no OUT has closed. An OUT closes
 * the IN it links to, and — like Dawie's per-plate log — every IN of the same plate that is not
 * later than the OUT. When one plate has several open INs (a new IN was confirmed on purpose),
 * only the latest is listed. Newest first.
 */
export function computeVehiclesOnSite(
  records: readonly GateRecord[],
  options: { now: number; windowMs?: number }
): GateRecord[] {
  const windowStart = options.now - (options.windowMs ?? ON_SITE_WINDOW_MS);
  const closedByLink = new Set<string>();
  const lastOutByPlate = new Map<string, number>();
  for (const record of records) {
    if (record.direction !== 'out') continue;
    if (record.linkedEntryId) closedByLink.add(record.linkedEntryId);
    const at = gateEventTimeMs(record);
    if (!Number.isFinite(at)) continue;
    const previous = lastOutByPlate.get(record.plate);
    if (previous === undefined || at > previous) lastOutByPlate.set(record.plate, at);
  }

  const latestOpen = new Map<string, GateRecord>();
  for (const record of records) {
    if (record.direction !== 'in' || !record.plate) continue;
    const entry = Date.parse(record.entryTime);
    if (!Number.isFinite(entry) || entry < windowStart) continue;
    if (closedByLink.has(record.id)) continue;
    const lastOut = lastOutByPlate.get(record.plate);
    if (lastOut !== undefined && lastOut >= entry) continue;
    const current = latestOpen.get(record.plate);
    if (!current || entry > Date.parse(current.entryTime)) latestOpen.set(record.plate, record);
  }
  return [...latestOpen.values()].sort((a, b) => Date.parse(b.entryTime) - Date.parse(a.entryTime));
}

export function findOnSiteByPlate(vehicles: readonly GateRecord[], plate: string): GateRecord | null {
  const wanted = normalizePlate(plate);
  if (!wanted) return null;
  return vehicles.find((vehicle) => vehicle.plate === wanted) ?? null;
}

export type PlateProblem =
  | { level: 'error'; code: 'empty' | 'too_long' }
  | { level: 'warning'; code: 'unusual_chars' | 'unusual_length' };

/**
 * Registration number checks. Only an empty or over-long number blocks saving (the database
 * would reject it); unusual characters or length are warnings — personalised plates vary.
 */
export function checkPlate(plate: string): PlateProblem | null {
  const clean = normalizePlate(plate);
  if (clean === '') return { level: 'error', code: 'empty' };
  if ([...clean].length > MAX_PLATE_LENGTH) return { level: 'error', code: 'too_long' };
  const withoutDashes = clean.replace(/-/g, '');
  if (/[^A-Z0-9]/.test(withoutDashes)) return { level: 'warning', code: 'unusual_chars' };
  if (withoutDashes.length < 2 || withoutDashes.length > 10) return { level: 'warning', code: 'unusual_length' };
  return null;
}

/** The disc belongs to the entry only when its plate is the plate being saved. */
export function discMatchesPlate(disc: Pick<LicenseDiscData, 'plate'> | null | undefined, plate: string): boolean {
  if (!disc) return false;
  const discPlate = normalizePlate(disc.plate ?? '');
  return discPlate !== '' && discPlate === normalizePlate(plate);
}

export interface GateFormValues {
  plate: string;
  makeModel: string;
  colour: string;
  driverName: string;
  driverPhone: string;
  company: string;
  visitReason: string;
  personVisited: string;
}

export const EMPTY_GATE_FORM: GateFormValues = {
  plate: '',
  makeModel: '',
  colour: '',
  driverName: '',
  driverPhone: '',
  company: '',
  visitReason: '',
  personVisited: ''
};

/** Form values pre-filled from a disc (only fields that are on the disc). */
export function formFromDisc(form: GateFormValues, disc: LicenseDiscData): GateFormValues {
  const makeModel = [disc.make, disc.model].filter((part): part is string => !!part && part.trim() !== '').join(' ');
  return {
    ...form,
    plate: disc.plate || form.plate,
    makeModel: makeModel || form.makeModel,
    colour: disc.colour?.trim() || form.colour
  };
}

/** Form values for an OUT picked from the on-site list (empty fields are filled from the IN). */
export function formFromOnSiteVehicle(form: GateFormValues, vehicle: GateRecord): GateFormValues {
  return {
    ...form,
    plate: vehicle.displayPlate,
    makeModel: form.makeModel.trim() || vehicle.makeModel || '',
    colour: form.colour.trim() || vehicle.vehicleColour || '',
    driverName: form.driverName.trim() || vehicle.driverName || ''
  };
}

export interface BuildGatePayloadInput {
  direction: VehicleDirection;
  form: GateFormValues;
  disc: LicenseDiscData | null;
  /** The guard's active shift (shiftStore.getActiveShift). */
  shiftId: string;
  location: EventLocation;
  /** Device time of the gate event (epoch ms). */
  now: number;
  /** OUT: the IN record this vehicle is leaving from (null when there is none). */
  linkedIn: GateRecord | null;
}

/**
 * The gate_entry payload for syncEngine.enqueue.
 * IN: entryTime = now. OUT: exitTime = now; linked to its IN (entryTime = the IN's time, never
 * later than now, so exit >= entry); without an IN the entry time is unknown and set to now
 * (time on site 0). The server recomputes the time on site. OUT rows only carry the fields the
 * OUT form shows (plate, make/model, colour, driver name).
 */
export function buildGateEntryPayload(input: BuildGatePayloadInput): GateEntryPayload {
  const { direction, form, disc, location, now } = input;
  const nowIso = new Date(now).toISOString();
  const plate = normalizePlate(form.plate);
  const withDisc = discMatchesPlate(disc, plate) ? disc : null;

  let entryTime = nowIso;
  let exitTime: string | null = null;
  let dwellDurationSeconds: number | null = null;
  let linkedEntryId: string | null = null;
  if (direction === 'out') {
    exitTime = nowIso;
    const linkedEntryMs = input.linkedIn ? Date.parse(input.linkedIn.entryTime) : NaN;
    if (input.linkedIn && input.linkedIn.direction === 'in' && Number.isFinite(linkedEntryMs)) {
      const entryMs = Math.min(linkedEntryMs, now);
      entryTime = new Date(entryMs).toISOString();
      linkedEntryId = input.linkedIn.id;
      dwellDurationSeconds = Math.max(0, Math.floor((now - entryMs) / 1000));
    } else {
      dwellDurationSeconds = 0;
    }
  }

  const isIn = direction === 'in';
  return {
    ...location,
    shiftId: input.shiftId,
    direction,
    licensePlate: plate,
    makeModel: text(form.makeModel),
    vehicleColour: text(form.colour),
    driverName: text(form.driverName),
    driverPhone: isIn ? text(form.driverPhone) : null,
    company: isIn ? text(form.company) : null,
    visitReason: isIn ? text(form.visitReason) : null,
    personVisited: isIn ? text(form.personVisited) : null,
    discExpiryDate: withDisc?.expiryDate ?? null,
    vinNumber: withDisc?.vin ?? null,
    engineNumber: withDisc?.engineNumber ?? null,
    registerNumber: withDisc?.regNumber ?? null,
    vehicleDescription: withDisc?.description ?? null,
    isDiscScanned: withDisc !== null,
    entryTime,
    exitTime,
    dwellDurationSeconds,
    linkedEntryId
  };
}

/** 'HH:MM' (SAST) for today, otherwise 'YYYY-MM-DD HH:MM'. */
export function formatSastStamp(value: string | number, now: number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const time = sastTimeHM(ms);
  return sastDateString(ms) === sastDateString(now) ? time : `${sastDateString(ms)} ${time}`;
}

/** Time on site so far (never negative). */
export function timeOnSiteMs(entryTime: string, until: number): number {
  const entry = Date.parse(entryTime);
  return Number.isFinite(entry) ? Math.max(0, until - entry) : 0;
}

export type GateEntryMethod = 'disc' | 'list' | 'manual';

export type GateTranslate = (key: TranslationKey, ...args: (string | number)[]) => string;

export interface GateMessageInput {
  payload: GateEntryPayload;
  method: GateEntryMethod;
  guardName: string;
  siteName: string | null;
  /** When the entry was recorded (epoch ms). */
  recordedAt: number;
}

/**
 * Text of the vehicle notice for WhatsApp (reference app vehText). It is only prepared here; the
 * guard sends it in WhatsApp, so the app never claims it was sent.
 */
export function formatGateWhatsAppText(input: GateMessageInput, t: GateTranslate): string {
  const p = input.payload;
  const isOut = p.direction === 'out';
  const expired = !!p.discExpiryDate && p.discExpiryDate < sastDateString(input.recordedAt);
  const lines: Array<string | null> = [
    `${t(isOut ? 'gateMsgOut' : 'gateMsgIn')}: ${p.licensePlate}`,
    [p.makeModel, p.vehicleColour].filter(Boolean).join(', ') || null,
    p.discExpiryDate ? `${t('gateDiscExpiry')}: ${p.discExpiryDate}${expired ? ` – ${t('gateDiscExpired')}` : ''}` : null,
    p.vinNumber ? `VIN: ${p.vinNumber}` : null,
    p.driverName ? `${t('gateMsgDriver')}: ${p.driverName}` : null,
    p.driverPhone ? `${t('gateMsgPhone')}: ${p.driverPhone}` : null,
    p.company ? `${t('gateMsgCompany')}: ${p.company}` : null,
    p.visitReason ? `${t('gateMsgReason')}: ${p.visitReason}` : null,
    p.personVisited ? `${t('gateMsgVisited')}: ${p.personVisited}` : null,
    isOut && p.linkedEntryId && p.exitTime
      ? `${t('gateMsgTimeOnSite')}: ${formatDuration(timeOnSiteMs(p.entryTime, Date.parse(p.exitTime)))} (${t(
          'gateMsgInAt',
          formatSastStamp(p.entryTime, input.recordedAt)
        )})`
      : null,
    `${t('gateMsgGuard')}: ${input.guardName} – ${sastDateString(input.recordedAt)} ${sastTimeHM(input.recordedAt)}`,
    input.siteName ? `${t('gateMsgSite')}: ${input.siteName}` : null,
    typeof p.latitude === 'number' && typeof p.longitude === 'number'
      ? `https://maps.google.com/?q=${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`
      : t('gateMsgNoGps'),
    t(input.method === 'disc' ? 'gateMsgViaDisc' : input.method === 'list' ? 'gateMsgViaList' : 'gateMsgViaManual')
  ];
  return lines.filter((line): line is string => !!line && line.trim() !== '').join('\n');
}
