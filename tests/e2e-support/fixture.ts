/**
 * E2E TEST SUPPORT ONLY: the dataset every browser test starts from.
 *
 * Provisioned the way an operator would (superuser SQL + Auth users with passwords), on top of
 * the real migrations. IDs and QR tokens are random per reset; specs read them from the fake
 * server (GET /__test/fixture) instead of hard-coding anything.
 *
 *   Org A "Aiguille Security (E2E)"
 *     Site A "Dawie Boerdery (E2E)": WhatsApp dispatch, emergency and police numbers, day
 *       06:00-18:00 / night 18:00-06:00 (SAST), 60-minute rounds, legacy PLAAS-CP cards allowed.
 *       Checkpoints: gate (legacy code CP1 + coordinates), workshop (NFC-enrolled, coordinates
 *       30 m north), borehole (no coordinates), old pump (inactive).
 *     Users: admin (org-wide), supervisor, guard, guard2, viewer (client) — all but the admin
 *       assigned to site A; disabledGuard (is_active = false); noProfile (Auth user only).
 *   Org B "Other Security (E2E)"
 *     Site B "Other Farm (E2E)" (no phone numbers configured), one checkpoint.
 *     Users: guardB (assigned to site B).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { GUARD_LOGIN_DOMAIN, SITE_A_LOCATION } from './constants';

export type E2EUserKey = 'admin' | 'supervisor' | 'guard' | 'guard2' | 'viewer' | 'disabledGuard' | 'noProfile' | 'guardB';
export type E2ERole = 'super_admin' | 'admin' | 'supervisor' | 'guard' | 'client_viewer';

export interface E2EUser {
  key: E2EUserKey;
  id: string;
  /** Supabase Auth e-mail. */
  email: string;
  /** What a person types in the login form ("guard1" for guards, the e-mail for managers). */
  login: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: E2ERole[];
  organisationId: string | null;
  siteIds: string[];
  isActive: boolean;
  hasProfile: boolean;
}

export interface E2ECheckpoint {
  id: string;
  siteId: string;
  name: string;
  orderIndex: number;
  /** The printed QR token (raw secret; guards only ever see its SHA-256). */
  qrToken: string;
  legacyCode: string | null;
  /** Exactly what Dawie's legacy card encodes, e.g. "PLAAS-CP:CP1". */
  legacyPayload: string | null;
  /** Normalised NFC UID as stored and as Chrome reports it ("04:a2:..."), or null. */
  nfcSerial: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
  isActive: boolean;
}

export interface E2ESite {
  id: string;
  organisationId: string;
  name: string;
  code: string;
  latitude: number | null;
  longitude: number | null;
  whatsappDispatchNumber: string | null;
  emergencyPhone: string | null;
  policePhone: string | null;
  dayShiftStart: string;
  dayShiftEnd: string;
  nightShiftStart: string;
  nightShiftEnd: string;
  roundIntervalMinutes: number;
  allowLegacyQr: boolean;
}

export interface E2EFixture {
  seededAt: string;
  orgA: { id: string; name: string };
  orgB: { id: string; name: string };
  siteA: E2ESite;
  siteB: E2ESite;
  checkpoints: {
    gate: E2ECheckpoint;
    workshopNfc: E2ECheckpoint;
    boreholeNoGps: E2ECheckpoint;
    oldPumpInactive: E2ECheckpoint;
    siteBGate: E2ECheckpoint;
  };
  users: Record<E2EUserKey, E2EUser>;
}

/** What the fake Auth service needs to register a password user. */
export interface CreateAuthUserInput {
  id: string;
  email: string;
  password: string;
  emailConfirmed: boolean;
  userMetadata?: Record<string, unknown>;
}

export type CreateAuthUser = (input: CreateAuthUserInput) => Promise<void>;

/** Strong checkpoint token in the only format the database accepts (^EE-CP-[0-9A-F]{32}$). */
export function newCheckpointToken(): string {
  return `EE-CP-${randomBytes(16).toString('hex').toUpperCase()}`;
}

/** Point `meters` due north of (lat, lng) (pure latitude change: haversine gives `meters` back). */
export function pointNorthOf(lat: number, lng: number, meters: number): { latitude: number; longitude: number } {
  const R = 6371008.8;
  return { latitude: lat + (meters / R) * (180 / Math.PI), longitude: lng };
}

/** The NFC tag serial of the enrolled workshop checkpoint (as Chrome reports it). */
export const WORKSHOP_NFC_SERIAL = '04:a2:3b:1c:5d:80:00';

interface UserSpec {
  key: E2EUserKey;
  login: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: E2ERole[];
  org: 'A' | 'B' | null;
  sites: Array<'A' | 'B'>;
  isActive: boolean;
  hasProfile: boolean;
}

const guardEmail = (login: string) => `${login}@${GUARD_LOGIN_DOMAIN}`;

/** TEST passwords (throw-away local database only). */
const USER_SPECS: UserSpec[] = [
  { key: 'admin', login: 'admin@e2e.test', email: 'admin@e2e.test', password: 'Admin-e2e-Pass-41', firstName: 'Anna', lastName: 'Admin', roles: ['admin'], org: 'A', sites: [], isActive: true, hasProfile: true },
  { key: 'supervisor', login: 'supervisor@e2e.test', email: 'supervisor@e2e.test', password: 'Super-e2e-Pass-42', firstName: 'Sipho', lastName: 'Supervisor', roles: ['supervisor'], org: 'A', sites: ['A'], isActive: true, hasProfile: true },
  { key: 'guard', login: 'guard1', email: guardEmail('guard1'), password: 'Guard1-e2e-Pass-43', firstName: 'Thabo', lastName: 'Guard', roles: ['guard'], org: 'A', sites: ['A'], isActive: true, hasProfile: true },
  { key: 'guard2', login: 'guard2', email: guardEmail('guard2'), password: 'Guard2-e2e-Pass-44', firstName: 'Pieter', lastName: 'Second', roles: ['guard'], org: 'A', sites: ['A'], isActive: true, hasProfile: true },
  { key: 'viewer', login: 'viewer@e2e.test', email: 'viewer@e2e.test', password: 'Viewer-e2e-Pass-45', firstName: 'Dawie', lastName: 'Client', roles: ['client_viewer'], org: 'A', sites: ['A'], isActive: true, hasProfile: true },
  { key: 'disabledGuard', login: 'guardoff', email: guardEmail('guardoff'), password: 'Off-e2e-Pass-46', firstName: 'Disabled', lastName: 'Guard', roles: ['guard'], org: 'A', sites: ['A'], isActive: false, hasProfile: true },
  { key: 'noProfile', login: 'noprofile@e2e.test', email: 'noprofile@e2e.test', password: 'NoProf-e2e-Pass-47', firstName: '', lastName: '', roles: [], org: null, sites: [], isActive: true, hasProfile: false },
  { key: 'guardB', login: 'guardb', email: guardEmail('guardb'), password: 'GuardB-e2e-Pass-48', firstName: 'Bongani', lastName: 'OtherOrg', roles: ['guard'], org: 'B', sites: ['B'], isActive: true, hasProfile: true }
];

/** Seeds the E2E dataset into a freshly migrated database. */
export async function seedE2EFixture(db: PGlite, createAuthUser: CreateAuthUser): Promise<E2EFixture> {
  const orgA = { id: randomUUID(), name: 'Aiguille Security (E2E)' };
  const orgB = { id: randomUUID(), name: 'Other Security (E2E)' };

  const siteA: E2ESite = {
    id: randomUUID(),
    organisationId: orgA.id,
    name: 'Dawie Boerdery (E2E)',
    code: 'E2E-A',
    latitude: SITE_A_LOCATION.latitude,
    longitude: SITE_A_LOCATION.longitude,
    whatsappDispatchNumber: '082 000 0001',
    emergencyPhone: '082 000 0002',
    policePhone: '10111',
    dayShiftStart: '06:00',
    dayShiftEnd: '18:00',
    nightShiftStart: '18:00',
    nightShiftEnd: '06:00',
    roundIntervalMinutes: 60,
    allowLegacyQr: true
  };
  const siteB: E2ESite = {
    id: randomUUID(),
    organisationId: orgB.id,
    name: 'Other Farm (E2E)',
    code: 'E2E-B',
    latitude: null,
    longitude: null,
    whatsappDispatchNumber: null,
    emergencyPhone: null,
    policePhone: null,
    dayShiftStart: '06:00',
    dayShiftEnd: '18:00',
    nightShiftStart: '18:00',
    nightShiftEnd: '06:00',
    roundIntervalMinutes: 60,
    allowLegacyQr: false
  };

  await db.query(`INSERT INTO organisations (id, name) VALUES ($1, $2), ($3, $4)`, [orgA.id, orgA.name, orgB.id, orgB.name]);
  for (const site of [siteA, siteB]) {
    await db.query(
      `INSERT INTO sites (id, organisation_id, name, code, latitude, longitude, default_radius_meters,
                          day_shift_start, day_shift_end, night_shift_start, night_shift_end, round_interval_minutes,
                          emergency_phone, police_phone, whatsapp_dispatch_number, allow_legacy_qr)
       VALUES ($1, $2, $3, $4, $5, $6, 50, $7::time, $8::time, $9::time, $10::time, $11, $12, $13, $14, $15)`,
      [
        site.id,
        site.organisationId,
        site.name,
        site.code,
        site.latitude,
        site.longitude,
        site.dayShiftStart,
        site.dayShiftEnd,
        site.nightShiftStart,
        site.nightShiftEnd,
        site.roundIntervalMinutes,
        site.emergencyPhone,
        site.policePhone,
        site.whatsappDispatchNumber,
        site.allowLegacyQr
      ]
    );
  }

  const workshopPoint = pointNorthOf(SITE_A_LOCATION.latitude, SITE_A_LOCATION.longitude, 30);
  const cp = (
    site: E2ESite,
    name: string,
    orderIndex: number,
    extra: Partial<Pick<E2ECheckpoint, 'legacyCode' | 'nfcSerial' | 'latitude' | 'longitude' | 'isActive'>> = {}
  ): E2ECheckpoint => {
    const legacyCode = extra.legacyCode ?? null;
    return {
      id: randomUUID(),
      siteId: site.id,
      name,
      orderIndex,
      qrToken: newCheckpointToken(),
      legacyCode,
      legacyPayload: legacyCode ? `PLAAS-CP:${legacyCode}` : null,
      nfcSerial: extra.nfcSerial ?? null,
      latitude: extra.latitude ?? null,
      longitude: extra.longitude ?? null,
      radiusMeters: 50,
      isActive: extra.isActive ?? true
    };
  };
  const checkpoints: E2EFixture['checkpoints'] = {
    gate: cp(siteA, 'Main gate', 1, {
      legacyCode: 'CP1',
      latitude: SITE_A_LOCATION.latitude,
      longitude: SITE_A_LOCATION.longitude
    }),
    workshopNfc: cp(siteA, 'Workshop', 2, {
      nfcSerial: WORKSHOP_NFC_SERIAL,
      latitude: workshopPoint.latitude,
      longitude: workshopPoint.longitude
    }),
    boreholeNoGps: cp(siteA, 'Borehole', 3),
    oldPumpInactive: cp(siteA, 'Old pump', 4, {
      latitude: SITE_A_LOCATION.latitude,
      longitude: SITE_A_LOCATION.longitude,
      isActive: false
    }),
    siteBGate: cp(siteB, 'B gate', 1)
  };
  for (const c of Object.values(checkpoints)) {
    await db.query(
      `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, legacy_code, nfc_uid, latitude, longitude,
                                permitted_radius_meters, order_index, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [c.id, c.siteId, c.name, c.qrToken, c.legacyCode, c.nfcSerial, c.latitude, c.longitude, c.radiusMeters, c.orderIndex, c.isActive]
    );
  }

  const orgIds = { A: orgA.id, B: orgB.id } as const;
  const siteIds = { A: siteA.id, B: siteB.id } as const;
  const users = {} as Record<E2EUserKey, E2EUser>;
  for (const spec of USER_SPECS) {
    const id = randomUUID();
    const organisationId = spec.org ? orgIds[spec.org] : null;
    await createAuthUser({ id, email: spec.email, password: spec.password, emailConfirmed: true });
    if (spec.hasProfile && organisationId) {
      await db.query(
        `INSERT INTO profiles (id, organisation_id, first_name, last_name, employee_number, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, organisationId, spec.firstName, spec.lastName, spec.login.includes('@') ? null : spec.login.toUpperCase(), spec.isActive]
      );
      for (const role of spec.roles) {
        await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
      }
      for (const site of spec.sites) {
        await db.query(`INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [siteIds[site], id]);
      }
    }
    users[spec.key] = {
      key: spec.key,
      id,
      email: spec.email,
      login: spec.login,
      password: spec.password,
      firstName: spec.firstName,
      lastName: spec.lastName,
      roles: spec.hasProfile ? spec.roles : [],
      organisationId,
      siteIds: spec.hasProfile ? spec.sites.map((s) => siteIds[s]) : [],
      isActive: spec.isActive,
      hasProfile: spec.hasProfile
    };
  }

  return { seededAt: new Date().toISOString(), orgA, orgB, siteA, siteB, checkpoints, users };
}
