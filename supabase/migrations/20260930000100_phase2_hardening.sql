-- ========================================================================
-- EAGLE EYE SECURITY OPERATIONS PLATFORM - PHASE 2 ENTERPRISE HARDENING
-- Security Hardening, Role Elevation Prevention, Storage & Realtime
-- ========================================================================
-- This is the version of phase 2 that is live on the production project.
-- Several of its policies (org-unscoped storage access, is_admin() without an
-- organisation check) are superseded by 20261001000000_security_audit_hardening.sql.

-- 0. SAFETY NET: applying this file after the hardening migration (e.g. a
-- `supabase db push` on a project that was set up through the SQL Editor) would
-- put the permissive policies back, so it refuses. Mark it applied instead:
--   supabase migration repair --status applied 20260930000100
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'ee_evidence_insert') THEN
        RAISE EXCEPTION 'Phase 2 (20260930000100) must not run after 20261001000000_security_audit_hardening: it would restore permissive policies. Run: supabase migration repair --status applied 20260930000100';
    END IF;
END $$;

-- 1. IS_ADMIN HELPER FUNCTION & ROLE ELEVATION PREVENTION
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Fix user_roles policy: ONLY admins can manage roles (prevents supervisors granting themselves super_admin)
DROP POLICY IF EXISTS "Admins can manage user roles" ON user_roles;
CREATE POLICY "Admins can manage user roles" ON user_roles
    FOR ALL USING (is_admin());

-- 2. CLIENT VIEWER ROLE SECURITY
-- Client viewers have strictly READ-ONLY access to permitted sites and reports
CREATE OR REPLACE FUNCTION is_client_viewer()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role = 'client_viewer'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Update site policy to include client viewers for assigned sites
DROP POLICY IF EXISTS "Client viewers can view permitted sites" ON sites;
CREATE POLICY "Client viewers can view permitted sites" ON sites
    FOR SELECT USING (
        organisation_id = get_auth_org_id() AND is_assigned_to_site(id)
    );

-- 3. FIX INCIDENT MEDIA RLS POLICIES (Previously had RLS enabled but 0 policies)
DROP POLICY IF EXISTS "Users can insert incident media" ON incident_media;
CREATE POLICY "Users can insert incident media" ON incident_media
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM incidents i
            JOIN sites s ON s.id = i.site_id
            WHERE i.id = incident_media.incident_id 
            AND s.organisation_id = get_auth_org_id()
        )
    );

DROP POLICY IF EXISTS "Users can view incident media in their org" ON incident_media;
CREATE POLICY "Users can view incident media in their org" ON incident_media
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM incidents i
            JOIN sites s ON s.id = i.site_id
            WHERE i.id = incident_media.incident_id 
            AND s.organisation_id = get_auth_org_id()
        )
    );

-- 4. STORAGE SECURITY: evidence-media private bucket policies
-- Ensure the bucket is private
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'evidence-media', 
    'evidence-media', 
    false, -- STRICTLY PRIVATE
    10485760, -- 10MB limit per evidence photograph
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET 
    public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- Storage Policy: Authenticated org users can upload evidence media
DROP POLICY IF EXISTS "Allow authenticated users to upload evidence media" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload evidence media"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'evidence-media' AND
    auth.role() = 'authenticated'
);

-- Storage Policy: Authenticated org users can view evidence media
DROP POLICY IF EXISTS "Allow authenticated users to view evidence media" ON storage.objects;
CREATE POLICY "Allow authenticated users to view evidence media"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'evidence-media' AND
    auth.role() = 'authenticated'
);

-- 5. AUDIT LOG IMMUTABILITY: Prevent any user from updating or deleting audit logs
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit log entries are strictly immutable. Deletions and modifications are prohibited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();

-- 6. FAST LOOKUP INDEXES
CREATE INDEX IF NOT EXISTS idx_gate_entries_site_dir_entry 
ON gate_entries(site_id, direction, entry_time DESC);

CREATE INDEX IF NOT EXISTS idx_patrol_scans_guard_timestamp 
ON patrol_scans(guard_id, scan_timestamp_device DESC);

-- 7. SUPABASE REALTIME CONFIGURATION
-- Publish operational tables to Realtime for live supervisor command dashboard
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'patrol_scans') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE patrol_scans;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'incidents') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE incidents;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'panic_alerts') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE panic_alerts;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'gate_entries') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE gate_entries;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'shifts') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE shifts;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        NULL; -- Realtime publication may already manage these tables
END $$;
