-- ========================================================================
-- EAGLE EYE SECURITY - SECURITY AUDIT HARDENING (2026-10-01)
--
-- Fixes the database findings of the security audit and its re-review:
--   * privilege escalation through user_roles / profiles self-updates,
--     organisation hops, super_admin removal
--   * cross-tenant and cross-site writes (scans, incidents, SOS, gate log,
--     shift reassignment)
--   * client_viewer write access and PII exposure, supervisor org-wide access
--   * disabled accounts keeping access
--   * client-controlled patrol proof (server time, distance, validity,
--     schedule, created_at, backdated / forward-dated evidence)
--   * readable QR tokens / NFC serials (stored secrets are hidden from
--     everyone except org admins; guards get SHA-256 hashes)
--   * offline replays and queued evidence that were rejected after a later
--     state change (replays are now no-ops; capture-time rules apply)
--   * unauthenticated PIN oracle (verify_guard_pin) and readable pin_hash
--   * private evidence storage policies bound to the event, realtime
--     publication, audit trail, RLS read performance
--
-- Model (see CONTRACT section 1):
--   admin / super_admin  -> whole organisation
--   supervisor           -> only sites they are assigned to
--   guard                -> writes only for sites they are assigned to, or
--                           for their own shift at that site (evidence that
--                           was captured before an unassignment still syncs)
--   client_viewer        -> read-only on assigned sites (no SOS, no selfies,
--                           no colleague contact details, no tag secrets)
--   is_active = false    -> no access (only their own profile row stays
--                           readable so the app can say "account disabled")
--
-- What the server can and cannot prove: payload_verified means the phone
-- submitted the checkpoint's QR token / NFC serial; the GPS verdict is
-- computed from coordinates and accuracy REPORTED BY THE PHONE. Neither
-- proves physical presence on its own (a photographed card, a cloned or
-- previously read tag or a spoofed location are not detectable here). The
-- sync delay (scan_timestamp_server - scan_timestamp_device, created_at vs
-- the device time) is kept so reports can flag late uploads.
--
-- This migration is IDEMPOTENT: every statement can be re-run safely.
-- It does not create objects in the auth or storage schemas and does not
-- ALTER storage tables (policies on storage.objects only).
-- ========================================================================


-- ========================================================================
-- 0. REMOVE THE GUARD PIN ORACLE
--    verify_guard_pin() was SECURITY DEFINER and callable by anon, and
--    profiles.pin_hash (4-digit bcrypt) was readable by every org member.
--    Guards now sign in with real Supabase Auth credentials.
-- ========================================================================
DROP FUNCTION IF EXISTS public.verify_guard_pin(uuid, text);
ALTER TABLE public.profiles DROP COLUMN IF EXISTS pin_hash;


-- ========================================================================
-- 1. PURE HELPERS (no table access)
-- ========================================================================

-- Canonical NFC tag serial: strip every non-hex character, lower-case, split
-- into bytes joined by ':' (e.g. '04:a2:3b:1c:5d:80:00'). Returns NULL when
-- nothing usable remains, the hex length is odd, or the serial is shorter than
-- 4 or longer than 10 bytes (ISO 14443-A UIDs are 4, 7 or 10 bytes).
-- Must stay identical to normalizeNfcSerial() in src/lib/nfc/webNfc.ts.
CREATE OR REPLACE FUNCTION public.normalize_nfc_uid(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN length(h.hex) = 0 OR length(h.hex) % 2 = 1
             OR length(h.hex) < 8 OR length(h.hex) > 20 THEN NULL
           ELSE (
             SELECT string_agg(substr(h.hex, i, 2), ':' ORDER BY i)
             FROM generate_series(1, length(h.hex), 2) AS i
           )
         END
  FROM (SELECT lower(regexp_replace(coalesce(raw, ''), '[^0-9A-Fa-f]', '', 'g')) AS hex) AS h
$$;

-- Great-circle distance in metres (haversine, mean Earth radius 6 371 008.8 m).
-- Must stay identical to calculateDistanceMeters() in src/lib/gps/haversine.ts.
CREATE OR REPLACE FUNCTION public.haversine_distance_meters(
    lat1 double precision, lon1 double precision,
    lat2 double precision, lon2 double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT 2 * 6371008.8 * asin(least(1.0::double precision, sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2)
           + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
         )))
$$;

-- GPS confidence for a scan at distance d (m) with reported accuracy a (m)
-- against a checkpoint radius r (m). Identical rules to
-- classifyGpsConfidence() in src/lib/gps/haversine.ts:
--   d + a <= r          -> verified
--   d <= r AND a <= r   -> likely
--   d - a > r           -> outside
--   otherwise           -> low_confidence  (also when accuracy is unknown)
-- A missing/non-positive radius counts as 'no_reference' and a missing
-- distance as 'no_fix' (the trigger decides those from coordinates first).
-- The inputs are what the phone reported: this is not proof of presence.
CREATE OR REPLACE FUNCTION public.classify_gps_confidence(
    distance_meters double precision,
    accuracy_meters double precision,
    radius_meters double precision)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN radius_meters IS NULL OR radius_meters <= 0 OR radius_meters = 'NaN'::float8
             OR radius_meters = 'Infinity'::float8 THEN 'no_reference'
           WHEN distance_meters IS NULL OR distance_meters < 0 OR distance_meters = 'NaN'::float8
             OR distance_meters = 'Infinity'::float8 THEN 'no_fix'
           WHEN accuracy_meters IS NULL OR accuracy_meters < 0 OR accuracy_meters = 'NaN'::float8
             OR accuracy_meters = 'Infinity'::float8 THEN
             'low_confidence'
           WHEN distance_meters + accuracy_meters <= radius_meters THEN 'verified'
           WHEN distance_meters <= radius_meters AND accuracy_meters <= radius_meters THEN 'likely'
           WHEN distance_meters - accuracy_meters > radius_meters THEN 'outside'
           ELSE 'low_confidence'
         END
$$;

-- uuid or NULL, never an exception (used to parse storage object paths).
CREATE OR REPLACE FUNCTION public.try_uuid(value text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN value::uuid
         END
$$;

-- Lower-case hex SHA-256 of the UTF-8 text (NULL for NULL). The app hashes the
-- scanned QR token (as printed, upper case) and the normalised NFC serial the
-- same way (crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).
CREATE OR REPLACE FUNCTION public.sha256_hex(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(value, 'UTF8')), 'hex')
$$;

-- Evidence time rules (one place to change them):
--   device times may be at most device_clock_tolerance() ahead of the server,
--   evidence older than evidence_max_age() is refused (offline queue limit),
--   an open shift accepts evidence for at most max_shift_length() after
--   clock-in.
CREATE OR REPLACE FUNCTION public.evidence_max_age()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '7 days' $$;

CREATE OR REPLACE FUNCTION public.device_clock_tolerance()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '10 minutes' $$;

CREATE OR REPLACE FUNCTION public.max_shift_length()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT interval '24 hours' $$;

-- Canonical evidence object name (see buildEvidencePath() in
-- src/lib/storage/evidence.ts):
--   {org uuid}/{site uuid}/{selfie|incident|vehicle|patrol}/{user uuid}/{event uuid}-{field}.{jpg|png|webp}
-- UUIDs in canonical lower-case form, field [a-z0-9_]{1,32}.
CREATE OR REPLACE FUNCTION public.is_evidence_object_name(name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(name ~ ('^'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '(selfie|incident|vehicle|patrol)/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9_]{1,32}\.(jpg|png|webp)$'), false)
$$;

-- The stored *_url path is a canonical evidence name for exactly this
-- organisation, site, category and user (and event, when given).
CREATE OR REPLACE FUNCTION public.is_evidence_path(
    path text, org uuid, site uuid, category text, owner uuid, event uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
           public.is_evidence_object_name(path)
           AND split_part(path, '/', 1) = org::text
           AND split_part(path, '/', 2) = site::text
           AND split_part(path, '/', 3) = category
           AND split_part(path, '/', 4) = owner::text
           AND (event IS NULL OR left(split_part(path, '/', 5), 37) = event::text || '-'),
         false)
$$;


-- ========================================================================
-- 2. SCHEMA ADDITIONS + BACKFILLS
--    Backfills run before the triggers of section 4 exist on a first run; on
--    a re-run their WHERE clauses match nothing, so no trigger fires.
-- ========================================================================

-- 2a. checkpoints --------------------------------------------------------
-- deactivated_at first: its backfill uses updated_at, which the other
-- backfills below touch.
ALTER TABLE public.checkpoints
    ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

UPDATE public.checkpoints
SET deactivated_at = updated_at
WHERE NOT is_active AND deactivated_at IS NULL;

ALTER TABLE public.checkpoints
    ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS legacy_code varchar(64),
    ADD COLUMN IF NOT EXISTS nfc_enrolled_at timestamptz,
    ADD COLUMN IF NOT EXISTS nfc_enrolled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- Non-secret fingerprints the guard app matches scans against offline.
    -- The raw qr_code_hash (the printed token) and nfc_uid are readable only
    -- by org admins (column privileges, section 8; get_checkpoint_secrets()).
    ADD COLUMN IF NOT EXISTS qr_token_sha256 text,
    ADD COLUMN IF NOT EXISTS nfc_uid_sha256 text,
    -- false for weak / legacy-format tokens: rotate and reprint those cards.
    ADD COLUMN IF NOT EXISTS qr_token_strong boolean
        GENERATED ALWAYS AS ((qr_code_hash)::text ~ '^EE-CP-[0-9A-F]{32}$') STORED;

UPDATE public.checkpoints c
SET organisation_id = s.organisation_id
FROM public.sites s
WHERE s.id = c.site_id
  AND c.organisation_id IS DISTINCT FROM s.organisation_id;

ALTER TABLE public.checkpoints ALTER COLUMN organisation_id SET NOT NULL;

-- Store every existing NFC serial in canonical form. Values that cannot be a
-- real ISO 14443-A UID are cleared (the tag must be re-enrolled).
UPDATE public.checkpoints
SET nfc_uid = public.normalize_nfc_uid(nfc_uid)
WHERE nfc_uid IS NOT NULL
  AND nfc_uid IS DISTINCT FROM public.normalize_nfc_uid(nfc_uid);

-- One physical tag may identify only one checkpoint per organisation. If
-- legacy data linked the same tag to several checkpoints, keep the oldest
-- link and clear the others so the unique index below can be created.
DO $$
DECLARE
    v_cleared integer;
BEGIN
    WITH ranked AS (
        SELECT id,
               row_number() OVER (PARTITION BY organisation_id, nfc_uid
                                  ORDER BY created_at, id) AS rn
        FROM public.checkpoints
        WHERE nfc_uid IS NOT NULL
    )
    UPDATE public.checkpoints c
    SET nfc_uid = NULL
    FROM ranked r
    WHERE r.id = c.id AND r.rn > 1;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    IF v_cleared > 0 THEN
        RAISE WARNING 'Cleared % duplicate NFC tag link(s); re-enrol those checkpoints.', v_cleared;
    END IF;
END $$;

UPDATE public.checkpoints
SET qr_token_sha256 = public.sha256_hex(qr_code_hash),
    nfc_uid_sha256 = public.sha256_hex(nfc_uid)
WHERE qr_token_sha256 IS DISTINCT FROM public.sha256_hex(qr_code_hash)
   OR nfc_uid_sha256 IS DISTINCT FROM public.sha256_hex(nfc_uid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkpoints_org_nfc_uid
    ON public.checkpoints (organisation_id, nfc_uid)
    WHERE nfc_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkpoints_site_legacy_code
    ON public.checkpoints (site_id, legacy_code)
    WHERE legacy_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkpoints_org ON public.checkpoints (organisation_id);

-- 2b. sites --------------------------------------------------------------
-- Whether guards may still scan Dawie's printed PLAAS-CP:<code> cards on this
-- site. Those codes are public, so such scans are never payload_verified;
-- switch this off once EE-CP cards are posted. Enabled in section 9 only for
-- sites whose demo checkpoints were migrated to legacy codes.
ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS allow_legacy_qr boolean NOT NULL DEFAULT false;

-- 2c. patrol_scans -------------------------------------------------------
ALTER TABLE public.patrol_scans
    ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES public.sites(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS gps_confidence text,
    ADD COLUMN IF NOT EXISTS gps_error text,
    ADD COLUMN IF NOT EXISTS location_timestamp timestamptz,
    ADD COLUMN IF NOT EXISTS checkpoint_radius_meters integer,
    ADD COLUMN IF NOT EXISTS payload_type text,
    -- Server verdict: did raw_payload match the scanned checkpoint's secret
    -- (strong QR token / enrolled NFC serial)? Computed by trigger only.
    -- Legacy PLAAS-CP cards and manual entries are never verified.
    ADD COLUMN IF NOT EXISTS payload_verified boolean;

UPDATE public.patrol_scans ps
SET site_id = sh.site_id
FROM public.shifts sh
WHERE sh.id = ps.shift_id
  AND ps.site_id IS DISTINCT FROM sh.site_id;

ALTER TABLE public.patrol_scans ALTER COLUMN site_id SET NOT NULL;

ALTER TABLE public.patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_gps_confidence_check;
ALTER TABLE public.patrol_scans ADD CONSTRAINT patrol_scans_gps_confidence_check
    CHECK (gps_confidence IS NULL OR gps_confidence IN
           ('verified', 'likely', 'low_confidence', 'outside', 'no_fix', 'no_reference'));

ALTER TABLE public.patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_gps_error_check;
ALTER TABLE public.patrol_scans ADD CONSTRAINT patrol_scans_gps_error_check
    CHECK (gps_error IS NULL OR gps_error IN
           ('permission_denied', 'timeout', 'unavailable', 'unsupported', 'insecure', 'stale'));

ALTER TABLE public.patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_payload_type_check;
ALTER TABLE public.patrol_scans ADD CONSTRAINT patrol_scans_payload_type_check
    CHECK (payload_type IS NULL OR payload_type IN ('secure_token', 'legacy_qr', 'nfc_uid', 'manual'));

-- The scan method must agree with what was scanned (new rows; NOT VALID keeps
-- rows recorded before payload_type existed).
ALTER TABLE public.patrol_scans DROP CONSTRAINT IF EXISTS patrol_scans_method_payload_check;
ALTER TABLE public.patrol_scans ADD CONSTRAINT patrol_scans_method_payload_check
    CHECK (payload_type IS NULL
           OR (method = 'nfc' AND payload_type = 'nfc_uid')
           OR (method = 'qr' AND payload_type IN ('secure_token', 'legacy_qr'))
           OR (method = 'manual' AND payload_type = 'manual')) NOT VALID;

-- Scan rows are readable by supervisors and client viewers: they must never
-- carry a checkpoint secret. Earlier rows that stored the raw QR token or NFC
-- serial keep only its SHA-256 (still comparable with qr_token_sha256 /
-- nfc_uid_sha256).
UPDATE public.patrol_scans
SET raw_payload = 'sha256:' || public.sha256_hex(
        CASE WHEN method = 'nfc'
             THEN coalesce(public.normalize_nfc_uid(raw_payload), btrim(raw_payload))
             ELSE upper(btrim(raw_payload))
        END)
WHERE raw_payload IS NOT NULL
  AND raw_payload NOT LIKE 'sha256:%'
  AND (payload_type IN ('secure_token', 'nfc_uid')
       OR (payload_type IS NULL AND (method = 'nfc' OR raw_payload ~* '^\s*EE-CP-')));

CREATE INDEX IF NOT EXISTS idx_patrol_scans_site_time
    ON public.patrol_scans (site_id, scan_timestamp_device DESC);

-- 2d. shifts / incidents -------------------------------------------------
-- start_selfie_url / end_selfie_url now hold the evidence-media STORAGE PATH.
ALTER TABLE public.shifts
    ADD COLUMN IF NOT EXISTS start_accuracy_meters double precision,
    ADD COLUMN IF NOT EXISTS end_accuracy_meters double precision;

-- incident_media.media_url now holds the evidence-media STORAGE PATH.
ALTER TABLE public.incidents
    ADD COLUMN IF NOT EXISTS accuracy_meters double precision;

-- 2e. gate_entries -------------------------------------------------------
-- vehicle_photo_url now holds the evidence-media STORAGE PATH.
-- A vehicle leaving is a new 'out' row linked to its 'in' row (the gate log is
-- append-only; rows are never updated).
ALTER TABLE public.gate_entries
    ADD COLUMN IF NOT EXISTS latitude double precision,
    ADD COLUMN IF NOT EXISTS longitude double precision,
    ADD COLUMN IF NOT EXISTS accuracy_meters double precision,
    ADD COLUMN IF NOT EXISTS register_number varchar(50),
    ADD COLUMN IF NOT EXISTS vehicle_description varchar(120),
    ADD COLUMN IF NOT EXISTS linked_entry_id uuid REFERENCES public.gate_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gate_entries_linked ON public.gate_entries (linked_entry_id)
    WHERE linked_entry_id IS NOT NULL;

ALTER TABLE public.gate_entries DROP CONSTRAINT IF EXISTS gate_entries_exit_after_entry_check;
ALTER TABLE public.gate_entries ADD CONSTRAINT gate_entries_exit_after_entry_check
    CHECK (exit_time IS NULL OR exit_time >= entry_time) NOT VALID;
ALTER TABLE public.gate_entries DROP CONSTRAINT IF EXISTS gate_entries_dwell_check;
ALTER TABLE public.gate_entries ADD CONSTRAINT gate_entries_dwell_check
    CHECK (dwell_duration_seconds IS NULL OR dwell_duration_seconds >= 0) NOT VALID;

-- 2f. Evidence must survive site deletion: sites with shift, scan, incident,
--     SOS or gate history can only be deactivated (is_active = false).
ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_site_id_fkey;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_site_id_fkey;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE public.panic_alerts DROP CONSTRAINT IF EXISTS panic_alerts_site_id_fkey;
ALTER TABLE public.panic_alerts ADD CONSTRAINT panic_alerts_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;
ALTER TABLE public.gate_entries DROP CONSTRAINT IF EXISTS gate_entries_site_id_fkey;
ALTER TABLE public.gate_entries ADD CONSTRAINT gate_entries_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;

-- 2g. The audit trail keeps the actor's id even after that user is deleted.
--     (A foreign key with ON DELETE SET NULL would have to UPDATE immutable
--     audit rows, so deleting any user who ever acted failed.)
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_id_fkey;

-- 2h. A guard has at most one open (active) shift. Older duplicates from
--     before this rule are marked abandoned so the unique index can exist.
DO $$
DECLARE
    v_closed integer;
BEGIN
    WITH ranked AS (
        SELECT id,
               row_number() OVER (PARTITION BY guard_id
                                  ORDER BY coalesce(actual_start, scheduled_start) DESC, created_at DESC, id) AS rn
        FROM public.shifts
        WHERE status = 'active'
    )
    UPDATE public.shifts s
    SET status = 'abandoned',
        notes = concat_ws(E'\n', nullif(s.notes, ''),
                          'Closed by the 2026-10-01 security migration: a newer shift of this guard was open.')
    FROM ranked r
    WHERE r.id = s.id AND r.rn > 1;
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    IF v_closed > 0 THEN
        RAISE WARNING 'Marked % older open shift(s) as abandoned (one open shift per guard).', v_closed;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_one_open_per_guard
    ON public.shifts (guard_id)
    WHERE status = 'active';

-- 2i. Indexes used by the policies and evidence checks.
CREATE INDEX IF NOT EXISTS idx_site_assignments_user ON public.site_assignments (user_id, site_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles (user_id, role);
CREATE INDEX IF NOT EXISTS idx_shifts_guard_status ON public.shifts (guard_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_guard ON public.incidents (guard_id);
CREATE INDEX IF NOT EXISTS idx_panic_alerts_guard ON public.panic_alerts (guard_id);
CREATE INDEX IF NOT EXISTS idx_incident_media_incident ON public.incident_media (incident_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start_selfie ON public.shifts (start_selfie_url)
    WHERE start_selfie_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_end_selfie ON public.shifts (end_selfie_url)
    WHERE end_selfie_url IS NOT NULL;


-- ========================================================================
-- 3. SECURITY CONTEXT HELPERS
--    SECURITY DEFINER (they read profiles / user_roles / site_assignments
--    without recursing into RLS), STABLE, pinned search_path, fully
--    qualified names. Execute: authenticated + service_role only.
-- ========================================================================

-- Organisation of the caller, or NULL when the caller has no ACTIVE profile.
-- Every org-scoped policy compares against this, so a disabled account is
-- locked out server-side.
CREATE OR REPLACE FUNCTION public.get_auth_org_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.organisation_id
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active
$$;

-- auth.uid() when the caller's profile is active, else NULL.
CREATE OR REPLACE FUNCTION public.active_uid()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active
$$;

CREATE OR REPLACE FUNCTION public.has_role(required_role user_role_type)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role = required_role
      AND p.is_active
  )
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('admin', 'super_admin')
      AND p.is_active
  )
$$;

-- Kept for compatibility with existing callers; no longer used by policies.
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('admin', 'super_admin', 'supervisor')
      AND p.is_active
  )
$$;

-- Kept for compatibility (phase 2 created it).
CREATE OR REPLACE FUNCTION public.is_client_viewer()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.has_role('client_viewer')
$$;

-- Caller has an explicit site_assignments row for the site, and the site is
-- in the caller's (active) organisation. No implicit manager bypass.
CREATE OR REPLACE FUNCTION public.is_assigned_to_site(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.site_assignments sa
    JOIN public.sites s ON s.id = sa.site_id
    WHERE sa.user_id = auth.uid()
      AND sa.site_id = target_site_id
      AND s.organisation_id = public.get_auth_org_id()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_org_site(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sites s
    WHERE s.id = target_site_id
      AND s.organisation_id = public.get_auth_org_id()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_org_user(target_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = target_user_id
      AND p.organisation_id = public.get_auth_org_id()
  )
$$;

-- Site in caller org AND (org admin OR assigned to the site).
CREATE OR REPLACE FUNCTION public.is_site_member(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_org_site(target_site_id)
     AND (public.is_org_admin() OR public.is_assigned_to_site(target_site_id))
$$;

-- Org admins manage every site of their org; supervisors only assigned sites.
CREATE OR REPLACE FUNCTION public.can_manage_site(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_org_site(target_site_id)
     AND (public.is_org_admin()
          OR (public.has_role('supervisor') AND public.is_assigned_to_site(target_site_id)))
$$;

CREATE OR REPLACE FUNCTION public.is_site_guard(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.has_role('guard') AND public.is_assigned_to_site(target_site_id)
$$;

CREATE OR REPLACE FUNCTION public.is_site_viewer(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.has_role('client_viewer') AND public.is_assigned_to_site(target_site_id)
$$;

-- ---- Set-returning variants for SELECT policies ----------------------------
-- Policies call these once per statement as `site_id = ANY ((SELECT f())::uuid[])`
-- (an InitPlan), instead of calling a SECURITY DEFINER helper for every row
-- of every tenant.

-- Sites of the caller's organisation the caller is assigned to.
CREATE OR REPLACE FUNCTION public.assigned_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(sa.site_id), '{}'::uuid[])
  FROM public.site_assignments sa
  JOIN public.sites s ON s.id = sa.site_id
  WHERE sa.user_id = auth.uid()
    AND s.organisation_id = public.get_auth_org_id()
$$;

-- Every site of the caller's organisation (org admins only).
CREATE OR REPLACE FUNCTION public.org_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(s.id), '{}'::uuid[])
  FROM public.sites s
  WHERE s.organisation_id = public.get_auth_org_id()
    AND public.is_org_admin()
$$;

-- Sites the caller may read at all (is_site_member).
CREATE OR REPLACE FUNCTION public.member_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_org_admin() THEN public.org_site_ids()
              ELSE public.assigned_site_ids() END
$$;

-- Sites the caller manages (can_manage_site).
CREATE OR REPLACE FUNCTION public.managed_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_org_admin() THEN public.org_site_ids()
              WHEN public.has_role('supervisor') THEN public.assigned_site_ids()
              ELSE '{}'::uuid[] END
$$;

-- Sites the caller watches as a client viewer (is_site_viewer).
CREATE OR REPLACE FUNCTION public.viewer_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.has_role('client_viewer') THEN public.assigned_site_ids()
              ELSE '{}'::uuid[] END
$$;

-- Managed or viewed sites: the sites whose shifts, scans and incidents the
-- caller may report on.
CREATE OR REPLACE FUNCTION public.report_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY(SELECT unnest(public.managed_site_ids())
               UNION
               SELECT unnest(public.viewer_site_ids()))
$$;

-- Profiles of the caller's organisation (org admins only).
CREATE OR REPLACE FUNCTION public.org_user_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(p.id), '{}'::uuid[])
  FROM public.profiles p
  WHERE p.organisation_id = public.get_auth_org_id()
    AND public.is_org_admin()
$$;

-- People assigned to a site the caller supervises (supervisors need their
-- guards' names and phone numbers). Client viewers get names only, through
-- site_people().
CREATE OR REPLACE FUNCTION public.supervised_user_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(DISTINCT sa.user_id), '{}'::uuid[])
  FROM public.site_assignments sa
  WHERE public.has_role('supervisor')
    AND sa.site_id = ANY (public.assigned_site_ids())
$$;

-- Kept for compatibility: supervisor shares an assigned site with the user.
CREATE OR REPLACE FUNCTION public.shares_site_with(target_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT target_user_id = ANY (public.supervised_user_ids())
$$;

-- The shift belongs to the (active) caller and is at the given site. A shift
-- could only be opened while the caller was a guard assigned to that site.
CREATE OR REPLACE FUNCTION public.is_own_shift(target_shift_id uuid, target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts sh
    WHERE sh.id = target_shift_id
      AND sh.site_id = target_site_id
      AND sh.guard_id = public.active_uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_own_active_shift(target_shift_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts sh
    WHERE sh.id = target_shift_id
      AND sh.status = 'active'
      AND sh.guard_id = public.active_uid()
      AND public.is_site_guard(sh.site_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.can_read_shift(target_shift_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts sh
    WHERE sh.id = target_shift_id
      AND (sh.guard_id = public.active_uid() OR public.can_manage_site(sh.site_id))
  )
$$;

-- The caller had a shift at the site recently enough for its evidence to be
-- still uploadable (photos of a shift that ended before an unassignment).
CREATE OR REPLACE FUNCTION public.has_recent_shift_at_site(target_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts sh
    WHERE sh.guard_id = public.active_uid()
      AND sh.site_id = target_site_id
      AND coalesce(sh.actual_start, sh.scheduled_start)
          >= now() - public.evidence_max_age() - public.max_shift_length()
  )
$$;

-- The user (of the caller's organisation) holds super_admin.
CREATE OR REPLACE FUNCTION public.is_super_admin_user(target_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_org_user(target_user_id)
     AND EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = target_user_id AND ur.role = 'super_admin')
$$;

-- Role administration rule: org admins manage roles of OTHER users in their
-- own organisation; only a super_admin may grant or revoke super_admin.
CREATE OR REPLACE FUNCTION public.can_assign_role(target_user_id uuid, target_role user_role_type)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_org_admin()
     AND public.is_org_user(target_user_id)
     AND target_user_id IS DISTINCT FROM auth.uid()
     AND (target_role <> 'super_admin' OR public.has_role('super_admin'))
$$;

-- ---- Internal evidence checks (called by triggers only) -------------------

-- Refuses a device time that is ahead of the server by more than the
-- tolerance (phone clock wrong) or older than the offline limit. The HINT
-- lets the app show a specific message instead of a generic failure.
CREATE OR REPLACE FUNCTION public.assert_device_time(p_at timestamptz, p_what text)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_at IS NULL THEN
        RAISE EXCEPTION '% is missing', p_what USING ERRCODE = '23514';
    END IF;
    IF p_at > now() + public.device_clock_tolerance() THEN
        RAISE EXCEPTION '% % is ahead of the server clock (%); the phone clock is wrong', p_what, p_at, now()
            USING ERRCODE = '23514', HINT = 'device_clock_ahead';
    END IF;
    IF p_at < now() - public.evidence_max_age() THEN
        RAISE EXCEPTION '% % is older than the offline limit of %', p_what, p_at, public.evidence_max_age()
            USING ERRCODE = '23514', HINT = 'device_time_too_old';
    END IF;
END;
$$;

-- Evidence linked to a shift must fall inside that shift: from 10 minutes
-- before clock-in to 10 minutes after clock-out, or - while the shift is open
-- or was abandoned - to max_shift_length() after clock-in.
CREATE OR REPLACE FUNCTION public.assert_in_shift_window(
    p_shift_start timestamptz, p_shift_end timestamptz, p_at timestamptz, p_what text)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from timestamptz := p_shift_start - interval '10 minutes';
    v_to timestamptz := coalesce(p_shift_end, p_shift_start + public.max_shift_length()) + interval '10 minutes';
BEGIN
    IF p_at < v_from OR p_at > v_to THEN
        RAISE EXCEPTION '% % is outside the shift window (% to %)', p_what, p_at, v_from, v_to
            USING ERRCODE = '23514', HINT = 'outside_shift_window';
    END IF;
END;
$$;

-- The site's configured day / night shifts starting on the SAST calendar day
-- before, on and after p_around. Times of day are SAST (Africa/Johannesburg,
-- no daylight saving); an end not after the start rolls past midnight.
-- Same rules as calculateShiftBounds() in src/features/shifts/shiftCalculator.ts.
CREATE OR REPLACE FUNCTION public.site_shift_candidates(p_site_id uuid, p_around timestamptz)
RETURNS TABLE (cand_type shift_type_enum, cand_start timestamptz, cand_end timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.kind,
         b.starts_at,
         CASE WHEN b.ends_at <= b.starts_at THEN b.ends_at + interval '1 day' ELSE b.ends_at END
  FROM public.sites s
  CROSS JOIN generate_series(-1, 1) AS d(n)
  CROSS JOIN (VALUES ('day'::public.shift_type_enum), ('night'::public.shift_type_enum)) AS k(kind)
  CROSS JOIN LATERAL (
      SELECT (((p_around AT TIME ZONE 'Africa/Johannesburg')::date + d.n)
              + CASE k.kind WHEN 'day' THEN s.day_shift_start ELSE s.night_shift_start END)
             AT TIME ZONE 'Africa/Johannesburg' AS starts_at,
             (((p_around AT TIME ZONE 'Africa/Johannesburg')::date + d.n)
              + CASE k.kind WHEN 'day' THEN s.day_shift_end ELSE s.night_shift_end END)
             AT TIME ZONE 'Africa/Johannesburg' AS ends_at
  ) AS b
  WHERE s.id = p_site_id
$$;

-- The schedule a clock-in at p_at is recorded against. The app's own choice
-- (determineShiftForClockIn: the current shift, the next one, or its
-- alternative) is kept when it is one of the site's configured shifts that
-- has not ended yet; anything else (a shrunken or invented schedule, or a
-- schedule computed from site times that changed since) is replaced by the
-- server's choice with the app's rule: a shift starting within 60 minutes
-- (EARLY_CLOCK_IN_MINUTES) when none runs or the current one ends within 60
-- minutes, else the current shift, else the next one.
CREATE OR REPLACE FUNCTION public.resolve_shift_schedule(
    p_site_id uuid, p_at timestamptz, p_type shift_type_enum,
    p_start timestamptz, p_end timestamptz)
RETURNS TABLE (r_shift_type shift_type_enum, r_scheduled_start timestamptz, r_scheduled_end timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cur_type public.shift_type_enum;
    v_cur_start timestamptz;
    v_cur_end timestamptz;
    v_next_type public.shift_type_enum;
    v_next_start timestamptz;
    v_next_end timestamptz;
BEGIN
    IF p_at IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.site_shift_candidates(p_site_id, p_at) c
               WHERE c.cand_type = p_type AND c.cand_start = p_start AND c.cand_end = p_end
                 AND c.cand_end > p_at) THEN
        RETURN QUERY SELECT p_type, p_start, p_end;
        RETURN;
    END IF;

    SELECT c.cand_type, c.cand_start, c.cand_end INTO v_cur_type, v_cur_start, v_cur_end
    FROM public.site_shift_candidates(p_site_id, p_at) c
    WHERE c.cand_start <= p_at AND p_at < c.cand_end
    ORDER BY c.cand_start DESC
    LIMIT 1;

    SELECT c.cand_type, c.cand_start, c.cand_end INTO v_next_type, v_next_start, v_next_end
    FROM public.site_shift_candidates(p_site_id, p_at) c
    WHERE c.cand_start > p_at
    ORDER BY c.cand_start
    LIMIT 1;

    IF v_next_start IS NOT NULL AND v_next_start - p_at <= interval '60 minutes'
       AND (v_cur_start IS NULL OR v_cur_end - p_at <= interval '60 minutes') THEN
        RETURN QUERY SELECT v_next_type, v_next_start, v_next_end;
    ELSIF v_cur_start IS NOT NULL THEN
        RETURN QUERY SELECT v_cur_type, v_cur_start, v_cur_end;
    ELSIF v_next_start IS NOT NULL THEN
        RETURN QUERY SELECT v_next_type, v_next_start, v_next_end;
    END IF;
END;
$$;

-- A selfie object may prove exactly one clock-in or clock-out.
CREATE OR REPLACE FUNCTION public.selfie_in_use(p_path text, p_except_shift uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts sh
    WHERE (sh.start_selfie_url = p_path OR sh.end_selfie_url = p_path)
      AND sh.id IS DISTINCT FROM p_except_shift
  )
$$;


-- ========================================================================
-- 4. TRIGGERS
--    All user-facing checks are skipped only when auth.uid() IS NULL, i.e.
--    service_role / migrations / seeds (never reachable with a user JWT).
--    Offline replays: the sync engine re-sends an event after a lost
--    response. A BEFORE INSERT trigger that finds the caller's own stored
--    copy returns NULL, so the replay is a no-op before any RLS or evidence
--    check runs (a later state change can no longer turn it into an error).
-- ========================================================================

-- 4a. checkpoints: organisation from site, canonical NFC serial, secret
--     fingerprints, enrolment / deactivation stamps that clients cannot
--     forge, strong QR tokens.
CREATE OR REPLACE FUNCTION public.checkpoints_before_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org uuid;
    v_uid text;
    v_nfc_changed boolean;
    v_token_changed boolean;
BEGIN
    -- Same answer for "no such site" and "someone else's site".
    IF auth.uid() IS NOT NULL AND NOT public.is_org_site(NEW.site_id) THEN
        RAISE EXCEPTION 'Checkpoints can only be added to a site of your organisation' USING ERRCODE = '42501';
    END IF;
    SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = NEW.site_id;
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Checkpoint site % does not exist', NEW.site_id USING ERRCODE = '23503';
    END IF;
    NEW.organisation_id := v_org;

    IF NEW.nfc_uid IS NOT NULL THEN
        IF btrim(NEW.nfc_uid) = '' THEN
            NEW.nfc_uid := NULL;
        ELSE
            v_uid := public.normalize_nfc_uid(NEW.nfc_uid);
            IF v_uid IS NULL THEN
                RAISE EXCEPTION 'Invalid NFC tag serial "%": expected 4 to 10 hexadecimal bytes', NEW.nfc_uid
                    USING ERRCODE = '22023';
            END IF;
            NEW.nfc_uid := v_uid;
        END IF;
    END IF;

    IF NEW.legacy_code IS NOT NULL THEN
        NEW.legacy_code := nullif(btrim(NEW.legacy_code), '');
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_nfc_changed := NEW.nfc_uid IS NOT NULL;
    ELSE
        v_nfc_changed := NEW.nfc_uid IS DISTINCT FROM OLD.nfc_uid;
    END IF;

    IF v_nfc_changed THEN
        IF NEW.nfc_uid IS NULL THEN
            NEW.nfc_enrolled_at := NULL;
            NEW.nfc_enrolled_by := NULL;
        ELSE
            NEW.nfc_enrolled_at := now();
            NEW.nfc_enrolled_by := (SELECT p.id FROM public.profiles p WHERE p.id = auth.uid());
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        NEW.nfc_enrolled_at := OLD.nfc_enrolled_at;
        -- Keep the stamp, except when the enrolling user was deleted (the
        -- foreign key's ON DELETE SET NULL arrives here as an UPDATE).
        IF NOT (NEW.nfc_enrolled_by IS NULL AND OLD.nfc_enrolled_by IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.nfc_enrolled_by)) THEN
            NEW.nfc_enrolled_by := OLD.nfc_enrolled_by;
        END IF;
    ELSE
        NEW.nfc_enrolled_at := NULL;
        NEW.nfc_enrolled_by := NULL;
    END IF;

    -- Deactivation time: scans captured before it still sync (offline queue).
    IF TG_OP = 'INSERT' THEN
        NEW.deactivated_at := CASE WHEN NEW.is_active THEN NULL ELSE now() END;
    ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        NEW.deactivated_at := CASE WHEN NEW.is_active THEN NULL ELSE now() END;
    ELSIF auth.uid() IS NOT NULL THEN
        NEW.deactivated_at := OLD.deactivated_at;
    END IF;

    -- New or rotated QR tokens must be 'EE-CP-' + 32 upper-case hex characters
    -- (128 random bits, see generateCheckpointToken()). Existing tokens are
    -- only checked when they change.
    IF TG_OP = 'INSERT' THEN
        v_token_changed := true;
    ELSE
        v_token_changed := NEW.qr_code_hash IS DISTINCT FROM OLD.qr_code_hash;
    END IF;
    IF v_token_changed
       AND (NEW.qr_code_hash IS NULL OR NEW.qr_code_hash !~ '^EE-CP-[0-9A-F]{32}$') THEN
        RAISE EXCEPTION 'Checkpoint QR token must be EE-CP- followed by 32 upper-case hex characters'
            USING ERRCODE = '22023';
    END IF;

    -- Fingerprints are always derived from the stored secrets.
    NEW.qr_token_sha256 := public.sha256_hex(NEW.qr_code_hash);
    NEW.nfc_uid_sha256 := public.sha256_hex(NEW.nfc_uid);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkpoints_before_write ON public.checkpoints;
CREATE TRIGGER trg_checkpoints_before_write
    BEFORE INSERT OR UPDATE ON public.checkpoints
    FOR EACH ROW EXECUTE FUNCTION public.checkpoints_before_write();

-- 4b. patrol_scans: server-side validation and server-computed proof.
--     Client-supplied scan_timestamp_server, created_at, distance,
--     confidence, validity, radius, site and verdict are always overwritten;
--     the raw QR token / NFC serial is never stored (only its SHA-256).
CREATE OR REPLACE FUNCTION public.patrol_scans_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_shift public.shifts%ROWTYPE;
    v_cp public.checkpoints%ROWTYPE;
    v_payload text;
BEGIN
    IF v_uid IS NOT NULL THEN
        -- Replay of a scan that is already stored: no-op.
        IF EXISTS (SELECT 1 FROM public.patrol_scans ps
                   WHERE ps.offline_uuid = NEW.offline_uuid AND ps.guard_id = v_uid) THEN
            RETURN NULL;
        END IF;

        -- One generic answer for "no such shift / checkpoint" and "not yours".
        SELECT * INTO v_shift FROM public.shifts WHERE id = NEW.shift_id AND guard_id = v_uid;
        IF NOT FOUND OR NEW.guard_id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'A patrol scan can only be recorded by the guard on the shift'
                USING ERRCODE = '42501';
        END IF;
        SELECT * INTO v_cp FROM public.checkpoints WHERE id = NEW.checkpoint_id AND site_id = v_shift.site_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'The scanned checkpoint is not part of the site of this shift'
                USING ERRCODE = '42501';
        END IF;

        -- A checkpoint deactivated after the scan was captured still counts.
        IF NOT v_cp.is_active
           AND NOT (v_cp.deactivated_at IS NOT NULL AND NEW.scan_timestamp_device < v_cp.deactivated_at) THEN
            RAISE EXCEPTION 'Checkpoint % is inactive', v_cp.id USING ERRCODE = '23514';
        END IF;

        PERFORM public.assert_device_time(NEW.scan_timestamp_device, 'Scan time');
        PERFORM public.assert_in_shift_window(coalesce(v_shift.actual_start, v_shift.scheduled_start),
                                              v_shift.actual_end, NEW.scan_timestamp_device, 'Scan time');

        IF NEW.patrol_round_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.patrol_rounds r
            WHERE r.id = NEW.patrol_round_id AND r.shift_id = NEW.shift_id
        ) THEN
            RAISE EXCEPTION 'Patrol round % does not belong to shift %', NEW.patrol_round_id, NEW.shift_id
                USING ERRCODE = '23514';
        END IF;
        NEW.created_at := now();
    ELSE
        SELECT * INTO v_shift FROM public.shifts WHERE id = NEW.shift_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Patrol scan references unknown shift %', NEW.shift_id USING ERRCODE = '23503';
        END IF;
        SELECT * INTO v_cp FROM public.checkpoints WHERE id = NEW.checkpoint_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Patrol scan references unknown checkpoint %', NEW.checkpoint_id USING ERRCODE = '23503';
        END IF;
    END IF;

    NEW.site_id := v_shift.site_id;
    NEW.scan_timestamp_server := now();
    NEW.checkpoint_radius_meters := v_cp.permitted_radius_meters;

    IF NEW.accuracy_meters IS NOT NULL
       AND (NEW.accuracy_meters < 0 OR NEW.accuracy_meters = 'NaN'::float8) THEN
        NEW.accuracy_meters := NULL;
    END IF;

    -- GPS verdict from the coordinates and accuracy the phone reported.
    IF NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
        NEW.distance_to_checkpoint_meters := NULL;
        NEW.gps_confidence := 'no_fix';
    ELSIF v_cp.latitude IS NULL OR v_cp.longitude IS NULL THEN
        NEW.distance_to_checkpoint_meters := NULL;
        NEW.gps_confidence := 'no_reference';
    ELSE
        NEW.distance_to_checkpoint_meters := public.haversine_distance_meters(
            NEW.latitude, NEW.longitude, v_cp.latitude, v_cp.longitude);
        NEW.gps_confidence := public.classify_gps_confidence(
            NEW.distance_to_checkpoint_meters, NEW.accuracy_meters, v_cp.permitted_radius_meters);
    END IF;
    NEW.is_valid_proximity := NEW.gps_confidence IN ('verified', 'likely');

    -- Payload verdict: only a strong QR token or an enrolled NFC serial is a
    -- secret the phone can match. Dawie's PLAAS-CP codes are public and a
    -- manual entry has no secret: accepted, never verified.
    v_payload := btrim(coalesce(NEW.raw_payload, ''));
    NEW.payload_verified := CASE NEW.payload_type
        WHEN 'secure_token' THEN v_payload <> '' AND v_cp.qr_token_strong
                                 AND upper(v_payload) = v_cp.qr_code_hash
        WHEN 'nfc_uid' THEN v_cp.nfc_uid IS NOT NULL AND public.normalize_nfc_uid(v_payload) = v_cp.nfc_uid
        ELSE false
    END;
    NEW.raw_payload := CASE
        WHEN v_payload = '' THEN NULL
        WHEN NEW.payload_type = 'legacy_qr' THEN v_payload
        WHEN NEW.payload_type = 'nfc_uid'
            THEN 'sha256:' || public.sha256_hex(coalesce(public.normalize_nfc_uid(v_payload), v_payload))
        WHEN NEW.payload_type = 'secure_token' THEN 'sha256:' || public.sha256_hex(upper(v_payload))
        ELSE 'sha256:' || public.sha256_hex(v_payload)
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patrol_scans_before_insert ON public.patrol_scans;
CREATE TRIGGER trg_patrol_scans_before_insert
    BEFORE INSERT ON public.patrol_scans
    FOR EACH ROW EXECUTE FUNCTION public.patrol_scans_before_insert();

-- 4c. shifts: a guard opens their own shift (never a finished one) against
--     the site's configured schedule, and closes it exactly once. Start
--     evidence is frozen for everyone once stored; supervisors / admins may
--     only mark an open shift abandoned (or undo that) and add notes, never
--     move it to another guard or site or write its clock-out.
CREATE OR REPLACE FUNCTION public.shifts_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_org uuid;
    v_type public.shift_type_enum;
    v_start timestamptz;
    v_end timestamptz;
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;

    -- Replay of a clock-in that is already stored: no-op.
    IF EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = NEW.id AND s.guard_id = v_uid) THEN
        RETURN NULL;
    END IF;

    IF NEW.guard_id IS DISTINCT FROM public.active_uid() OR NOT public.is_site_guard(NEW.site_id) THEN
        RAISE EXCEPTION 'You can only clock yourself in, on a site you are assigned to' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'A new shift must be active' USING ERRCODE = '42501';
    END IF;
    IF NEW.actual_end IS NOT NULL OR NEW.end_selfie_url IS NOT NULL
       OR NEW.end_latitude IS NOT NULL OR NEW.end_longitude IS NOT NULL
       OR NEW.end_accuracy_meters IS NOT NULL THEN
        RAISE EXCEPTION 'A shift must be started before it can be ended' USING ERRCODE = '23514';
    END IF;

    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.actual_start := coalesce(NEW.actual_start, now());
    PERFORM public.assert_device_time(NEW.actual_start, 'Clock-in time');

    SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = NEW.site_id;
    IF NEW.start_selfie_url IS NOT NULL
       AND (NOT public.is_evidence_path(NEW.start_selfie_url, v_org, NEW.site_id, 'selfie', NEW.guard_id)
            OR public.selfie_in_use(NEW.start_selfie_url, NEW.id)) THEN
        RAISE EXCEPTION 'The clock-in selfie must be a new photo uploaded by you for this site'
            USING ERRCODE = '23514';
    END IF;

    -- Compliance is measured against the site's schedule, not the phone's.
    SELECT r.r_shift_type, r.r_scheduled_start, r.r_scheduled_end INTO v_type, v_start, v_end
    FROM public.resolve_shift_schedule(NEW.site_id, NEW.actual_start, NEW.shift_type,
                                       NEW.scheduled_start, NEW.scheduled_end) r;
    IF v_start IS NOT NULL
       AND (v_type, v_start, v_end) IS DISTINCT FROM (NEW.shift_type, NEW.scheduled_start, NEW.scheduled_end) THEN
        INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
        VALUES (v_org, v_uid, 'shift.schedule_corrected', 'shifts', NEW.id,
                jsonb_build_object(
                    'site_id', NEW.site_id,
                    'actual_start', NEW.actual_start,
                    'submitted', jsonb_build_object('shift_type', NEW.shift_type,
                                                    'scheduled_start', NEW.scheduled_start,
                                                    'scheduled_end', NEW.scheduled_end),
                    'recorded', jsonb_build_object('shift_type', v_type,
                                                   'scheduled_start', v_start,
                                                   'scheduled_end', v_end)));
        NEW.shift_type := v_type;
        NEW.scheduled_start := v_start;
        NEW.scheduled_end := v_end;
    END IF;

    -- One open shift per guard. A newer clock-in closes the older open shift
    -- (its queued clock-out can still complete it); an older clock-in that
    -- syncs late is stored as already superseded.
    IF EXISTS (SELECT 1 FROM public.shifts s
               WHERE s.guard_id = NEW.guard_id AND s.status = 'active'
                 AND s.actual_start > NEW.actual_start) THEN
        NEW.status := 'abandoned';
    ELSE
        UPDATE public.shifts s
        SET status = 'abandoned',
            notes = concat_ws(E'\n', nullif(s.notes, ''),
                              format('Closed automatically: the guard clocked in to shift %s at %s.',
                                     NEW.id, NEW.actual_start))
        WHERE s.guard_id = NEW.guard_id AND s.status = 'active' AND s.id <> NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shifts_before_insert ON public.shifts;
CREATE TRIGGER trg_shifts_before_insert
    BEFORE INSERT ON public.shifts
    FOR EACH ROW EXECUTE FUNCTION public.shifts_before_insert();

CREATE OR REPLACE FUNCTION public.shifts_before_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_owner boolean;
    v_changed text[];
    v_org uuid;
    v_allowed boolean;
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;
    v_owner := OLD.guard_id = v_uid;

    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
    JOIN jsonb_each(to_jsonb(OLD)) AS o USING (key)
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key <> 'updated_at';
    IF v_changed IS NULL THEN
        RETURN NEW;
    END IF;

    -- Who, where, which schedule and the clock-in evidence: frozen for everyone.
    IF v_changed && ARRAY['id', 'site_id', 'guard_id', 'shift_type', 'scheduled_start', 'scheduled_end',
                          'actual_start', 'start_selfie_url', 'start_latitude', 'start_longitude',
                          'start_accuracy_meters', 'created_at'] THEN
        RAISE EXCEPTION 'Shift start details cannot be changed after clock-in' USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'completed' AND NEW.actual_end IS NULL THEN
        RAISE EXCEPTION 'A completed shift needs an end time' USING ERRCODE = '23514';
    END IF;

    -- Clock-out evidence: written once, by the guard on the shift.
    IF v_changed && ARRAY['actual_end', 'end_selfie_url', 'end_latitude', 'end_longitude', 'end_accuracy_meters'] THEN
        IF NOT v_owner THEN
            RAISE EXCEPTION 'Only the guard on the shift can record the clock-out' USING ERRCODE = '42501';
        END IF;
        IF OLD.actual_end IS NOT NULL THEN
            RAISE EXCEPTION 'This shift has already been ended' USING ERRCODE = '42501';
        END IF;
        IF NEW.actual_end IS NULL OR NEW.status IS DISTINCT FROM 'completed' THEN
            RAISE EXCEPTION 'A clock-out must set the end time and complete the shift' USING ERRCODE = '23514';
        END IF;
        IF NEW.actual_end > now() + public.device_clock_tolerance() THEN
            RAISE EXCEPTION 'Shift end time % is in the future', NEW.actual_end
                USING ERRCODE = '23514', HINT = 'device_clock_ahead';
        END IF;
        IF NEW.actual_end < OLD.actual_start THEN
            RAISE EXCEPTION 'Shift end time % is before its start time', NEW.actual_end USING ERRCODE = '23514';
        END IF;
        IF NEW.end_selfie_url IS NOT NULL THEN
            SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = OLD.site_id;
            IF NOT public.is_evidence_path(NEW.end_selfie_url, v_org, OLD.site_id, 'selfie', OLD.guard_id)
               OR NEW.end_selfie_url IS NOT DISTINCT FROM OLD.start_selfie_url
               OR public.selfie_in_use(NEW.end_selfie_url, OLD.id) THEN
                RAISE EXCEPTION 'The clock-out selfie must be a new photo uploaded by you for this site'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF v_owner THEN
            -- clock-out (also of a shift a supervisor marked abandoned), or
            -- abandoning the own open shift (a new clock-in does this).
            v_allowed := (OLD.status IN ('active', 'abandoned') AND NEW.status = 'completed'
                          AND OLD.actual_end IS NULL AND NEW.actual_end IS NOT NULL)
                      OR (OLD.status = 'active' AND NEW.status = 'abandoned' AND NEW.actual_end IS NULL);
        ELSE
            -- supervisor / admin: mark an open shift abandoned, or undo that.
            v_allowed := OLD.actual_end IS NULL AND NEW.actual_end IS NULL
                     AND ((OLD.status = 'active' AND NEW.status = 'abandoned')
                          OR (OLD.status = 'abandoned' AND NEW.status = 'active'));
        END IF;
        IF NOT v_allowed THEN
            RAISE EXCEPTION 'Shift status cannot change from % to %', OLD.status, NEW.status
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF 'notes' = ANY (v_changed) AND v_owner AND OLD.actual_end IS NOT NULL
       AND NOT public.can_manage_site(OLD.site_id) THEN
        RAISE EXCEPTION 'Notes of a finished shift can only be changed by a supervisor' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shifts_before_update ON public.shifts;
CREATE TRIGGER trg_shifts_before_update
    BEFORE UPDATE ON public.shifts
    FOR EACH ROW EXECUTE FUNCTION public.shifts_before_update();

-- 4d. incidents / panic_alerts.
--     Insert: replays are no-ops, created_at is server time, the event time
--     is bounded, and an incident linked to a shift must fall inside it.
--     An SOS is never refused because of its shift link or a fast phone
--     clock: an unknown shift link is dropped, a future time is clamped.
CREATE OR REPLACE FUNCTION public.incidents_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_shift public.shifts%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.incidents i
               WHERE i.offline_uuid = NEW.offline_uuid AND i.guard_id = v_uid) THEN
        RETURN NULL;
    END IF;

    NEW.created_at := now();
    NEW.updated_at := now();
    PERFORM public.assert_device_time(NEW.reported_at, 'Incident time');

    IF NEW.shift_id IS NOT NULL THEN
        SELECT * INTO v_shift FROM public.shifts sh
        WHERE sh.id = NEW.shift_id AND sh.guard_id = v_uid AND sh.site_id = NEW.site_id;
        -- Not the caller's shift at this site: the INSERT policy refuses it.
        IF FOUND THEN
            PERFORM public.assert_in_shift_window(coalesce(v_shift.actual_start, v_shift.scheduled_start),
                                                  v_shift.actual_end, NEW.reported_at, 'Incident time');
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incidents_before_insert ON public.incidents;
CREATE TRIGGER trg_incidents_before_insert
    BEFORE INSERT ON public.incidents
    FOR EACH ROW EXECUTE FUNCTION public.incidents_before_insert();

CREATE OR REPLACE FUNCTION public.panic_alerts_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.panic_alerts pa
               WHERE pa.offline_uuid = NEW.offline_uuid AND pa.guard_id = v_uid) THEN
        RETURN NULL;
    END IF;

    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.triggered_at := coalesce(NEW.triggered_at, now());
    IF NEW.triggered_at > now() + public.device_clock_tolerance() THEN
        NEW.triggered_at := now();
    END IF;
    PERFORM public.assert_device_time(NEW.triggered_at, 'SOS time');

    -- The clock-in may not be on the server yet (or was refused): keep the
    -- SOS, without the link.
    IF NEW.shift_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.shifts sh
        WHERE sh.id = NEW.shift_id AND sh.guard_id = v_uid AND sh.site_id = NEW.site_id
    ) THEN
        NEW.shift_id := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_panic_alerts_before_insert ON public.panic_alerts;
CREATE TRIGGER trg_panic_alerts_before_insert
    BEFORE INSERT ON public.panic_alerts
    FOR EACH ROW EXECUTE FUNCTION public.panic_alerts_before_insert();

--     Update: supervisors may only change status, acknowledgement and notes;
--     the guard's report (description, GPS, time, guard, site) is evidence
--     and stays untouched. The acknowledgement is written once, in the
--     acknowledging user's own name, with the server's time; handling an
--     alert (any status change) acknowledges it; a handled alert cannot be
--     set back to reported / active.
CREATE OR REPLACE FUNCTION public.alerts_before_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_changed text[];
    v_initial text := CASE TG_TABLE_NAME WHEN 'incidents' THEN 'reported' ELSE 'active' END;
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
    JOIN jsonb_each(to_jsonb(OLD)) AS o USING (key)
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key NOT IN ('status', 'acknowledged_by', 'acknowledged_at',
                        'supervisor_notes', 'resolution_notes', 'updated_at');
    IF v_changed IS NOT NULL THEN
        RAISE EXCEPTION 'Only status, acknowledgement and notes can be changed (attempted: %)',
            array_to_string(v_changed, ', ') USING ERRCODE = '42501';
    END IF;

    IF OLD.acknowledged_by IS NOT NULL AND NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by THEN
        RAISE EXCEPTION 'An acknowledgement cannot be changed or removed' USING ERRCODE = '42501';
    END IF;
    IF OLD.acknowledged_by IS NULL AND NEW.acknowledged_by IS NOT NULL AND NEW.acknowledged_by <> v_uid THEN
        RAISE EXCEPTION 'acknowledged_by must be the acknowledging user' USING ERRCODE = '42501';
    END IF;

    IF NEW.status::text IS DISTINCT FROM OLD.status::text THEN
        IF NEW.status::text = v_initial THEN
            RAISE EXCEPTION 'A handled alert cannot be set back to %', v_initial USING ERRCODE = '42501';
        END IF;
        IF NEW.acknowledged_by IS NULL THEN
            NEW.acknowledged_by := v_uid;
        END IF;
    END IF;

    -- The time of a new acknowledgement is always the server's (a client
    -- value is ignored); any other attempt to move it is refused.
    IF OLD.acknowledged_by IS NULL AND NEW.acknowledged_by IS NOT NULL THEN
        NEW.acknowledged_at := now();
    ELSIF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
        RAISE EXCEPTION 'The acknowledgement time is set by the server when the alert is acknowledged'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incidents_before_update ON public.incidents;
CREATE TRIGGER trg_incidents_before_update
    BEFORE UPDATE ON public.incidents
    FOR EACH ROW EXECUTE FUNCTION public.alerts_before_update();

DROP TRIGGER IF EXISTS trg_panic_alerts_before_update ON public.panic_alerts;
CREATE TRIGGER trg_panic_alerts_before_update
    BEFORE UPDATE ON public.panic_alerts
    FOR EACH ROW EXECUTE FUNCTION public.alerts_before_update();

-- 4e. profiles: users edit their own name / phone / language / avatar only.
--     Activation and employee number are admin-controlled, only a
--     super_admin may deactivate a super_admin, and nobody signed in can move
--     a user to another organisation (only the service role can).
CREATE OR REPLACE FUNCTION public.profiles_before_update()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Profile id cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
        RAISE EXCEPTION 'A user cannot be moved to another organisation' USING ERRCODE = '42501';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'created_at cannot be changed' USING ERRCODE = '42501';
    END IF;

    IF public.is_org_admin() AND OLD.organisation_id = public.get_auth_org_id() THEN
        IF NEW.is_active IS DISTINCT FROM OLD.is_active
           AND public.is_super_admin_user(OLD.id)
           AND NOT public.has_role('super_admin') THEN
            RAISE EXCEPTION 'Only a super_admin can deactivate a super_admin' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.employee_number IS DISTINCT FROM OLD.employee_number THEN
        RAISE EXCEPTION 'Only an organisation admin can change activation or employee number'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_before_update ON public.profiles;
CREATE TRIGGER trg_profiles_before_update
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.profiles_before_update();

-- Profile deletions are audited with the roles and site assignments that the
-- cascade removes (written BEFORE the delete, while they still exist).
CREATE OR REPLACE FUNCTION public.profiles_audit_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = OLD.organisation_id) THEN
        INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
        VALUES (OLD.organisation_id, auth.uid(), 'profile.deleted', 'profiles', OLD.id,
                jsonb_build_object(
                    'user_id', OLD.id,
                    'first_name', OLD.first_name,
                    'last_name', OLD.last_name,
                    'employee_number', OLD.employee_number,
                    'was_active', OLD.is_active,
                    'roles_removed', (SELECT coalesce(jsonb_agg(ur.role ORDER BY ur.role), '[]'::jsonb)
                                      FROM public.user_roles ur WHERE ur.user_id = OLD.id),
                    'site_assignments_removed', (SELECT coalesce(jsonb_agg(sa.site_id ORDER BY sa.site_id), '[]'::jsonb)
                                                 FROM public.site_assignments sa WHERE sa.user_id = OLD.id)));
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_audit_delete ON public.profiles;
CREATE TRIGGER trg_profiles_audit_delete
    BEFORE DELETE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.profiles_audit_delete();

-- 4f. gate_entries: replays are no-ops, times are bounded (an OUT row's event
--     time is its exit), dwell is computed by the server, the vehicle photo
--     must be this entry's own upload, and an OUT row may only link to an IN
--     row of the same site.
CREATE OR REPLACE FUNCTION public.gate_entries_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_shift public.shifts%ROWTYPE;
    v_event timestamptz;
    v_org uuid;
BEGIN
    IF v_uid IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.gate_entries g
                   WHERE g.offline_uuid = NEW.offline_uuid AND g.guard_id = v_uid) THEN
            RETURN NULL;
        END IF;

        NEW.created_at := now();
        v_event := CASE WHEN NEW.direction = 'out' THEN coalesce(NEW.exit_time, NEW.entry_time)
                        ELSE NEW.entry_time END;
        PERFORM public.assert_device_time(v_event, 'Gate time');
        IF NEW.entry_time > now() + public.device_clock_tolerance() THEN
            RAISE EXCEPTION 'Entry time % is ahead of the server clock', NEW.entry_time
                USING ERRCODE = '23514', HINT = 'device_clock_ahead';
        END IF;

        IF NEW.shift_id IS NOT NULL THEN
            SELECT * INTO v_shift FROM public.shifts sh
            WHERE sh.id = NEW.shift_id AND sh.guard_id = v_uid AND sh.site_id = NEW.site_id;
            IF FOUND THEN
                PERFORM public.assert_in_shift_window(coalesce(v_shift.actual_start, v_shift.scheduled_start),
                                                      v_shift.actual_end, v_event, 'Gate time');
            END IF;
        END IF;

        IF NEW.vehicle_photo_url IS NOT NULL THEN
            SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = NEW.site_id;
            IF NOT (public.is_evidence_path(NEW.vehicle_photo_url, v_org, NEW.site_id, 'vehicle', v_uid, NEW.id)
                    OR public.is_evidence_path(NEW.vehicle_photo_url, v_org, NEW.site_id, 'vehicle', v_uid,
                                               NEW.offline_uuid)) THEN
                RAISE EXCEPTION 'The vehicle photo must be uploaded by you for this gate entry'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;

    IF NEW.exit_time IS NOT NULL AND NEW.exit_time < NEW.entry_time THEN
        RAISE EXCEPTION 'Exit time % is before entry time %', NEW.exit_time, NEW.entry_time
            USING ERRCODE = '23514';
    END IF;
    NEW.dwell_duration_seconds := CASE
        WHEN NEW.exit_time IS NOT NULL THEN floor(extract(epoch FROM NEW.exit_time - NEW.entry_time))::integer
    END;

    IF NEW.linked_entry_id IS NOT NULL THEN
        IF NEW.direction <> 'out' THEN
            RAISE EXCEPTION 'Only an OUT entry can link to an earlier IN entry' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.gate_entries g
            WHERE g.id = NEW.linked_entry_id
              AND g.site_id = NEW.site_id
              AND g.direction = 'in'
        ) THEN
            RAISE EXCEPTION 'Linked gate entry % is not an IN entry of this site', NEW.linked_entry_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gate_entries_before_insert ON public.gate_entries;
CREATE TRIGGER trg_gate_entries_before_insert
    BEFORE INSERT ON public.gate_entries
    FOR EACH ROW EXECUTE FUNCTION public.gate_entries_before_insert();

-- 4g. incident_media: photos of the caller's own incident, stored at that
--     incident's own evidence path, images only.
CREATE OR REPLACE FUNCTION public.incident_media_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_incident public.incidents%ROWTYPE;
    v_org uuid;
BEGIN
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_incident FROM public.incidents i WHERE i.id = NEW.incident_id AND i.guard_id = v_uid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Photos can only be added to your own incident report' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.incident_media m WHERE m.id = NEW.id AND m.incident_id = NEW.incident_id) THEN
        RETURN NULL;
    END IF;

    NEW.created_at := now();
    SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = v_incident.site_id;
    IF NOT public.is_evidence_path(NEW.media_url, v_org, v_incident.site_id, 'incident', v_uid, v_incident.id) THEN
        RAISE EXCEPTION 'The photo must be uploaded by you for this incident' USING ERRCODE = '23514';
    END IF;
    IF NEW.media_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
        RAISE EXCEPTION 'Unsupported evidence type %', NEW.media_type USING ERRCODE = '23514';
    END IF;
    IF NEW.file_size_bytes IS NOT NULL AND (NEW.file_size_bytes < 0 OR NEW.file_size_bytes > 10485760) THEN
        RAISE EXCEPTION 'Evidence file size % is out of range', NEW.file_size_bytes USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incident_media_before_insert ON public.incident_media;
CREATE TRIGGER trg_incident_media_before_insert
    BEFORE INSERT ON public.incident_media
    FOR EACH ROW EXECUTE FUNCTION public.incident_media_before_insert();

-- 4h. Audit trail. Rows are written only by these SECURITY DEFINER
--     functions; users can never insert, update or delete audit_logs.
CREATE OR REPLACE FUNCTION public.audit_log_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
    v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    v_row jsonb := coalesce(v_new, v_old);
    v_changes jsonb := '{}'::jsonb;
    v_org uuid;
    v_actor uuid := auth.uid();
    v_action text;
    v_details jsonb;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        SELECT coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb)
        INTO v_changes
        FROM jsonb_each(v_new) AS n
        JOIN jsonb_each(v_old) AS o USING (key)
        WHERE n.value IS DISTINCT FROM o.value
          AND n.key NOT IN ('updated_at');
        IF v_changes = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
    END IF;

    CASE TG_TABLE_NAME
    WHEN 'checkpoints' THEN
        v_org := (v_row ->> 'organisation_id')::uuid;
        v_action := CASE
            WHEN TG_OP = 'INSERT' THEN 'checkpoint.created'
            WHEN TG_OP = 'DELETE' THEN 'checkpoint.deleted'
            WHEN v_changes ? 'nfc_uid' AND v_new ->> 'nfc_uid' IS NOT NULL THEN 'checkpoint.nfc_enrolled'
            WHEN v_changes ? 'nfc_uid' THEN 'checkpoint.nfc_removed'
            WHEN v_changes ? 'qr_code_hash' THEN 'checkpoint.qr_rotated'
            ELSE 'checkpoint.updated'
        END;
        v_details := jsonb_build_object(
            'site_id', v_row -> 'site_id',
            'name', v_row -> 'name',
            'nfc_uid_old', v_old -> 'nfc_uid',
            'nfc_uid_new', v_new -> 'nfc_uid',
            'changes', v_changes);
    WHEN 'user_roles' THEN
        SELECT p.organisation_id INTO v_org FROM public.profiles p WHERE p.id = (v_row ->> 'user_id')::uuid;
        v_action := CASE TG_OP WHEN 'INSERT' THEN 'role.granted' WHEN 'DELETE' THEN 'role.revoked' ELSE 'role.changed' END;
        v_details := jsonb_build_object(
            'user_id', v_row -> 'user_id',
            'role', v_row -> 'role',
            'old_role', v_old -> 'role');
    WHEN 'site_assignments' THEN
        SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = (v_row ->> 'site_id')::uuid;
        v_action := CASE TG_OP WHEN 'INSERT' THEN 'site_assignment.added' ELSE 'site_assignment.removed' END;
        v_details := jsonb_build_object('user_id', v_row -> 'user_id', 'site_id', v_row -> 'site_id');
    WHEN 'sites' THEN
        v_org := (v_row ->> 'organisation_id')::uuid;
        v_action := CASE TG_OP WHEN 'INSERT' THEN 'site.created' WHEN 'DELETE' THEN 'site.deleted' ELSE 'site.updated' END;
        v_details := jsonb_build_object('name', v_row -> 'name', 'code', v_row -> 'code', 'changes', v_changes);
    WHEN 'incidents', 'panic_alerts' THEN
        SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = (v_row ->> 'site_id')::uuid;
        v_action := (CASE TG_TABLE_NAME WHEN 'incidents' THEN 'incident' ELSE 'panic_alert' END)
                    || CASE
                           WHEN v_changes ? 'status' THEN '.status_changed'
                           WHEN v_changes ? 'acknowledged_by' THEN '.acknowledged'
                           ELSE '.notes_changed'
                       END;
        v_details := jsonb_build_object(
            'site_id', v_row -> 'site_id',
            'from', v_old -> 'status',
            'to', v_new -> 'status',
            'acknowledged_by', v_new -> 'acknowledged_by',
            'acknowledged_at', v_new -> 'acknowledged_at',
            'changes', v_changes);
    WHEN 'shifts' THEN
        -- The guard's own clock-out and notes are the normal flow (the shift
        -- row itself is the record). Everything a supervisor / admin changes,
        -- and every abandonment, is audited with old and new values.
        IF v_actor IS NOT DISTINCT FROM (v_old ->> 'guard_id')::uuid
           AND NOT (v_changes ? 'status' AND v_new ->> 'status' = 'abandoned') THEN
            RETURN NULL;
        END IF;
        SELECT s.organisation_id INTO v_org FROM public.sites s WHERE s.id = (v_row ->> 'site_id')::uuid;
        v_action := CASE WHEN v_changes ? 'status' THEN 'shift.status_changed' ELSE 'shift.updated' END;
        v_details := jsonb_build_object(
            'site_id', v_row -> 'site_id',
            'guard_id', v_row -> 'guard_id',
            'from', v_old -> 'status',
            'to', v_new -> 'status',
            'changes', v_changes);
    WHEN 'profiles' THEN
        v_org := (v_row ->> 'organisation_id')::uuid;
        v_action := CASE
            WHEN v_changes ? 'organisation_id' THEN 'profile.organisation_changed'
            WHEN v_changes ? 'is_active' AND (v_new ->> 'is_active')::boolean THEN 'profile.reactivated'
            WHEN v_changes ? 'is_active' THEN 'profile.deactivated'
            ELSE 'profile.admin_fields_changed'
        END;
        v_details := jsonb_build_object('user_id', v_row -> 'id', 'changes', v_changes);
        -- A move between organisations (service role only) is recorded in
        -- the organisation the user left as well.
        IF v_changes ? 'organisation_id'
           AND EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = (v_old ->> 'organisation_id')::uuid) THEN
            INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
            VALUES ((v_old ->> 'organisation_id')::uuid, v_actor, v_action, TG_TABLE_NAME,
                    (v_row ->> 'id')::uuid, v_details);
        END IF;
    ELSE
        RETURN NULL;
    END CASE;

    -- Rows removed by a cascade whose parent is already gone cannot be
    -- attributed to an organisation (a deleted user's roles are listed in
    -- its profile.deleted row instead); skip them rather than abort.
    IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = v_org) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    VALUES (v_org, v_actor, v_action, TG_TABLE_NAME, (v_row ->> 'id')::uuid, v_details);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_checkpoints ON public.checkpoints;
CREATE TRIGGER trg_audit_checkpoints
    AFTER INSERT OR UPDATE OR DELETE ON public.checkpoints
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_user_roles ON public.user_roles;
CREATE TRIGGER trg_audit_user_roles
    AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_site_assignments ON public.site_assignments;
CREATE TRIGGER trg_audit_site_assignments
    AFTER INSERT OR DELETE ON public.site_assignments
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_sites ON public.sites;
CREATE TRIGGER trg_audit_sites
    AFTER INSERT OR UPDATE OR DELETE ON public.sites
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_incidents_status ON public.incidents;
CREATE TRIGGER trg_audit_incidents_status
    AFTER UPDATE ON public.incidents
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
                       OR OLD.acknowledged_by IS DISTINCT FROM NEW.acknowledged_by
                       OR OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
                       OR OLD.supervisor_notes IS DISTINCT FROM NEW.supervisor_notes)
    EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_panic_alerts_status ON public.panic_alerts;
CREATE TRIGGER trg_audit_panic_alerts_status
    AFTER UPDATE ON public.panic_alerts
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
                       OR OLD.acknowledged_by IS DISTINCT FROM NEW.acknowledged_by
                       OR OLD.acknowledged_at IS DISTINCT FROM NEW.acknowledged_at
                       OR OLD.resolution_notes IS DISTINCT FROM NEW.resolution_notes)
    EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_shifts ON public.shifts;
CREATE TRIGGER trg_audit_shifts
    AFTER UPDATE ON public.shifts
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_change();

DROP TRIGGER IF EXISTS trg_audit_profiles_admin_fields ON public.profiles;
CREATE TRIGGER trg_audit_profiles_admin_fields
    AFTER UPDATE ON public.profiles
    FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active
                       OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id
                       OR OLD.employee_number IS DISTINCT FROM NEW.employee_number)
    EXECUTE FUNCTION public.audit_log_change();

-- Audit-log immutability (introduced in phase 2; recreated here, unchanged, so
-- this migration is self-contained where phase 2 was only pasted in by hand
-- and rolled back by its old storage.objects ALTER). Because the rows are
-- immutable, an organisation that has audit history cannot be deleted; users
-- are deactivated rather than deleted once they have evidence attached.
CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'Audit log entries are strictly immutable. Deletions and modifications are prohibited.';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_modification();

-- TRUNCATE bypasses row triggers; block it as well.
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON public.audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_audit_log_modification();


-- ========================================================================
-- 5. ROW LEVEL SECURITY POLICIES
--    Old policies are dropped by their exact names; the sweep below also
--    removes any other policy left on these tables (a stray permissive policy
--    would be OR-ed with the new ones and re-open the holes).
--    All policies are TO authenticated; anon has no policy anywhere.
--    Read policies compare against per-statement site / user arrays
--    (`= ANY ((SELECT f())::uuid[])`), so a read costs one lookup of the caller's
--    access, not one helper call per row of every tenant.
-- ========================================================================

ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrol_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patrol_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panic_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;

-- Old policies (init schema + phase 2), by exact name.
DROP POLICY IF EXISTS "Users can view their own organisation" ON public.organisations;
DROP POLICY IF EXISTS "Super admins can update organisation" ON public.organisations;
DROP POLICY IF EXISTS "Users can view sites in their org" ON public.sites;
DROP POLICY IF EXISTS "Admins can manage sites" ON public.sites;
DROP POLICY IF EXISTS "Client viewers can view permitted sites" ON public.sites;
DROP POLICY IF EXISTS "Users can view profiles in their org" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins can manage profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view user roles in their org" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage user roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users can view checkpoints at their sites" ON public.checkpoints;
DROP POLICY IF EXISTS "Admins can manage checkpoints" ON public.checkpoints;
DROP POLICY IF EXISTS "Guards can see own shifts, managers see all org shifts" ON public.shifts;
DROP POLICY IF EXISTS "Guards can insert own shifts" ON public.shifts;
DROP POLICY IF EXISTS "Guards can update own active shift" ON public.shifts;
DROP POLICY IF EXISTS "Guards can record scans" ON public.patrol_scans;
DROP POLICY IF EXISTS "Users can view scans in their org" ON public.patrol_scans;
DROP POLICY IF EXISTS "Guards can insert incidents" ON public.incidents;
DROP POLICY IF EXISTS "Users can view incidents in their org" ON public.incidents;
DROP POLICY IF EXISTS "Managers can update incidents" ON public.incidents;
DROP POLICY IF EXISTS "Guards can trigger panic alert" ON public.panic_alerts;
DROP POLICY IF EXISTS "Users can view panic alerts in their org" ON public.panic_alerts;
DROP POLICY IF EXISTS "Managers can acknowledge panic alerts" ON public.panic_alerts;
DROP POLICY IF EXISTS "Guards can manage gate entries" ON public.gate_entries;
DROP POLICY IF EXISTS "Allow org users to upload evidence media" ON storage.objects;
DROP POLICY IF EXISTS "Allow org users to view evidence media" ON storage.objects;

-- Sweep: drop every remaining policy on the application tables (this also
-- drops this migration's own policies on a re-run, before they are recreated).
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('organisations', 'sites', 'profiles', 'user_roles', 'site_assignments',
                            'checkpoints', 'shifts', 'patrol_rounds', 'patrol_scans', 'incidents',
                            'incident_media', 'panic_alerts', 'gate_entries', 'audit_logs', 'sync_events')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    END LOOP;

    -- Storage sweep: any policy on storage.objects that concerns the evidence bucket,
    -- whatever its name. Projects patched by hand (or by other tooling) may carry
    -- differently named, org-unscoped policies such as
    -- "Allow authenticated users to upload evidence media" that would otherwise be
    -- OR-ed with the policies below and re-open cross-organisation access.
    FOR r IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND (coalesce(qual, '') ILIKE '%evidence-media%'
               OR coalesce(with_check, '') ILIKE '%evidence-media%'
               OR policyname ILIKE '%evidence%')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
    END LOOP;
END $$;

-- Pin search_path on every SECURITY DEFINER function in public, including ones this
-- migration does not define (e.g. hand-added helpers such as is_admin()), and stop
-- anon from calling them.
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
          AND NOT EXISTS (
              SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
              WHERE c LIKE 'search_path=%')
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    END LOOP;
END $$;

-- organisations ----------------------------------------------------------
CREATE POLICY ee_organisations_select ON public.organisations
    FOR SELECT TO authenticated
    USING (id = (SELECT public.get_auth_org_id()));

CREATE POLICY ee_organisations_update ON public.organisations
    FOR UPDATE TO authenticated
    USING ((SELECT public.is_org_admin()) AND id = (SELECT public.get_auth_org_id()))
    WITH CHECK ((SELECT public.is_org_admin()) AND id = (SELECT public.get_auth_org_id()));

-- sites ------------------------------------------------------------------
-- (org test on the row itself so INSERT ... RETURNING works for admins)
CREATE POLICY ee_sites_select ON public.sites
    FOR SELECT TO authenticated
    USING (organisation_id = (SELECT public.get_auth_org_id())
           AND ((SELECT public.is_org_admin()) OR id = ANY ((SELECT public.assigned_site_ids())::uuid[])));

CREATE POLICY ee_sites_insert ON public.sites
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()));

CREATE POLICY ee_sites_update ON public.sites
    FOR UPDATE TO authenticated
    USING ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()))
    WITH CHECK ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()));

CREATE POLICY ee_sites_delete ON public.sites
    FOR DELETE TO authenticated
    USING ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()));

-- profiles ---------------------------------------------------------------
-- Own row is always readable (even when disabled, so the app can explain
-- why sign-in is refused); colleagues only for admins, or for supervisors
-- who share an assigned site. Client viewers read names through
-- site_people() and never see phone / employee numbers.
CREATE POLICY ee_profiles_select ON public.profiles
    FOR SELECT TO authenticated
    USING (id = (SELECT auth.uid())
           OR (organisation_id = (SELECT public.get_auth_org_id())
               AND ((SELECT public.is_org_admin()) OR id = ANY ((SELECT public.supervised_user_ids())::uuid[]))));

CREATE POLICY ee_profiles_update ON public.profiles
    FOR UPDATE TO authenticated
    USING (organisation_id = (SELECT public.get_auth_org_id())
           AND (id = (SELECT public.active_uid()) OR (SELECT public.is_org_admin())))
    WITH CHECK (organisation_id = (SELECT public.get_auth_org_id())
                AND (id = (SELECT public.active_uid()) OR (SELECT public.is_org_admin())));

CREATE POLICY ee_profiles_insert ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()));

CREATE POLICY ee_profiles_delete ON public.profiles
    FOR DELETE TO authenticated
    USING ((SELECT public.is_org_admin())
           AND organisation_id = (SELECT public.get_auth_org_id())
           AND id <> (SELECT auth.uid())
           AND (NOT public.is_super_admin_user(id) OR (SELECT public.has_role('super_admin'))));

-- user_roles -------------------------------------------------------------
CREATE POLICY ee_user_roles_select ON public.user_roles
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.active_uid())
           OR user_id = ANY ((SELECT public.org_user_ids())::uuid[]));

CREATE POLICY ee_user_roles_insert ON public.user_roles
    FOR INSERT TO authenticated
    WITH CHECK (public.can_assign_role(user_id, role));

CREATE POLICY ee_user_roles_update ON public.user_roles
    FOR UPDATE TO authenticated
    USING (public.can_assign_role(user_id, role))
    WITH CHECK (public.can_assign_role(user_id, role));

CREATE POLICY ee_user_roles_delete ON public.user_roles
    FOR DELETE TO authenticated
    USING (public.can_assign_role(user_id, role));

-- site_assignments (no UPDATE: remove and re-add) -------------------------
CREATE POLICY ee_site_assignments_select ON public.site_assignments
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));

CREATE POLICY ee_site_assignments_insert ON public.site_assignments
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_org_admin()) AND public.is_org_site(site_id) AND public.is_org_user(user_id));

CREATE POLICY ee_site_assignments_delete ON public.site_assignments
    FOR DELETE TO authenticated
    USING ((SELECT public.is_org_admin()) AND public.is_org_site(site_id) AND public.is_org_user(user_id));

-- checkpoints (secret columns: see section 8) -------------------------------
CREATE POLICY ee_checkpoints_select ON public.checkpoints
    FOR SELECT TO authenticated
    USING (site_id = ANY ((SELECT public.member_site_ids())::uuid[]));

CREATE POLICY ee_checkpoints_insert ON public.checkpoints
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.is_org_admin()) AND public.is_org_site(site_id));

CREATE POLICY ee_checkpoints_update ON public.checkpoints
    FOR UPDATE TO authenticated
    USING ((SELECT public.is_org_admin()) AND public.is_org_site(site_id))
    WITH CHECK ((SELECT public.is_org_admin()) AND public.is_org_site(site_id));

CREATE POLICY ee_checkpoints_delete ON public.checkpoints
    FOR DELETE TO authenticated
    USING ((SELECT public.is_org_admin()) AND public.is_org_site(site_id));

-- shifts (no DELETE) ------------------------------------------------------
CREATE POLICY ee_shifts_select ON public.shifts
    FOR SELECT TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.report_site_ids())::uuid[]));

-- The trigger may store a late-syncing, already superseded clock-in as
-- 'abandoned'; a client can only submit 'active'.
CREATE POLICY ee_shifts_insert ON public.shifts
    FOR INSERT TO authenticated
    WITH CHECK (guard_id = (SELECT public.active_uid())
                AND public.is_site_guard(site_id)
                AND status IN ('active', 'abandoned'));

CREATE POLICY ee_shifts_update ON public.shifts
    FOR UPDATE TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.managed_site_ids())::uuid[]))
    WITH CHECK (guard_id = (SELECT public.active_uid())
                OR site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));

-- patrol_rounds -----------------------------------------------------------
CREATE POLICY ee_patrol_rounds_select ON public.patrol_rounds
    FOR SELECT TO authenticated
    USING (public.can_read_shift(shift_id));

CREATE POLICY ee_patrol_rounds_insert ON public.patrol_rounds
    FOR INSERT TO authenticated
    WITH CHECK (public.is_own_active_shift(shift_id));

-- patrol_scans (immutable: no UPDATE / DELETE for anyone) ----------------
-- site_id has already been set from the shift by the BEFORE INSERT trigger
-- when WITH CHECK is evaluated. The guard's own shift at the site proves the
-- assignment at clock-in, so scans captured before an unassignment sync.
CREATE POLICY ee_patrol_scans_select ON public.patrol_scans
    FOR SELECT TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.report_site_ids())::uuid[]));

CREATE POLICY ee_patrol_scans_insert ON public.patrol_scans
    FOR INSERT TO authenticated
    WITH CHECK (guard_id = (SELECT public.active_uid())
                AND public.is_own_shift(shift_id, site_id));

-- incidents (no DELETE) ---------------------------------------------------
-- Without a shift the guard must be assigned to the site now; with a shift,
-- it must be their own shift at that site (captured while assigned).
CREATE POLICY ee_incidents_select ON public.incidents
    FOR SELECT TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.report_site_ids())::uuid[]));

CREATE POLICY ee_incidents_insert ON public.incidents
    FOR INSERT TO authenticated
    WITH CHECK (guard_id = (SELECT public.active_uid())
                AND CASE WHEN shift_id IS NULL THEN public.is_site_guard(site_id)
                         ELSE public.is_own_shift(shift_id, site_id) END
                AND status = 'reported'
                AND acknowledged_by IS NULL
                AND acknowledged_at IS NULL
                AND supervisor_notes IS NULL);

CREATE POLICY ee_incidents_update ON public.incidents
    FOR UPDATE TO authenticated
    USING (site_id = ANY ((SELECT public.managed_site_ids())::uuid[]))
    WITH CHECK (site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));

-- incident_media ------------------------------------------------------------
-- The sub-selects run under the caller's incidents RLS.
CREATE POLICY ee_incident_media_select ON public.incident_media
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_media.incident_id));

CREATE POLICY ee_incident_media_insert ON public.incident_media
    FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.incidents i
                        WHERE i.id = incident_media.incident_id
                          AND i.guard_id = (SELECT public.active_uid())));

-- panic_alerts (client viewers excluded; no DELETE) -----------------------
CREATE POLICY ee_panic_alerts_select ON public.panic_alerts
    FOR SELECT TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));

CREATE POLICY ee_panic_alerts_insert ON public.panic_alerts
    FOR INSERT TO authenticated
    WITH CHECK (guard_id = (SELECT public.active_uid())
                AND CASE WHEN shift_id IS NULL THEN public.is_site_guard(site_id)
                         ELSE public.is_own_shift(shift_id, site_id) END
                AND status = 'active'
                AND acknowledged_by IS NULL
                AND acknowledged_at IS NULL
                AND resolution_notes IS NULL);

CREATE POLICY ee_panic_alerts_update ON public.panic_alerts
    FOR UPDATE TO authenticated
    USING (site_id = ANY ((SELECT public.managed_site_ids())::uuid[]))
    WITH CHECK (site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));

-- gate_entries (append-only) ----------------------------------------------
-- Every member of a site (guards included) sees the site's gate log, so the
-- next shift knows which vehicles are still on the premises. A guard always
-- sees their own entries: INSERT ... ON CONFLICT (the sync engine's upsert)
-- also checks the new row against this policy, so a queued entry of a guard
-- who was unassigned since must still pass it.
CREATE POLICY ee_gate_entries_select ON public.gate_entries
    FOR SELECT TO authenticated
    USING (guard_id = (SELECT public.active_uid())
           OR site_id = ANY ((SELECT public.member_site_ids())::uuid[]));

CREATE POLICY ee_gate_entries_insert ON public.gate_entries
    FOR INSERT TO authenticated
    WITH CHECK (guard_id = (SELECT public.active_uid())
                AND CASE WHEN shift_id IS NULL THEN public.is_site_guard(site_id)
                         ELSE public.is_own_shift(shift_id, site_id) END);

-- audit_logs (read-only for org admins; written by trigger only) ----------
CREATE POLICY ee_audit_logs_select ON public.audit_logs
    FOR SELECT TO authenticated
    USING ((SELECT public.is_org_admin()) AND organisation_id = (SELECT public.get_auth_org_id()));

-- sync_events ---------------------------------------------------------------
CREATE POLICY ee_sync_events_select ON public.sync_events
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.active_uid())
           OR user_id = ANY ((SELECT public.org_user_ids())::uuid[]));

CREATE POLICY ee_sync_events_insert ON public.sync_events
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT public.active_uid()));


-- ========================================================================
-- 6. PRIVATE EVIDENCE STORAGE (bucket evidence-media)
--    Object path: {organisation_id}/{site_id}/{category}/{user_id}/{event_uuid}-{field}.{jpg|png|webp}
--    (canonical lower-case UUIDs; is_evidence_object_name()).
--    category: selfie | incident | vehicle | patrol
--    No UPDATE / DELETE policies: evidence is immutable, clients upload with
--    upsert:false and treat "already exists" on a retry as success.
-- ========================================================================

-- Bucket row (same values as phase 2): private, 10 MB, images only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('evidence-media', 'evidence-media', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS ee_evidence_insert ON storage.objects;
DROP POLICY IF EXISTS ee_evidence_select ON storage.objects;

-- Uploads: own folder, own organisation, a site the caller guards now or had
-- a recent shift at (photos queued before an unassignment still upload).
CREATE POLICY ee_evidence_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'evidence-media'
        AND public.is_evidence_object_name(name)
        AND split_part(name, '/', 1) = (SELECT public.get_auth_org_id())::text
        AND split_part(name, '/', 4) = (SELECT auth.uid())::text
        AND (public.is_site_guard(public.try_uuid(split_part(name, '/', 2)))
             OR public.has_recent_shift_at_site(public.try_uuid(split_part(name, '/', 2))))
    );

CREATE POLICY ee_evidence_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'evidence-media'
        AND split_part(name, '/', 1) = (SELECT public.get_auth_org_id())::text
        AND (
            split_part(name, '/', 4) = (SELECT auth.uid())::text
            OR public.try_uuid(split_part(name, '/', 2)) = ANY ((SELECT public.managed_site_ids())::uuid[])
            OR (split_part(name, '/', 3) IN ('incident', 'vehicle')
                AND public.try_uuid(split_part(name, '/', 2)) = ANY ((SELECT public.viewer_site_ids())::uuid[]))
        )
    );


-- ========================================================================
-- 7. REALTIME
--    Supervisor dashboards subscribe to these tables; Realtime applies the
--    subscriber's RLS SELECT policies to every change it delivers.
-- ========================================================================
DO $$
DECLARE
    t text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['shifts', 'patrol_scans', 'incidents', 'panic_alerts', 'gate_entries'] LOOP
            IF NOT EXISTS (
                SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
            ) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            END IF;
        END LOOP;
    ELSE
        RAISE NOTICE 'Publication supabase_realtime not found; realtime tables not added.';
    END IF;
END $$;


-- ========================================================================
-- 8. READ APIs (RPC) AND PRIVILEGES
-- ========================================================================

-- Raw QR tokens and NFC serials of the organisation's checkpoints, for org
-- admins only (printing QR cards, showing which tag is enrolled). Every call
-- is audited. supabase.rpc('get_checkpoint_secrets', { p_site_id }).
CREATE OR REPLACE FUNCTION public.get_checkpoint_secrets(p_site_id uuid DEFAULT NULL)
RETURNS TABLE (checkpoint_id uuid, site_id uuid, qr_token text, nfc_uid text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid := public.get_auth_org_id();
    v_count integer;
BEGIN
    IF v_org IS NULL OR NOT public.is_org_admin()
       OR (p_site_id IS NOT NULL AND NOT public.is_org_site(p_site_id)) THEN
        RAISE EXCEPTION 'Only an organisation admin can view checkpoint QR tokens and NFC serials'
            USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
        SELECT c.id, c.site_id, c.qr_code_hash::text, c.nfc_uid::text
        FROM public.checkpoints c
        WHERE c.organisation_id = v_org
          AND (p_site_id IS NULL OR c.site_id = p_site_id)
        ORDER BY c.site_id, c.order_index, c.name;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    VALUES (v_org, auth.uid(), 'checkpoint.secrets_viewed', 'sites', p_site_id,
            jsonb_build_object('site_id', p_site_id, 'checkpoints', v_count));
END;
$$;

-- Names (only) of the people on a site the caller belongs to: assigned
-- users, guards who worked shifts there and supervisors who acknowledged its
-- incidents. For client viewer reports; supabase.rpc('site_people', ...).
CREATE OR REPLACE FUNCTION public.site_people(p_site_id uuid)
RETURNS TABLE (user_id uuid, first_name text, last_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.first_name::text, p.last_name::text
  FROM public.profiles p
  WHERE public.is_site_member(p_site_id)
    AND p.organisation_id = public.get_auth_org_id()
    AND (EXISTS (SELECT 1 FROM public.site_assignments sa WHERE sa.site_id = p_site_id AND sa.user_id = p.id)
         OR EXISTS (SELECT 1 FROM public.shifts sh WHERE sh.site_id = p_site_id AND sh.guard_id = p.id)
         OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.site_id = p_site_id AND i.acknowledged_by = p.id))
  ORDER BY p.last_name, p.first_name
$$;

-- anon (not signed in) gets nothing in public.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- authenticated: TRUNCATE ignores RLS; append-only tables lose UPDATE/DELETE.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE UPDATE, DELETE ON public.patrol_scans, public.gate_entries, public.incident_media,
    public.sync_events, public.patrol_rounds FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audit_logs FROM authenticated;
REVOKE DELETE ON public.shifts, public.incidents, public.panic_alerts FROM authenticated;

-- Checkpoint secrets: the printed QR token (qr_code_hash) and the NFC serial
-- (nfc_uid) are not readable by any signed-in role; the app matches scans
-- against qr_token_sha256 / nfc_uid_sha256 and admins read the raw values
-- through get_checkpoint_secrets(). Admins still INSERT / UPDATE them.
REVOKE SELECT ON public.checkpoints FROM authenticated;
GRANT SELECT (id, site_id, organisation_id, name, description, latitude, longitude,
              permitted_radius_meters, order_index, is_active, deactivated_at, legacy_code,
              qr_token_sha256, qr_token_strong, nfc_uid_sha256, nfc_enrolled_at, nfc_enrolled_by,
              created_at, updated_at)
    ON public.checkpoints TO authenticated;

-- Functions: nothing is executable by PUBLIC / anon. Signed-in users may call
-- the helpers their policies use, the pure helpers and the RPCs; trigger and
-- internal evidence functions are not callable directly.
DO $$
DECLARE
    r record;
    v_internal text[] := ARRAY['assert_device_time', 'assert_in_shift_window', 'site_shift_candidates',
                               'resolve_shift_schedule', 'selfie_in_use'];
BEGIN
    FOR r IN
        SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS sig,
               p.proname,
               p.prorettype = 'trigger'::regtype AS is_trigger
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
        IF r.is_trigger OR r.proname = ANY (v_internal) THEN
            EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
        ELSE
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
        END IF;
    END LOOP;
END $$;

-- Objects created later by the migration role: functions are no longer
-- executable by PUBLIC (anon) by default, and neither anon nor authenticated
-- receives table privileges that bypass RLS (TRUNCATE) or table ownership
-- features. New functions must be granted to authenticated explicitly
-- (Supabase's schema-level default grant does that for public).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;


-- ========================================================================
-- 9. DATA FIXES FOR THE ORIGINAL DEMO SEED
--    The first seed.sql shipped fabricated NFC serials (04:7A:B2:C1..C6)
--    that were never read from a real tag, predictable QR tokens that are
--    public in the Git history, invented checkpoint / site coordinates and
--    invented phone numbers (an SOS or WhatsApp report could reach a
--    stranger). Clear the fake serials (re-enrol with the real tags), rotate
--    the predictable tokens (reprint those QR cards), clear invented values
--    only where they still equal the old seed's exact literals, and keep
--    Dawie's card codes CP1..CP6 as legacy_code (his printed cards keep
--    scanning, unverified, until allow_legacy_qr is switched off).
--    No-op on re-run.
-- ========================================================================
UPDATE public.checkpoints
SET nfc_uid = NULL
WHERE nfc_uid IN ('04:7a:b2:c1', '04:7a:b2:c2', '04:7a:b2:c3', '04:7a:b2:c4', '04:7a:b2:c5', '04:7a:b2:c6');

WITH demo (token, code, lat, lng, radius) AS (
    VALUES ('EE-CP-MAIN-GATE-01', 'CP1', -25.684120::float8, 27.814520::float8, 50),
           ('EE-CP-SHEEP-KRAAL-02', 'CP2', -25.684890, 27.815210, 60),
           ('EE-CP-POULTRY-SHED-03', 'CP3', -25.683500, 27.814010, 50),
           ('EE-CP-WORKSHOP-04', 'CP4', -25.684300, 27.813800, 50),
           ('EE-CP-SHADE-GARDEN-05', 'CP5', -25.685100, 27.814900, 50),
           ('EE-CP-NORTH-FENCE-06', 'CP6', -25.682900, 27.814300, 75)
),
migrated AS (
    UPDATE public.checkpoints c
    SET legacy_code = coalesce(c.legacy_code, d.code),
        qr_code_hash = 'EE-CP-' || upper(replace(gen_random_uuid()::text, '-', '')),
        latitude = CASE WHEN c.latitude = d.lat AND c.longitude = d.lng THEN NULL ELSE c.latitude END,
        longitude = CASE WHEN c.latitude = d.lat AND c.longitude = d.lng THEN NULL ELSE c.longitude END,
        permitted_radius_meters = CASE WHEN c.permitted_radius_meters = d.radius THEN 50
                                       ELSE c.permitted_radius_meters END
    FROM demo d
    WHERE c.qr_code_hash = d.token
    RETURNING c.site_id
)
UPDATE public.sites s
SET allow_legacy_qr = true
WHERE s.id IN (SELECT m.site_id FROM migrated m);

UPDATE public.sites
SET latitude = CASE WHEN latitude = -25.684120 AND longitude = 27.814520 THEN NULL ELSE latitude END,
    longitude = CASE WHEN latitude = -25.684120 AND longitude = 27.814520 THEN NULL ELSE longitude END,
    address = CASE WHEN address = 'R512 Farm Road, Brits / Hartbeespoort, North West' THEN NULL ELSE address END,
    emergency_phone = CASE WHEN emergency_phone = '+27 82 999 4321' THEN NULL ELSE emergency_phone END,
    whatsapp_dispatch_number = CASE WHEN whatsapp_dispatch_number = '+27829994321' THEN NULL
                                    ELSE whatsapp_dispatch_number END
WHERE id = '22222222-2222-2222-2222-222222222222'
  AND ((latitude = -25.684120 AND longitude = 27.814520)
       OR address = 'R512 Farm Road, Brits / Hartbeespoort, North West'
       OR emergency_phone = '+27 82 999 4321'
       OR whatsapp_dispatch_number = '+27829994321');

UPDATE public.organisations
SET registration_number = CASE WHEN registration_number = '2026/089412/07' THEN NULL ELSE registration_number END,
    contact_phone = CASE WHEN contact_phone = '+27 82 000 1234' THEN NULL ELSE contact_phone END,
    contact_email = CASE WHEN contact_email = 'ops@aiguillesecurity.co.za' THEN NULL ELSE contact_email END
WHERE id = '11111111-1111-1111-1111-111111111111'
  AND (registration_number = '2026/089412/07'
       OR contact_phone = '+27 82 000 1234'
       OR contact_email = 'ops@aiguillesecurity.co.za');
