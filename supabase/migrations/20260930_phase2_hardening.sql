-- ========================================================================
-- EAGLE EYE SECURITY OPERATIONS PLATFORM - PHASE 2 ENTERPRISE HARDENING
-- Storage Security, Multi-Tenant Boundary Enforcement, Immutability & Client Viewer
-- ========================================================================

-- 1. STORAGE SECURITY: evidence-media private bucket policies
-- Make sure the bucket exists and is marked PRIVATE
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

-- Enable RLS on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Storage Policy: Users can only upload media to their own organisation's directory
-- Path pattern: <site_id>/<event_type>/<offline_uuid>-<field>.jpg
CREATE POLICY "Allow org users to upload evidence media"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'evidence-media' AND
    auth.role() = 'authenticated' AND
    EXISTS (
        SELECT 1 FROM sites s
        WHERE s.id::text = (storage.foldername(name))[1]
        AND s.organisation_id = get_auth_org_id()
    )
);

-- Storage Policy: Users can only view media within their own organisation
CREATE POLICY "Allow org users to view evidence media"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'evidence-media' AND
    (
        auth.role() = 'authenticated' AND
        EXISTS (
            SELECT 1 FROM sites s
            WHERE s.id::text = (storage.foldername(name))[1]
            AND s.organisation_id = get_auth_org_id()
        )
    )
);

-- 2. CLIENT VIEWER ROLE PERMISSIONS
-- Client viewers have strictly READ-ONLY access to permitted sites and reports
CREATE OR REPLACE FUNCTION is_client_viewer()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() AND role = 'client_viewer'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Update site policy to include client viewers for assigned sites
CREATE POLICY "Client viewers can view permitted sites" ON sites
    FOR SELECT USING (
        organisation_id = get_auth_org_id() AND is_assigned_to_site(id)
    );

-- 3. AUDIT LOG IMMUTABILITY: Prevent any user from updating or deleting audit logs
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit log entries are strictly immutable. Deletions and modifications are prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();

-- 4. FAST DWELL DURATION & VEHICLE LOOKUP INDEXES
CREATE INDEX IF NOT EXISTS idx_gate_entries_site_dir_entry 
ON gate_entries(site_id, direction, entry_time DESC);

CREATE INDEX IF NOT EXISTS idx_patrol_scans_guard_timestamp 
ON patrol_scans(guard_id, scan_timestamp_device DESC);

-- 5. CRYPTOGRAPHIC GUARD PIN VERIFICATION
CREATE OR REPLACE FUNCTION verify_guard_pin(guard_profile_id UUID, input_pin TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    stored_hash TEXT;
BEGIN
    SELECT pin_hash INTO stored_hash FROM profiles WHERE id = guard_profile_id AND is_active = true;
    IF stored_hash IS NULL THEN
        RETURN FALSE;
    END IF;
    -- Compare crypt hash
    RETURN stored_hash = crypt(input_pin, stored_hash);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
