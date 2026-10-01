-- ========================================================================
-- EAGLE EYE SECURITY - ENROLLED PATROL PHONES (2026-10-01)
--
-- Guards work at night, in rain and with gloves on shared patrol / gate
-- phones, so they do not type an e-mail address or a password. Instead a
-- supervisor (assigned to the site) or an org admin, signed in on the shared
-- phone, ENROLS that phone for ONE site. The phone keeps a random device
-- secret; the database stores only its SHA-256. Only a request that carries
-- a valid, non-revoked device secret can list that site's guards and obtain
-- a session for one of them (through the server routes
-- /api/auth/device-roster and /api/auth/device-login, which call the
-- service-role-only functions below). Anyone without an enrolled phone signs
-- in with e-mail + password. Admins and supervisors ALWAYS sign in with
-- e-mail + password: a manager can never get a session through a patrol
-- phone.
--
-- What this does and does not prove: a device sign-in shows that someone
-- holding an enrolled phone tapped that guard's name. It is not identity
-- verification. The clock-in selfie and the GPS position the phone reports
-- are attendance EVIDENCE for supervisors to review (there is no facial
-- recognition). Every enrolment, revocation and device sign-in is written to
-- audit_logs; the device secret itself is never logged or returned again.
--
-- Objects:
--   table  public.patrol_devices          (RLS; read-only for managers of
--                                          the site; secret_sha256 hidden)
--   rpc    public.enrol_patrol_device()   (authenticated: admin / assigned
--                                          supervisor)
--   rpc    public.revoke_patrol_device()  (authenticated: admin / assigned
--                                          supervisor)
--   fn     public.device_roster()         (service_role only)
--   fn     public.device_guard_login()    (service_role only)
--   trg    patrol_devices_enroller_access_changed / _site_changed
--          (a phone is revoked as soon as the person who enrolled it can no
--          longer manage its site, or the site is switched off)
--   trg    profiles_guard_names_admin_only (a guard cannot rename
--          themselves: the names are the buttons on the patrol phone)
--
-- A phone works only while ALL of this holds: not revoked, its site active
-- and in its organisation, and the person who enrolled it is still an
-- active org admin of that organisation or an active supervisor assigned
-- to the site (checked on every use; the triggers also revoke the row so
-- the list shows the truth). Only people who hold the guard role and no
-- other role are listed and signed in.
--
-- Requires 20261001000000_security_audit_hardening.sql (helpers
-- can_manage_site, managed_site_ids, sha256_hex). IDEMPOTENT: every
-- statement can be re-run safely (SQL Editor or CLI). Creates nothing in the
-- auth or storage schemas; reads auth.users (e-mail) inside one
-- SECURITY DEFINER function only.
--
-- If 20261001000000_security_audit_hardening.sql is ever pasted again AFTER
-- this file, paste this file again too: the hardening migration re-grants
-- EXECUTE on every public function to authenticated. The two service-role
-- functions also refuse anon / authenticated callers in their body, so a
-- missed re-run does not open them.
-- ========================================================================


-- ========================================================================
-- 0. PREREQUISITES
-- ========================================================================
DO $$
BEGIN
    IF to_regprocedure('public.can_manage_site(uuid)') IS NULL
       OR to_regprocedure('public.managed_site_ids()') IS NULL
       OR to_regprocedure('public.sha256_hex(text)') IS NULL THEN
        RAISE EXCEPTION 'Apply 20261001000000_security_audit_hardening.sql before 20261001000200_patrol_devices.sql';
    END IF;
END $$;


-- ========================================================================
-- 1. TABLE
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.patrol_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    label varchar(80) NOT NULL,
    -- Lower-case hex SHA-256 of the device secret. Never the secret itself;
    -- not selectable by any signed-in role (column privileges, section 4).
    secret_sha256 text NOT NULL UNIQUE,
    enrolled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    last_guard_id uuid,
    revoked_at timestamptz,
    revoked_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.patrol_devices DROP CONSTRAINT IF EXISTS patrol_devices_secret_sha256_check;
ALTER TABLE public.patrol_devices ADD CONSTRAINT patrol_devices_secret_sha256_check
    CHECK (secret_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE public.patrol_devices DROP CONSTRAINT IF EXISTS patrol_devices_label_check;
ALTER TABLE public.patrol_devices ADD CONSTRAINT patrol_devices_label_check
    CHECK (length(btrim(label)) BETWEEN 1 AND 80);

CREATE INDEX IF NOT EXISTS idx_patrol_devices_site ON public.patrol_devices (site_id);
CREATE INDEX IF NOT EXISTS idx_patrol_devices_org ON public.patrol_devices (organisation_id);


-- ========================================================================
-- 2. ROW LEVEL SECURITY
--    Managers read the devices of the sites they manage (org admins: every
--    site of the org; supervisors: assigned sites). There are NO insert /
--    update / delete policies: devices are written only by the functions
--    below.
-- ========================================================================
ALTER TABLE public.patrol_devices ENABLE ROW LEVEL SECURITY;

-- Drop every policy on the table (also this file's own on a re-run), so a
-- stray permissive policy can never be OR-ed with the one below.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'patrol_devices'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.patrol_devices', r.policyname);
    END LOOP;
END $$;

CREATE POLICY ee_patrol_devices_select ON public.patrol_devices
    FOR SELECT TO authenticated
    USING (site_id = ANY ((SELECT public.managed_site_ids())::uuid[]));


-- ========================================================================
-- 3. FUNCTIONS
--    SECURITY DEFINER, pinned search_path, fully qualified names.
-- ========================================================================

-- Enrols the phone the caller is signed in on as a patrol phone for one
-- site. Returns the device secret ONCE (the phone stores it); the database
-- keeps only its SHA-256. supabase.rpc('enrol_patrol_device', { p_site_id, p_label }).
--   42501  caller is not an active org admin of the site's organisation and
--          not an active supervisor assigned to the site (also: unknown site,
--          other organisation, disabled account, not signed in)
--   22023  label empty after trimming or longer than 80 characters
-- The secret is 'EED-' + 64 lower-case hex characters taken from two
-- gen_random_uuid() values (core Postgres, cryptographically strong random
-- source; 244 random bits - no extension needed).
CREATE OR REPLACE FUNCTION public.enrol_patrol_device(p_site_id uuid, p_label text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_label text := btrim(coalesce(p_label, ''));
    v_org uuid;
    v_site_name text;
    v_secret text;
    v_id uuid;
BEGIN
    IF v_uid IS NULL OR p_site_id IS NULL OR NOT public.can_manage_site(p_site_id) THEN
        RAISE EXCEPTION 'Only an organisation admin or a supervisor of this site can enrol a patrol phone'
            USING ERRCODE = '42501';
    END IF;
    IF length(v_label) < 1 OR length(v_label) > 80 THEN
        RAISE EXCEPTION 'The phone label must be 1 to 80 characters'
            USING ERRCODE = '22023';
    END IF;

    SELECT s.organisation_id, s.name::text
    INTO v_org, v_site_name
    FROM public.sites s
    WHERE s.id = p_site_id;

    v_secret := 'EED-' || replace(gen_random_uuid()::text, '-', '')
                       || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO public.patrol_devices (organisation_id, site_id, label, secret_sha256, enrolled_by)
    VALUES (v_org, p_site_id, v_label, public.sha256_hex(v_secret), v_uid)
    RETURNING id INTO v_id;

    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    VALUES (v_org, v_uid, 'patrol_device.enrolled', 'patrol_devices', v_id,
            jsonb_build_object('device_id', v_id, 'site_id', p_site_id, 'label', v_label));

    RETURN jsonb_build_object(
        'device_id', v_id,
        'device_secret', v_secret,
        'site_id', p_site_id,
        'site_name', v_site_name,
        'label', v_label);
END;
$$;

-- Revokes a patrol phone (it can no longer list guards or sign anyone in).
-- Same rule as enrolment, on the device's site; an unknown device gets the
-- same 42501 as a foreign one. Revoking an already revoked device changes
-- nothing (the first revocation's time and actor are kept).
-- supabase.rpc('revoke_patrol_device', { p_device_id }).
CREATE OR REPLACE FUNCTION public.revoke_patrol_device(p_device_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_device public.patrol_devices%ROWTYPE;
BEGIN
    SELECT d.* INTO v_device
    FROM public.patrol_devices d
    WHERE d.id = p_device_id
    FOR UPDATE;

    IF v_uid IS NULL OR v_device.id IS NULL OR NOT public.can_manage_site(v_device.site_id) THEN
        RAISE EXCEPTION 'Only an organisation admin or a supervisor of this site can revoke this patrol phone'
            USING ERRCODE = '42501';
    END IF;

    IF v_device.revoked_at IS NOT NULL THEN
        RETURN;
    END IF;

    UPDATE public.patrol_devices
    SET revoked_at = now(),
        revoked_by = v_uid
    WHERE id = v_device.id;

    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    VALUES (v_device.organisation_id, v_uid, 'patrol_device.revoked', 'patrol_devices', v_device.id,
            jsonb_build_object('device_id', v_device.id, 'site_id', v_device.site_id, 'label', v_device.label));
END;
$$;

-- SERVICE ROLE ONLY (server route /api/auth/device-roster).
-- The guards a patrol phone may sign in: ACTIVE profiles of the device's
-- organisation assigned to the device's site whose ONLY role is 'guard'
-- (allow-list: a guard who also holds admin / super_admin / supervisor /
-- client_viewer or any role added later is not listed - those accounts sign
-- in with e-mail + password). Names only: no e-mail, phone or employee
-- number. NULL when the secret is unknown or malformed, the device is
-- revoked, its site is inactive, or the person who enrolled it can no
-- longer manage the site.
--   {"device": {"id", "label"}, "site": {"id", "name"},
--    "guards": [{"id", "first_name", "last_name"}, ...]}
CREATE OR REPLACE FUNCTION public.device_roster(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_device record;
BEGIN
    -- Defence in depth: EXECUTE is granted to service_role only, but refuse a
    -- signed-in or anonymous API caller even if a later grant re-opened it.
    IF auth.role() IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'device_roster is available to the server only' USING ERRCODE = '42501';
    END IF;

    IF p_secret IS NULL OR p_secret !~ '^EED-[0-9a-f]{64}$' THEN
        RETURN NULL;
    END IF;

    SELECT d.id, d.label::text AS label, d.organisation_id, d.site_id, s.name::text AS site_name
    INTO v_device
    FROM public.patrol_devices d
    JOIN public.sites s ON s.id = d.site_id
    WHERE d.secret_sha256 = public.sha256_hex(p_secret)
      AND d.revoked_at IS NULL
      AND s.is_active
      AND s.organisation_id = d.organisation_id
      -- The enroller must still be allowed to manage the site (same rule as
      -- can_manage_site(), for the enroller): an active org admin of the
      -- device's organisation, or an active supervisor assigned to the site.
      AND EXISTS (
          SELECT 1
          FROM public.profiles ep
          WHERE ep.id = d.enrolled_by
            AND ep.is_active
            AND ep.organisation_id = d.organisation_id
            AND (EXISTS (SELECT 1 FROM public.user_roles er
                         WHERE er.user_id = ep.id AND er.role IN ('admin', 'super_admin'))
                 OR (EXISTS (SELECT 1 FROM public.user_roles er
                             WHERE er.user_id = ep.id AND er.role = 'supervisor')
                     AND EXISTS (SELECT 1 FROM public.site_assignments ea
                                 WHERE ea.user_id = ep.id AND ea.site_id = d.site_id))));

    IF v_device.id IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'device', jsonb_build_object('id', v_device.id, 'label', v_device.label),
        'site', jsonb_build_object('id', v_device.site_id, 'name', v_device.site_name),
        'guards', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', p.id,
                                                'first_name', p.first_name,
                                                'last_name', p.last_name)
                             ORDER BY p.first_name, p.last_name, p.id)
            FROM public.profiles p
            WHERE p.is_active
              AND p.organisation_id = v_device.organisation_id
              AND EXISTS (SELECT 1 FROM public.site_assignments sa
                          WHERE sa.site_id = v_device.site_id AND sa.user_id = p.id)
              AND EXISTS (SELECT 1 FROM public.user_roles ur
                          WHERE ur.user_id = p.id AND ur.role = 'guard')
              AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                              WHERE ur.user_id = p.id AND ur.role <> 'guard')
        ), '[]'::jsonb));
END;
$$;

-- SERVICE ROLE ONLY (server route /api/auth/device-login).
-- Checks that the device is enrolled and that p_guard_id is on its roster
-- (same rule as device_roster), records the use and returns the guard's
-- auth e-mail so the SERVER can create a one-time sign-in link for exactly
-- that guard. The e-mail never comes from, and is never sent to, the phone.
--   42501 'device_not_enrolled'  unknown / malformed secret, revoked device,
--                                inactive site, or the enroller can no
--                                longer manage the site
--   42501 'guard_not_allowed'    not an active guard of this organisation
--                                assigned to this site, holds any role
--                                besides 'guard', or has no e-mail to sign
--                                in with
-- On success: last_used_at / last_guard_id updated and an audit row
-- 'patrol_device.guard_signed_in' (actor = the guard). The row records that
-- the server was asked to sign this guard in on this phone; the session
-- itself exists once the phone redeems the one-time link (Supabase Auth
-- records that as the user's last sign-in).
--   {"user_id", "email", "device_id", "site_id"}
CREATE OR REPLACE FUNCTION public.device_guard_login(p_secret text, p_guard_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_device record;
    v_email text;
BEGIN
    IF auth.role() IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'device_guard_login is available to the server only' USING ERRCODE = '42501';
    END IF;

    SELECT d.id, d.organisation_id, d.site_id
    INTO v_device
    FROM public.patrol_devices d
    JOIN public.sites s ON s.id = d.site_id
    WHERE p_secret IS NOT NULL
      AND p_secret ~ '^EED-[0-9a-f]{64}$'
      AND d.secret_sha256 = public.sha256_hex(p_secret)
      AND d.revoked_at IS NULL
      AND s.is_active
      AND s.organisation_id = d.organisation_id
      -- Same enroller rule as device_roster.
      AND EXISTS (
          SELECT 1
          FROM public.profiles ep
          WHERE ep.id = d.enrolled_by
            AND ep.is_active
            AND ep.organisation_id = d.organisation_id
            AND (EXISTS (SELECT 1 FROM public.user_roles er
                         WHERE er.user_id = ep.id AND er.role IN ('admin', 'super_admin'))
                 OR (EXISTS (SELECT 1 FROM public.user_roles er
                             WHERE er.user_id = ep.id AND er.role = 'supervisor')
                     AND EXISTS (SELECT 1 FROM public.site_assignments ea
                                 WHERE ea.user_id = ep.id AND ea.site_id = d.site_id))))
    FOR UPDATE OF d;

    IF v_device.id IS NULL THEN
        RAISE EXCEPTION 'device_not_enrolled' USING ERRCODE = '42501';
    END IF;

    IF p_guard_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = p_guard_id
          AND p.is_active
          AND p.organisation_id = v_device.organisation_id
          AND EXISTS (SELECT 1 FROM public.site_assignments sa
                      WHERE sa.site_id = v_device.site_id AND sa.user_id = p.id)
          AND EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.id AND ur.role = 'guard')
          AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                          WHERE ur.user_id = p.id AND ur.role <> 'guard')
    ) THEN
        RAISE EXCEPTION 'guard_not_allowed' USING ERRCODE = '42501';
    END IF;

    SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_guard_id;
    IF v_email IS NULL OR btrim(v_email) = '' THEN
        RAISE EXCEPTION 'guard_not_allowed' USING ERRCODE = '42501';
    END IF;

    UPDATE public.patrol_devices
    SET last_used_at = now(),
        last_guard_id = p_guard_id
    WHERE id = v_device.id;

    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    VALUES (v_device.organisation_id, p_guard_id, 'patrol_device.guard_signed_in', 'patrol_devices', v_device.id,
            jsonb_build_object('device_id', v_device.id, 'site_id', v_device.site_id));

    RETURN jsonb_build_object(
        'user_id', p_guard_id,
        'email', v_email,
        'device_id', v_device.id,
        'site_id', v_device.site_id);
END;
$$;


-- ========================================================================
-- 3b. AUTOMATIC REVOCATION
--     A patrol phone must not outlive its enroller's right to manage the
--     site (offboarded, disabled or deleted supervisor / admin), and a
--     switched-off site keeps no working phones. device_roster /
--     device_guard_login already refuse such phones on every use; these
--     triggers also revoke the row (revoked_by = whoever made the change,
--     NULL for the service role) and write 'patrol_device.revoked' with a
--     reason, so the Patrol phones list and the audit trail show it.
--     Rows being removed by a cascade (site or organisation deleted) are
--     left to the cascade.
-- ========================================================================

-- profiles (deactivated, moved, deleted), user_roles (role removed or
-- changed), site_assignments (unassigned): revoke the active phones this
-- person enrolled for sites they can no longer manage (all of them when the
-- profile is deleted).
CREATE OR REPLACE FUNCTION public.patrol_devices_enroller_access_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user uuid;
    v_deleted_profile boolean := (TG_TABLE_NAME = 'profiles' AND TG_OP = 'DELETE');
    v_reason text;
BEGIN
    IF TG_TABLE_NAME = 'profiles' THEN
        v_user := OLD.id;
        v_reason := CASE WHEN TG_OP = 'DELETE' THEN 'enroller_deleted' ELSE 'enroller_deactivated' END;
    ELSE
        v_user := OLD.user_id;
        v_reason := CASE TG_TABLE_NAME WHEN 'user_roles' THEN 'enroller_role_removed' ELSE 'enroller_unassigned' END;
    END IF;

    WITH revoked AS (
        UPDATE public.patrol_devices d
        SET revoked_at = now(),
            revoked_by = auth.uid()
        WHERE d.enrolled_by = v_user
          AND d.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM public.sites s WHERE s.id = d.site_id)
          AND EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = d.organisation_id)
          AND (v_deleted_profile OR NOT EXISTS (
              SELECT 1
              FROM public.profiles ep
              WHERE ep.id = d.enrolled_by
                AND ep.is_active
                AND ep.organisation_id = d.organisation_id
                AND (EXISTS (SELECT 1 FROM public.user_roles er
                             WHERE er.user_id = ep.id AND er.role IN ('admin', 'super_admin'))
                     OR (EXISTS (SELECT 1 FROM public.user_roles er
                                 WHERE er.user_id = ep.id AND er.role = 'supervisor')
                         AND EXISTS (SELECT 1 FROM public.site_assignments ea
                                     WHERE ea.user_id = ep.id AND ea.site_id = d.site_id)))))
        RETURNING d.id, d.organisation_id, d.site_id, d.label
    )
    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    SELECT r.organisation_id, auth.uid(), 'patrol_device.revoked', 'patrol_devices', r.id,
           jsonb_build_object('device_id', r.id, 'site_id', r.site_id, 'label', r.label,
                              'reason', v_reason, 'enrolled_by', v_user)
    FROM revoked r;

    IF v_deleted_profile THEN
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_patrol_devices_enroller_profile ON public.profiles;
CREATE TRIGGER trg_patrol_devices_enroller_profile
    AFTER UPDATE OF is_active, organisation_id ON public.profiles
    FOR EACH ROW
    WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
    EXECUTE FUNCTION public.patrol_devices_enroller_access_changed();

DROP TRIGGER IF EXISTS trg_patrol_devices_enroller_profile_delete ON public.profiles;
CREATE TRIGGER trg_patrol_devices_enroller_profile_delete
    BEFORE DELETE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.patrol_devices_enroller_access_changed();

DROP TRIGGER IF EXISTS trg_patrol_devices_enroller_roles ON public.user_roles;
CREATE TRIGGER trg_patrol_devices_enroller_roles
    AFTER UPDATE OR DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.patrol_devices_enroller_access_changed();

DROP TRIGGER IF EXISTS trg_patrol_devices_enroller_assignments ON public.site_assignments;
CREATE TRIGGER trg_patrol_devices_enroller_assignments
    AFTER UPDATE OR DELETE ON public.site_assignments
    FOR EACH ROW EXECUTE FUNCTION public.patrol_devices_enroller_access_changed();

-- sites: switched off, or moved to another organisation -> its phones are
-- revoked (switching the site on again does not bring them back: enrol the
-- phones again).
CREATE OR REPLACE FUNCTION public.patrol_devices_site_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    WITH revoked AS (
        UPDATE public.patrol_devices d
        SET revoked_at = now(),
            revoked_by = auth.uid()
        WHERE d.site_id = NEW.id
          AND d.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = d.organisation_id)
        RETURNING d.id, d.organisation_id, d.site_id, d.label
    )
    INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
    SELECT r.organisation_id, auth.uid(), 'patrol_device.revoked', 'patrol_devices', r.id,
           jsonb_build_object('device_id', r.id, 'site_id', r.site_id, 'label', r.label,
                              'reason', CASE WHEN NEW.is_active THEN 'site_moved' ELSE 'site_deactivated' END)
    FROM revoked r;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_patrol_devices_site_changed ON public.sites;
CREATE TRIGGER trg_patrol_devices_site_changed
    AFTER UPDATE OF is_active, organisation_id ON public.sites
    FOR EACH ROW
    WHEN ((OLD.is_active AND NOT NEW.is_active) OR OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
    EXECUTE FUNCTION public.patrol_devices_site_changed();

-- Existing phones whose enroller or site no longer qualifies (a re-run, or
-- changes made while the triggers did not exist yet): revoke them now.
WITH revoked AS (
    UPDATE public.patrol_devices d
    SET revoked_at = now()
    WHERE d.revoked_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM public.sites s
          JOIN public.profiles ep ON ep.id = d.enrolled_by
          WHERE s.id = d.site_id
            AND s.is_active
            AND s.organisation_id = d.organisation_id
            AND ep.is_active
            AND ep.organisation_id = d.organisation_id
            AND (EXISTS (SELECT 1 FROM public.user_roles er
                         WHERE er.user_id = ep.id AND er.role IN ('admin', 'super_admin'))
                 OR (EXISTS (SELECT 1 FROM public.user_roles er
                             WHERE er.user_id = ep.id AND er.role = 'supervisor')
                     AND EXISTS (SELECT 1 FROM public.site_assignments ea
                                 WHERE ea.user_id = ep.id AND ea.site_id = d.site_id))))
    RETURNING d.id, d.organisation_id, d.site_id, d.label
)
INSERT INTO public.audit_logs (organisation_id, actor_id, action, resource_type, resource_id, details)
SELECT r.organisation_id, NULL, 'patrol_device.revoked', 'patrol_devices', r.id,
       jsonb_build_object('device_id', r.id, 'site_id', r.site_id, 'label', r.label, 'reason', 'no_longer_valid')
FROM revoked r;


-- ========================================================================
-- 3c. GUARD NAMES ARE ADMIN-CONTROLLED
--     The first and last name of a guard are the buttons on the patrol
--     phone. If a guard could rename themselves they could create a second
--     "Thabo Mokoena" button and have a colleague sign in (and work a shift)
--     under the wrong account. Phone number, language and avatar stay
--     self-service; the service role (auth.uid() NULL) is not restricted.
-- ========================================================================
CREATE OR REPLACE FUNCTION public.profiles_guard_names_admin_only()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL
       OR (NEW.first_name IS NOT DISTINCT FROM OLD.first_name
           AND NEW.last_name IS NOT DISTINCT FROM OLD.last_name) THEN
        RETURN NEW;
    END IF;
    IF public.is_org_admin() AND OLD.organisation_id = public.get_auth_org_id() THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = OLD.id AND ur.role = 'guard') THEN
        RAISE EXCEPTION 'A guard''s name is shown on patrol phones: only an organisation admin can change it'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_names_admin_only ON public.profiles;
CREATE TRIGGER trg_profiles_guard_names_admin_only
    BEFORE UPDATE OF first_name, last_name ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_names_admin_only();


-- ========================================================================
-- 4. PRIVILEGES
-- ========================================================================

-- Table: anon nothing; authenticated SELECT on every column except
-- secret_sha256 (RLS limits the rows); no direct writes by app users.
-- (Revoking the table privilege also revokes earlier column grants, so a
-- re-run ends in exactly this state.)
REVOKE ALL ON public.patrol_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organisation_id, site_id, label, enrolled_by, enrolled_at, last_used_at,
              last_guard_id, revoked_at, revoked_by, created_at)
    ON public.patrol_devices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patrol_devices TO service_role;

-- Enrol / revoke: signed-in users only (the function bodies decide who).
REVOKE ALL ON FUNCTION public.enrol_patrol_device(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.enrol_patrol_device(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_patrol_device(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_patrol_device(uuid) TO authenticated;

-- Roster / guard sign-in: the server's service-role client only.
REVOKE ALL ON FUNCTION public.device_roster(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.device_roster(text) TO service_role;
REVOKE ALL ON FUNCTION public.device_guard_login(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.device_guard_login(text, uuid) TO service_role;

-- Trigger functions: not callable by app users (same rule as the hardening
-- migration's trigger functions).
REVOKE ALL ON FUNCTION public.patrol_devices_enroller_access_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patrol_devices_enroller_access_changed() TO service_role;
REVOKE ALL ON FUNCTION public.patrol_devices_site_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patrol_devices_site_changed() TO service_role;
REVOKE ALL ON FUNCTION public.profiles_guard_names_admin_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profiles_guard_names_admin_only() TO service_role;
