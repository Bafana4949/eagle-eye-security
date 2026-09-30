-- ========================================================================
-- EAGLE EYE SECURITY OPERATIONS - DEVELOPMENT & STAGING SEED DATA
-- DO NOT RUN IN PRODUCTION. Run only for local / staging environments
-- (e.g. `supabase db reset` runs it after the migrations). Re-runnable.
--
-- Creates: one organisation, one farm site and Dawie's six default
-- checkpoints (Hoofhek ... Grensdraad noord, in his order).
--
-- Deliberately does NOT create:
--   * NFC tag serials. A serial is read from the physical tag with the admin
--     "Enrol NFC tag" flow; it is never typed in or invented.
--   * GPS coordinates. Dawie's checkpoints have none; capture each one on
--     site from the admin screen. Until then scans report 'no_reference'.
--   * Contact / WhatsApp numbers, so nothing is ever sent to a stranger.
--   * Users, profiles, roles or site assignments, and no passwords. Create
--     real accounts in Supabase Auth (Dashboard > Authentication > Add user
--     or Invite), then give each one a profile, role and site, e.g.:
--       INSERT INTO profiles (id, organisation_id, first_name, last_name)
--         VALUES ('<auth user id>', '11111111-1111-1111-1111-111111111111', 'First', 'Last');
--       INSERT INTO user_roles (user_id, role) VALUES ('<auth user id>', 'guard');
--       INSERT INTO site_assignments (site_id, user_id)
--         VALUES ('22222222-2222-2222-2222-222222222222', '<auth user id>');
--
-- QR tokens are random per run ('EE-CP-' + 32 upper-case hex characters), so
-- print the QR cards from the admin screen of THIS environment. Dawie's
-- original printed cards (payload PLAAS-CP:CP1 .. CP6) map to legacy_code
-- CP1 .. CP6.
-- ========================================================================

DO $$
DECLARE
    v_org_id UUID := '11111111-1111-1111-1111-111111111111';
    v_site_id UUID := '22222222-2222-2222-2222-222222222222';
BEGIN
    -- 1. Organisation
    INSERT INTO organisations (id, name, branding_logo_url, primary_color)
    VALUES (v_org_id, 'Aiguille Security & Farm Operations', '/logo.png', '#0f172a')
    ON CONFLICT (id) DO NOTHING;

    -- 2. Farm site (shift times and round interval as in Dawie's defaults).
    --    allow_legacy_qr: his printed PLAAS-CP cards still scan here (never
    --    counted as verified); switch it off once EE-CP cards are posted.
    INSERT INTO sites (
        id, organisation_id, name, code,
        default_radius_meters,
        day_shift_start, day_shift_end, night_shift_start, night_shift_end,
        round_interval_minutes, police_phone, allow_legacy_qr
    ) VALUES (
        v_site_id, v_org_id, 'Dawie Boerdery - Main Site', 'DW-01',
        50,
        '06:00:00', '18:00:00', '18:00:00', '06:00:00',
        60, '10111', true
    ) ON CONFLICT (id) DO NOTHING;

    -- 3. Checkpoints: no NFC serials, no invented coordinates, random tokens.
    INSERT INTO checkpoints (site_id, name, description, qr_code_hash, legacy_code,
                             permitted_radius_meters, order_index)
    SELECT v_site_id, cp.name, cp.description,
           'EE-CP-' || upper(replace(gen_random_uuid()::text, '-', '')),
           cp.legacy_code, 50, cp.order_index
    FROM (VALUES
        ('Hoofhek / Main Gate', 'Vehicle access gate', 'CP1', 1),
        ('Skaapkraal / Sheep Kraal', 'Livestock pen', 'CP2', 2),
        ('Hoenderhok / Poultry Sheds', 'Poultry enclosures', 'CP3', 3),
        ('Stoor en werkswinkel / Store and Workshop', 'Equipment store and workshop', 'CP4', 4),
        ('Skadunet-tuin / Shade-net Garden', 'Shade-net garden', 'CP5', 5),
        ('Grensdraad noord / North Fence', 'Northern boundary fence', 'CP6', 6)
    ) AS cp(name, description, legacy_code, order_index)
    ON CONFLICT (site_id, legacy_code) WHERE legacy_code IS NOT NULL DO NOTHING;
END $$;
