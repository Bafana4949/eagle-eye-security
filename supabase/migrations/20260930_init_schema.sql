-- ========================================================================
-- EAGLE EYE SECURITY OPERATIONS SYSTEM - DATABASE SCHEMA & RLS POLICIES
-- Multi-Tenant PostgreSQL Schema for Supabase
-- ========================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum Types
CREATE TYPE user_role_type AS ENUM ('super_admin', 'admin', 'supervisor', 'guard', 'client_viewer');
CREATE TYPE shift_type_enum AS ENUM ('day', 'night', 'custom');
CREATE TYPE shift_status_enum AS ENUM ('active', 'completed', 'abandoned');
CREATE TYPE round_status_enum AS ENUM ('pending', 'in_progress', 'completed', 'missed');
CREATE TYPE incident_severity_enum AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE incident_status_enum AS ENUM ('reported', 'acknowledged', 'investigating', 'resolved');
CREATE TYPE alert_status_enum AS ENUM ('active', 'acknowledged', 'resolved');
CREATE TYPE scan_method_enum AS ENUM ('qr', 'nfc', 'manual');
CREATE TYPE vehicle_dir_enum AS ENUM ('in', 'out');

-- 1. ORGANISATIONS (Multi-Tenancy Root)
CREATE TABLE organisations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    registration_number VARCHAR(100),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    branding_logo_url TEXT,
    primary_color VARCHAR(10) DEFAULT '#0f172a',
    settings JSONB DEFAULT '{"allow_offline": true, "default_round_interval_minutes": 60}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 2. SITES / LOCATIONS
CREATE TABLE sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    default_radius_meters INTEGER DEFAULT 50 NOT NULL,
    day_shift_start TIME DEFAULT '06:00:00' NOT NULL,
    day_shift_end TIME DEFAULT '18:00:00' NOT NULL,
    night_shift_start TIME DEFAULT '18:00:00' NOT NULL,
    night_shift_end TIME DEFAULT '06:00:00' NOT NULL,
    round_interval_minutes INTEGER DEFAULT 60 NOT NULL,
    emergency_phone VARCHAR(50),
    police_phone VARCHAR(50) DEFAULT '10111',
    whatsapp_dispatch_number VARCHAR(50),
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_site_code_org UNIQUE (organisation_id, code)
);

-- 3. USER PROFILES
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    employee_number VARCHAR(50),
    phone_number VARCHAR(50),
    avatar_url TEXT,
    preferred_language VARCHAR(5) DEFAULT 'en' NOT NULL, -- 'en', 'af', 'zu'
    pin_hash VARCHAR(255), -- For fast mobile guard switch/sign-in
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 4. USER ROLES
CREATE TABLE user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role user_role_type NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_user_role UNIQUE (user_id, role)
);

-- 5. SITE ASSIGNMENTS
CREATE TABLE site_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_site_user UNIQUE (site_id, user_id)
);

-- 6. CHECKPOINTS
CREATE TABLE checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    qr_code_hash VARCHAR(128) NOT NULL, -- Secure random identifier e.g. EE-CP-<uuid>
    nfc_uid VARCHAR(128),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    permitted_radius_meters INTEGER DEFAULT 50 NOT NULL,
    order_index INTEGER DEFAULT 0 NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_qr_hash UNIQUE (qr_code_hash)
);

-- 7. SHIFTS
CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    guard_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    shift_type shift_type_enum NOT NULL,
    scheduled_start TIMESTAMPTZ NOT NULL,
    scheduled_end TIMESTAMPTZ NOT NULL,
    actual_start TIMESTAMPTZ,
    actual_end TIMESTAMPTZ,
    start_selfie_url TEXT,
    end_selfie_url TEXT,
    start_latitude DOUBLE PRECISION,
    start_longitude DOUBLE PRECISION,
    end_latitude DOUBLE PRECISION,
    end_longitude DOUBLE PRECISION,
    status shift_status_enum DEFAULT 'active' NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 8. PATROL ROUNDS
CREATE TABLE patrol_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    status round_status_enum DEFAULT 'pending' NOT NULL,
    completed_at TIMESTAMPTZ,
    missed_count INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_shift_round UNIQUE (shift_id, round_number)
);

-- 9. PATROL SCANS (Immutable Audit Trail)
CREATE TABLE patrol_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offline_uuid UUID NOT NULL UNIQUE, -- Client idempotency token
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    patrol_round_id UUID REFERENCES patrol_rounds(id) ON DELETE SET NULL,
    checkpoint_id UUID NOT NULL REFERENCES checkpoints(id) ON DELETE RESTRICT,
    guard_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    scan_timestamp_device TIMESTAMPTZ NOT NULL,
    scan_timestamp_server TIMESTAMPTZ DEFAULT now() NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    accuracy_meters DOUBLE PRECISION,
    distance_to_checkpoint_meters DOUBLE PRECISION,
    is_valid_proximity BOOLEAN DEFAULT true NOT NULL,
    method scan_method_enum DEFAULT 'qr' NOT NULL,
    raw_payload TEXT,
    hash_chain VARCHAR(64), -- SHA-256 chained hash
    prev_hash_chain VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 10. INCIDENTS
CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offline_uuid UUID NOT NULL UNIQUE,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
    guard_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    incident_type VARCHAR(100) NOT NULL, -- 'fence', 'gate', 'stock', 'person', 'fire', 'other'
    severity incident_severity_enum DEFAULT 'medium' NOT NULL,
    description TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    status incident_status_enum DEFAULT 'reported' NOT NULL,
    reported_at TIMESTAMPTZ NOT NULL,
    acknowledged_by UUID REFERENCES profiles(id),
    acknowledged_at TIMESTAMPTZ,
    supervisor_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 11. INCIDENT MEDIA
CREATE TABLE incident_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL,
    media_type VARCHAR(50) DEFAULT 'image/jpeg' NOT NULL,
    file_size_bytes INTEGER,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 12. PANIC / SOS ALERTS
CREATE TABLE panic_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offline_uuid UUID NOT NULL UNIQUE,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
    guard_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    accuracy_meters DOUBLE PRECISION,
    status alert_status_enum DEFAULT 'active' NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL,
    acknowledged_by UUID REFERENCES profiles(id),
    acknowledged_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 13. GATE & VEHICLE ACCESS
CREATE TABLE gate_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offline_uuid UUID NOT NULL UNIQUE,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
    guard_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    direction vehicle_dir_enum NOT NULL,
    license_plate VARCHAR(50) NOT NULL,
    make_model VARCHAR(100),
    vehicle_colour VARCHAR(50),
    disc_expiry_date DATE,
    vin_number VARCHAR(100),
    engine_number VARCHAR(100),
    driver_name VARCHAR(255),
    driver_phone VARCHAR(50),
    company VARCHAR(255),
    visit_reason TEXT,
    person_visited VARCHAR(255),
    is_disc_scanned BOOLEAN DEFAULT false NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    exit_time TIMESTAMPTZ,
    dwell_duration_seconds INTEGER,
    vehicle_photo_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 14. AUDIT LOGS
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id UUID,
    details JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 15. SYNC EVENT QUEUE LOG
CREATE TABLE sync_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(255) NOT NULL,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    events_count INTEGER NOT NULL,
    successful_count INTEGER NOT NULL,
    failed_count INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ========================================================================
-- INDEXES FOR PERFORMANCE & FAST LOOKUPS
-- ========================================================================
CREATE INDEX idx_sites_org ON sites(organisation_id);
CREATE INDEX idx_profiles_org ON profiles(organisation_id);
CREATE INDEX idx_checkpoints_site ON checkpoints(site_id);
CREATE INDEX idx_shifts_site_guard ON shifts(site_id, guard_id, status);
CREATE INDEX idx_patrol_rounds_shift ON patrol_rounds(shift_id);
CREATE INDEX idx_patrol_scans_shift ON patrol_scans(shift_id);
CREATE INDEX idx_patrol_scans_checkpoint ON patrol_scans(checkpoint_id);
CREATE INDEX idx_incidents_site_status ON incidents(site_id, status);
CREATE INDEX idx_panic_alerts_site_status ON panic_alerts(site_id, status);
CREATE INDEX idx_gate_entries_site_plate ON gate_entries(site_id, license_plate);
CREATE INDEX idx_audit_org ON audit_logs(organisation_id);

-- ========================================================================
-- HELPER FUNCTIONS FOR RLS (Security Context)
-- ========================================================================

-- Get current authenticated user's organization
CREATE OR REPLACE FUNCTION get_auth_org_id()
RETURNS UUID AS $$
  SELECT organisation_id FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if current authenticated user has a specific role
CREATE OR REPLACE FUNCTION has_role(required_role user_role_type)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role = required_role
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if current user is admin or supervisor in their org
CREATE OR REPLACE FUNCTION is_manager()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin', 'supervisor')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if current user is assigned to a specific site
CREATE OR REPLACE FUNCTION is_assigned_to_site(target_site_id UUID)
RETURNS BOOLEAN AS $$
  SELECT is_manager() OR EXISTS (
    SELECT 1 FROM site_assignments 
    WHERE user_id = auth.uid() AND site_id = target_site_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ========================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ========================================================================

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE patrol_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE patrol_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE panic_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;

-- ORGANISATIONS: Users can only see their own organization
CREATE POLICY "Users can view their own organisation" ON organisations
    FOR SELECT USING (id = get_auth_org_id());

CREATE POLICY "Super admins can update organisation" ON organisations
    FOR UPDATE USING (id = get_auth_org_id() AND has_role('super_admin'));

-- SITES: Scoped to user's organisation
CREATE POLICY "Users can view sites in their org" ON sites
    FOR SELECT USING (organisation_id = get_auth_org_id());

CREATE POLICY "Admins can manage sites" ON sites
    FOR ALL USING (organisation_id = get_auth_org_id() AND is_manager());

-- PROFILES: Users can view colleagues in same org, update self
CREATE POLICY "Users can view profiles in their org" ON profiles
    FOR SELECT USING (organisation_id = get_auth_org_id());

CREATE POLICY "Users can update their own profile" ON profiles
    FOR UPDATE USING (id = auth.uid());

CREATE POLICY "Admins can manage profiles" ON profiles
    FOR ALL USING (organisation_id = get_auth_org_id() AND is_manager());

-- USER ROLES:
CREATE POLICY "Users can view user roles in their org" ON user_roles
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM profiles p 
            WHERE p.id = user_roles.user_id AND p.organisation_id = get_auth_org_id()
        )
    );

CREATE POLICY "Admins can manage user roles" ON user_roles
    FOR ALL USING (is_manager());

-- CHECKPOINTS: Accessible to guards assigned to site, managed by admins
CREATE POLICY "Users can view checkpoints at their sites" ON checkpoints
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = checkpoints.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

CREATE POLICY "Admins can manage checkpoints" ON checkpoints
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = checkpoints.site_id AND s.organisation_id = get_auth_org_id() AND is_manager()
        )
    );

-- SHIFTS: Guards see their own shifts; Supervisors/Admins see all site shifts
CREATE POLICY "Guards can see own shifts, managers see all org shifts" ON shifts
    FOR SELECT USING (
        guard_id = auth.uid() OR (
            EXISTS (
                SELECT 1 FROM sites s 
                WHERE s.id = shifts.site_id AND s.organisation_id = get_auth_org_id() AND is_manager()
            )
        )
    );

CREATE POLICY "Guards can insert own shifts" ON shifts
    FOR INSERT WITH CHECK (
        guard_id = auth.uid() AND EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = shifts.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

CREATE POLICY "Guards can update own active shift" ON shifts
    FOR UPDATE USING (
        guard_id = auth.uid() OR is_manager()
    );

-- PATROL SCANS: Guards can insert scans; Users can view scans scoped to org
CREATE POLICY "Guards can record scans" ON patrol_scans
    FOR INSERT WITH CHECK (
        guard_id = auth.uid()
    );

CREATE POLICY "Users can view scans in their org" ON patrol_scans
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM shifts sh
            JOIN sites s ON s.id = sh.site_id
            WHERE sh.id = patrol_scans.shift_id AND s.organisation_id = get_auth_org_id()
        )
    );

-- INCIDENTS: Guards can report incidents; Managers can view & acknowledge
CREATE POLICY "Guards can insert incidents" ON incidents
    FOR INSERT WITH CHECK (
        guard_id = auth.uid()
    );

CREATE POLICY "Users can view incidents in their org" ON incidents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = incidents.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

CREATE POLICY "Managers can update incidents" ON incidents
    FOR UPDATE USING (
        is_manager() AND EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = incidents.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

-- PANIC ALERTS: Insertable by guard, viewable & ackable by org managers
CREATE POLICY "Guards can trigger panic alert" ON panic_alerts
    FOR INSERT WITH CHECK (
        guard_id = auth.uid()
    );

CREATE POLICY "Users can view panic alerts in their org" ON panic_alerts
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = panic_alerts.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

CREATE POLICY "Managers can acknowledge panic alerts" ON panic_alerts
    FOR UPDATE USING (
        is_manager() AND EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = panic_alerts.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

-- GATE ENTRIES:
CREATE POLICY "Guards can manage gate entries" ON gate_entries
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM sites s 
            WHERE s.id = gate_entries.site_id AND s.organisation_id = get_auth_org_id()
        )
    );

-- ========================================================================
-- AUTOMATIC TIMESTAMPS & AUDIT TRIGGERS
-- ========================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trg_organisations_updated_at BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_sites_updated_at BEFORE UPDATE ON sites FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_checkpoints_updated_at BEFORE UPDATE ON checkpoints FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_shifts_updated_at BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER trg_panic_alerts_updated_at BEFORE UPDATE ON panic_alerts FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
