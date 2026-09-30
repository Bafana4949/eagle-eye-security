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

export interface Checkpoint {
  id: string;
  siteId: string;
  name: string;
  description?: string;
  qrCodeHash: string;
  nfcUid?: string;
  latitude?: number;
  longitude?: number;
  permittedRadiusMeters: number;
  orderIndex: number;
  isActive: boolean;
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
  vehiclePhotoUrl?: string;
}
