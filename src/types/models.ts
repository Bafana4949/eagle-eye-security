export type UserRole = 'super_admin' | 'admin' | 'supervisor' | 'guard' | 'client_viewer';
export type ShiftType = 'day' | 'night' | 'custom';
export type ShiftStatus = 'active' | 'completed' | 'abandoned';
export type RoundStatus = 'pending' | 'in_progress' | 'completed' | 'missed';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'reported' | 'acknowledged' | 'investigating' | 'resolved';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';
export type ScanMethod = 'qr' | 'nfc' | 'manual';
export type VehicleDirection = 'in' | 'out';
export type SupportedLanguage = 'en' | 'af' | 'zu';
/** Server-authoritative GPS confidence (identical rules in the SQL trigger and src/lib/gps/haversine.ts). */
export type GpsConfidence = 'verified' | 'likely' | 'low_confidence' | 'outside' | 'no_fix' | 'no_reference';
export type GpsErrorKind = 'permission_denied' | 'timeout' | 'unavailable' | 'unsupported' | 'insecure' | 'stale';
export type CheckpointPayloadType = 'secure_token' | 'legacy_qr' | 'nfc_uid' | 'manual';
export type EvidenceCategory = 'selfie' | 'incident' | 'vehicle' | 'patrol';

export interface Organisation {
  id: string;
  name: string;
  registrationNumber?: string;
  contactPhone?: string;
  contactEmail?: string;
  brandingLogoUrl?: string;
  primaryColor: string;
  createdAt: string;
  updatedAt: string;
}

export interface Site {
  id: string;
  organisationId: string;
  name: string;
  code: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  defaultRadiusMeters: number;
  dayShiftStart: string;
  dayShiftEnd: string;
  nightShiftStart: string;
  nightShiftEnd: string;
  roundIntervalMinutes: number;
  emergencyPhone?: string;
  policePhone: string;
  whatsappDispatchNumber?: string;
  isActive: boolean;
  /**
   * Whether Dawie's printed PLAAS-CP:<code> cards may still be scanned on this site
   * (sites.allow_legacy_qr). Those codes are public, so such scans are never payload-verified.
   */
  allowLegacyQr: boolean;
}

export interface UserProfile {
  id: string;
  organisationId: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string;
  phoneNumber?: string;
  avatarUrl?: string;
  preferredLanguage: SupportedLanguage;
  roles: UserRole[];
  isActive: boolean;
}

/**
 * A checkpoint as every signed-in role may read it. The printed QR token and the enrolled NFC
 * serial are secrets: the database does not let guards, supervisors or viewers read them
 * (column privileges). Scans are matched against their SHA-256 fingerprints instead; org admins
 * read the raw values through fetchCheckpointSecrets() (src/lib/data/checkpoints.ts).
 */
export interface Checkpoint {
  id: string;
  siteId: string;
  name: string;
  description?: string;
  /** Lower-case hex SHA-256 of the printed QR token (checkpoints.qr_token_sha256). */
  qrTokenSha256?: string;
  /** false: old/weak token format; the card must be rotated and reprinted. */
  qrTokenStrong?: boolean;
  /** Lower-case hex SHA-256 of the normalised NFC serial; absent when no tag is enrolled. */
  nfcUidSha256?: string;
  latitude?: number;
  longitude?: number;
  permittedRadiusMeters: number;
  orderIndex: number;
  isActive: boolean;
  /** Set by the server when the checkpoint was deactivated (scans captured before it still count). */
  deactivatedAt?: string;
  organisationId?: string;
  /** Dawie legacy card code: QR payload PLAAS-CP:<legacyCode> */
  legacyCode?: string;
  /** Stamped by the server when a tag was enrolled (client values are ignored). */
  nfcEnrolledAt?: string;
  nfcEnrolledBy?: string;
}

export interface Shift {
  id: string;
  siteId: string;
  guardId: string;
  guardName?: string;
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart?: string;
  actualEnd?: string;
  startSelfieUrl?: string;
  endSelfieUrl?: string;
  startLatitude?: number;
  startLongitude?: number;
  endLatitude?: number;
  endLongitude?: number;
  startAccuracyMeters?: number;
  endAccuracyMeters?: number;
  status: ShiftStatus;
  notes?: string;
}

export interface PatrolRound {
  id: string;
  shiftId: string;
  roundNumber: number;
  windowStart: string;
  windowEnd: string;
  status: RoundStatus;
  completedAt?: string;
  missedCount: number;
}

export interface PatrolScan {
  id: string;
  offlineUuid: string;
  shiftId: string;
  patrolRoundId?: string;
  checkpointId: string;
  checkpointName?: string;
  guardId: string;
  guardName?: string;
  scanTimestampDevice: string;
  scanTimestampServer?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  distanceToCheckpointMeters?: number;
  isValidProximity: boolean;
  method: ScanMethod;
  hashChain?: string;
  prevHashChain?: string;
  photoUrl?: string;
  siteId?: string;
  gpsConfidence?: GpsConfidence;
  gpsError?: GpsErrorKind;
  locationTimestamp?: string;
  checkpointRadiusMeters?: number;
  payloadType?: CheckpointPayloadType;
  /**
   * Server verdict (patrol_scans.payload_verified): the phone submitted this checkpoint's strong
   * QR token or enrolled NFC serial. Legacy PLAAS-CP cards and manual entries are never verified.
   * Like the GPS verdict it reflects what the phone reported; it is not proof of presence.
   */
  payloadVerified?: boolean;
  createdAt?: string;
}

export interface Incident {
  id: string;
  offlineUuid: string;
  siteId: string;
  shiftId?: string;
  guardId: string;
  guardName?: string;
  incidentType: string;
  severity: IncidentSeverity;
  description: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  status: IncidentStatus;
  reportedAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  supervisorNotes?: string;
  photos?: string[];
}

export interface PanicAlert {
  id: string;
  offlineUuid: string;
  siteId: string;
  shiftId?: string;
  guardId: string;
  guardName?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  status: AlertStatus;
  triggeredAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolutionNotes?: string;
}

export interface LicenseDiscData {
  plate: string;
  regNumber?: string;
  /** Vehicle description as encoded on the disc, e.g. "Sedan (closed top)" */
  description?: string;
  make?: string;
  model?: string;
  colour?: string;
  vin?: string;
  engineNumber?: string;
  expiryDate?: string;
  isExpired: boolean;
}

export interface GateEntry {
  id: string;
  offlineUuid: string;
  siteId: string;
  shiftId?: string;
  guardId: string;
  guardName?: string;
  direction: VehicleDirection;
  licensePlate: string;
  makeModel?: string;
  vehicleColour?: string;
  discExpiryDate?: string;
  vinNumber?: string;
  driverName?: string;
  driverPhone?: string;
  company?: string;
  visitReason?: string;
  personVisited?: string;
  isDiscScanned: boolean;
  entryTime: string;
  exitTime?: string;
  dwellDurationSeconds?: number;
  /** Storage PATH in the private evidence-media bucket (not a URL). */
  vehiclePhotoUrl?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  registerNumber?: string;
  vehicleDescription?: string;
  /** For an OUT row: id of the matching IN row. */
  linkedEntryId?: string;
}
