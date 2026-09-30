/**
 * Row shapes read by the supervisor dashboard and the client viewer portal.
 *
 * These are the exact columns selected in ./queries.ts (snake_case, as PostgREST returns
 * them). Every row comes from Supabase under the caller's own session, so Row Level Security
 * decides what is visible: supervisors see their assigned sites, admins the whole organisation,
 * client viewers their assigned sites without panic alerts or selfies.
 */
import type {
  AlertStatus,
  CheckpointPayloadType,
  GpsConfidence,
  IncidentSeverity,
  IncidentStatus,
  ScanMethod,
  ShiftStatus,
  ShiftType,
  VehicleDirection
} from '@/types/models';

export interface ShiftRow {
  id: string;
  site_id: string;
  guard_id: string;
  shift_type: ShiftType;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  status: ShiftStatus;
  /** Storage paths (supervisor query only; client viewers may not open selfies). */
  start_selfie_url?: string | null;
  end_selfie_url?: string | null;
  start_accuracy_meters?: number | null;
  end_accuracy_meters?: number | null;
  notes?: string | null;
}

export interface ScanRow {
  id: string;
  shift_id: string;
  site_id: string | null;
  checkpoint_id: string;
  guard_id: string;
  scan_timestamp_device: string;
  scan_timestamp_server: string | null;
  accuracy_meters: number | null;
  distance_to_checkpoint_meters: number | null;
  gps_confidence: GpsConfidence | null;
  gps_error: string | null;
  payload_type: CheckpointPayloadType | null;
  payload_verified: boolean | null;
  method: ScanMethod;
  checkpoint_radius_meters: number | null;
}

/** Checkpoint columns every signed-in role may read (never the QR token or NFC serial). */
export interface CheckpointLite {
  id: string;
  site_id: string;
  name: string;
  order_index: number;
  is_active: boolean;
  deactivated_at: string | null;
  created_at: string | null;
}

export interface IncidentRow {
  id: string;
  site_id: string;
  shift_id: string | null;
  guard_id: string;
  incident_type: string;
  severity: IncidentSeverity;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  status: IncidentStatus;
  reported_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  supervisor_notes: string | null;
  created_at: string | null;
}

export interface IncidentMediaRow {
  id: string;
  incident_id: string;
  /** Storage path in the private evidence bucket. */
  media_url: string;
  media_type: string | null;
}

export interface PanicRow {
  id: string;
  site_id: string;
  /** May be NULL: an SOS can reach the server before its clock-in. Never rely on it. */
  shift_id: string | null;
  guard_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  status: AlertStatus;
  triggered_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolution_notes: string | null;
  created_at: string | null;
}

export interface GateRow {
  id: string;
  site_id: string;
  guard_id: string;
  direction: VehicleDirection;
  license_plate: string;
  make_model: string | null;
  vehicle_colour: string | null;
  vehicle_description: string | null;
  register_number: string | null;
  driver_name: string | null;
  company: string | null;
  visit_reason: string | null;
  person_visited: string | null;
  is_disc_scanned: boolean | null;
  disc_expiry_date: string | null;
  entry_time: string;
  exit_time: string | null;
  dwell_duration_seconds: number | null;
  /** Storage path in the private evidence bucket. */
  vehicle_photo_url: string | null;
  /** OUT rows: the IN row this exit belongs to. */
  linked_entry_id: string | null;
  created_at: string | null;
}

export interface PersonInfo {
  id: string;
  firstName: string;
  lastName: string;
  /** Only readable by supervisors / admins (profiles); never for client viewers. */
  phone?: string;
}

/** Sections whose query hit its row limit (the UI says the list may be incomplete). */
export type PartialSection = 'shifts' | 'scans' | 'incidents' | 'panic' | 'gate' | 'checkpoints' | 'media' | 'people';

export interface OpsSnapshot {
  /** Epoch ms at which the load started. */
  fetchedAt: number;
  siteIds: string[];
  shifts: ShiftRow[];
  scans: ScanRow[];
  checkpoints: CheckpointLite[];
  incidents: IncidentRow[];
  incidentMedia: IncidentMediaRow[];
  /** Always empty for client viewers (RLS). */
  panicAlerts: PanicRow[];
  gateEntries: GateRow[];
  people: Record<string, PersonInfo>;
  partial: PartialSection[];
}
