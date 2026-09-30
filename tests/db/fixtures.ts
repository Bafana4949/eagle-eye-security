/**
 * Two-tenant fixture for RLS tests, provisioned the way an operator would (superuser /
 * service role): auth users, profiles, roles, site assignments, checkpoints, plus a few
 * pre-existing records owned by other users. IDs are random per run.
 *
 *   Org A: siteA1 (guardA, guardA2, supA, viewerA, disabledGuardA assigned)
 *          siteA2 (guardA3 assigned; supA / viewerA NOT assigned)
 *          adminA (org admin, no site assignment), superA (super_admin)
 *   Org B: siteB1 (guardB assigned), adminB
 */
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';

export type UserKey =
  | 'superA'
  | 'adminA'
  | 'supA'
  | 'guardA'
  | 'guardA2'
  | 'guardA3'
  | 'viewerA'
  | 'disabledGuardA'
  | 'adminB'
  | 'guardB';

export interface Fixture {
  orgA: string;
  orgB: string;
  siteA1: string;
  siteA2: string;
  siteB1: string;
  users: Record<UserKey, string>;
  /** Checkpoint coordinates of cpA1 / cpA1Gps. */
  cpLat: number;
  cpLng: number;
  checkpoints: {
    /** site A1, active, coordinates, radius 50 m, legacy code CP1 */
    cpA1: string;
    /** site A1, inactive */
    cpA1Inactive: string;
    /** site A1, active, no coordinates */
    cpA1NoCoords: string;
    /** site A2 */
    cpA2: string;
    /** site B1 */
    cpB1: string;
  };
  /** Active shift of guardA3 at siteA2 (pre-existing). */
  shiftA3: string;
  /** Active shift of guardB at siteB1 (pre-existing). */
  shiftB: string;
  /** Active shift of guardA2 at siteA1 (pre-existing, colleague of guardA). */
  shiftA2: string;
  /** Scan by guardA2 on shiftA2. */
  scanA2: string;
  /** Gate entry (IN) recorded by guardA2 at siteA1. */
  gateA2: string;
  /** Incident by guardA2 at siteA1. */
  incidentA2: string;
  /** Panic alert by guardA3 at siteA2 (site NOT assigned to supA). */
  panicA3: string;
  /** Incident by guardB at siteB1. */
  incidentB: string;
}

/** Strong checkpoint token in the format enforced by the database. */
export function newCheckpointToken(): string {
  return `EE-CP-${randomUUID().replace(/-/g, '').toUpperCase()}`;
}

export async function seedTwoTenantFixture(db: PGlite): Promise<Fixture> {
  const users: Record<UserKey, string> = {
    superA: randomUUID(),
    adminA: randomUUID(),
    supA: randomUUID(),
    guardA: randomUUID(),
    guardA2: randomUUID(),
    guardA3: randomUUID(),
    viewerA: randomUUID(),
    disabledGuardA: randomUUID(),
    adminB: randomUUID(),
    guardB: randomUUID()
  };
  const f: Fixture = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    siteA1: randomUUID(),
    siteA2: randomUUID(),
    siteB1: randomUUID(),
    users,
    cpLat: -25.68412,
    cpLng: 27.81452,
    checkpoints: {
      cpA1: randomUUID(),
      cpA1Inactive: randomUUID(),
      cpA1NoCoords: randomUUID(),
      cpA2: randomUUID(),
      cpB1: randomUUID()
    },
    shiftA3: randomUUID(),
    shiftB: randomUUID(),
    shiftA2: randomUUID(),
    scanA2: randomUUID(),
    gateA2: randomUUID(),
    incidentA2: randomUUID(),
    panicA3: randomUUID(),
    incidentB: randomUUID()
  };

  const profiles: Array<[UserKey, string, string, boolean]> = [
    ['superA', f.orgA, 'Super', true],
    ['adminA', f.orgA, 'Admin', true],
    ['supA', f.orgA, 'Supervisor', true],
    ['guardA', f.orgA, 'Guard', true],
    ['guardA2', f.orgA, 'Guard', true],
    ['guardA3', f.orgA, 'Guard', true],
    ['viewerA', f.orgA, 'Client', true],
    ['disabledGuardA', f.orgA, 'Disabled', false],
    ['adminB', f.orgB, 'Admin', true],
    ['guardB', f.orgB, 'Guard', true]
  ];
  const roles: Array<[UserKey, string]> = [
    ['superA', 'super_admin'],
    ['adminA', 'admin'],
    ['supA', 'supervisor'],
    ['guardA', 'guard'],
    ['guardA2', 'guard'],
    ['guardA3', 'guard'],
    ['viewerA', 'client_viewer'],
    ['disabledGuardA', 'guard'],
    ['adminB', 'admin'],
    ['guardB', 'guard']
  ];
  const assignments: Array<[string, UserKey]> = [
    [f.siteA1, 'guardA'],
    [f.siteA1, 'guardA2'],
    [f.siteA1, 'supA'],
    [f.siteA1, 'viewerA'],
    [f.siteA1, 'disabledGuardA'],
    [f.siteA2, 'guardA3'],
    [f.siteB1, 'guardB']
  ];

  await db.query(`INSERT INTO organisations (id, name) VALUES ($1, 'Org A'), ($2, 'Org B')`, [f.orgA, f.orgB]);
  await db.query(
    `INSERT INTO sites (id, organisation_id, name, code, latitude, longitude)
     VALUES ($1, $4, 'Farm A1', 'A1', $6, $7), ($2, $4, 'Farm A2', 'A2', NULL, NULL), ($3, $5, 'Farm B1', 'B1', NULL, NULL)`,
    [f.siteA1, f.siteA2, f.siteB1, f.orgA, f.orgB, f.cpLat, f.cpLng]
  );
  for (const [key, org, first, active] of profiles) {
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [users[key], `${key.toLowerCase()}@example.test`]);
    await db.query(
      `INSERT INTO profiles (id, organisation_id, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5)`,
      [users[key], org, first, key, active]
    );
  }
  for (const [key, role] of roles) {
    await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [users[key], role]);
  }
  for (const [site, key] of assignments) {
    await db.query(`INSERT INTO site_assignments (site_id, user_id) VALUES ($1, $2)`, [site, users[key]]);
  }

  const cp = f.checkpoints;
  await db.query(
    `INSERT INTO checkpoints (id, site_id, name, qr_code_hash, legacy_code, latitude, longitude, permitted_radius_meters, is_active)
     VALUES ($1, $6, 'Main gate', $11, 'CP1', $9, $10, 50, true),
            ($2, $6, 'Old pump', $12, NULL, $9, $10, 50, false),
            ($3, $6, 'Shed (no GPS)', $13, NULL, NULL, NULL, 50, true),
            ($4, $7, 'A2 gate', $14, NULL, NULL, NULL, 50, true),
            ($5, $8, 'B1 gate', $15, NULL, NULL, NULL, 50, true)`,
    [
      cp.cpA1,
      cp.cpA1Inactive,
      cp.cpA1NoCoords,
      cp.cpA2,
      cp.cpB1,
      f.siteA1,
      f.siteA2,
      f.siteB1,
      f.cpLat,
      f.cpLng,
      newCheckpointToken(),
      newCheckpointToken(),
      newCheckpointToken(),
      newCheckpointToken(),
      newCheckpointToken()
    ]
  );

  await db.query(
    `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start, status)
     VALUES ($1, $4, $5, 'night', now() - interval '1 hour', now() + interval '11 hours', now() - interval '1 hour', 'active'),
            ($2, $6, $7, 'night', now() - interval '1 hour', now() + interval '11 hours', now() - interval '1 hour', 'active'),
            ($3, $8, $9, 'night', now() - interval '1 hour', now() + interval '11 hours', now() - interval '1 hour', 'active')`,
    [f.shiftA3, f.shiftB, f.shiftA2, f.siteA2, users.guardA3, f.siteB1, users.guardB, f.siteA1, users.guardA2]
  );
  await db.query(
    `INSERT INTO patrol_scans (id, offline_uuid, shift_id, checkpoint_id, guard_id, scan_timestamp_device, method, payload_type)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, now() - interval '30 minutes', 'qr', 'secure_token')`,
    [f.scanA2, f.shiftA2, cp.cpA1, users.guardA2]
  );
  await db.query(
    `INSERT INTO gate_entries (id, offline_uuid, site_id, shift_id, guard_id, direction, license_plate, entry_time)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, 'in', 'CA 123-456', now() - interval '20 minutes')`,
    [f.gateA2, f.siteA1, f.shiftA2, users.guardA2]
  );
  await db.query(
    `INSERT INTO incidents (id, offline_uuid, site_id, shift_id, guard_id, incident_type, description, reported_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, 'fence', 'Cut fence at north boundary', now() - interval '10 minutes'),
            ($5, gen_random_uuid(), $6, $7, $8, 'gate', 'Org B incident', now() - interval '10 minutes')`,
    [f.incidentA2, f.siteA1, f.shiftA2, users.guardA2, f.incidentB, f.siteB1, f.shiftB, users.guardB]
  );
  await db.query(
    `INSERT INTO panic_alerts (id, offline_uuid, site_id, shift_id, guard_id, latitude, longitude, triggered_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, -25.7, 27.8, now() - interval '5 minutes')`,
    [f.panicA3, f.siteA2, f.shiftA3, users.guardA3]
  );

  return f;
}

/**
 * Point `meters` due north of (lat, lng). For a pure latitude change the haversine
 * distance is exactly R * dLat, so the database will compute `meters` back.
 */
export function pointNorthOf(lat: number, lng: number, meters: number): { latitude: number; longitude: number } {
  const R = 6371008.8;
  return { latitude: lat + (meters / R) * (180 / Math.PI), longitude: lng };
}
