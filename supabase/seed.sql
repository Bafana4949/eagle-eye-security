-- ========================================================================
-- EAGLE EYE SECURITY OPERATIONS - DEVELOPMENT & DEMO SEED DATA
-- DO NOT RUN IN PRODUCTION. Run only for local / staging environments.
-- ========================================================================

DO $$
DECLARE
    v_org_id UUID := '11111111-1111-1111-1111-111111111111';
    v_site_id UUID := '22222222-2222-2222-2222-222222222222';
    v_admin_id UUID := '33333333-3333-3333-3333-333333333333';
    v_supervisor_id UUID := '44444444-4444-4444-4444-444444444444';
    v_guard1_id UUID := '55555555-5555-5555-5555-555555555555';
    v_guard2_id UUID := '66666666-6666-6666-6666-666666666666';
BEGIN
    -- 1. Organization
    INSERT INTO organisations (id, name, registration_number, contact_phone, contact_email, branding_logo_url, primary_color)
    VALUES (
        v_org_id,
        'Aiguille Security & Farm Operations',
        '2026/089412/07',
        '+27 82 000 1234',
        'ops@aiguillesecurity.co.za',
        '/logo.png',
        '#0f172a'
    ) ON CONFLICT (id) DO NOTHING;

    -- 2. Farm Site
    INSERT INTO sites (
        id, organisation_id, name, code, address,
        latitude, longitude, default_radius_meters,
        day_shift_start, day_shift_end, night_shift_start, night_shift_end,
        round_interval_minutes, emergency_phone, police_phone, whatsapp_dispatch_number
    ) VALUES (
        v_site_id,
        v_org_id,
        'Dawie Boerdery - Main Site',
        'DW-01',
        'R512 Farm Road, Brits / Hartbeespoort, North West',
        -25.684120, 27.814520, 60,
        '06:00:00', '18:00:00', '18:00:00', '06:00:00',
        60,
        '+27 82 999 4321',
        '10111',
        '+27829994321'
    ) ON CONFLICT (id) DO NOTHING;

    -- 3. Checkpoints (matching Dawie's setup with secure hashes and coordinates)
    INSERT INTO checkpoints (id, site_id, name, description, qr_code_hash, nfc_uid, latitude, longitude, permitted_radius_meters, order_index)
    VALUES 
    (gen_random_uuid(), v_site_id, 'Hoofhek / Main Gate', 'Vehicle access gate and boom control point', 'EE-CP-MAIN-GATE-01', '04:7A:B2:C1', -25.684120, 27.814520, 50, 1),
    (gen_random_uuid(), v_site_id, 'Skaapkraal / Sheep Kraal', 'East livestock pen boundary', 'EE-CP-SHEEP-KRAAL-02', '04:7A:B2:C2', -25.684890, 27.815210, 60, 2),
    (gen_random_uuid(), v_site_id, 'Hoenderhok / Poultry Sheds', 'Northern poultry enclosures', 'EE-CP-POULTRY-SHED-03', '04:7A:B2:C3', -25.683500, 27.814010, 50, 3),
    (gen_random_uuid(), v_site_id, 'Stoor & Werkswinkel / Workshop', 'Equipment depot and diesel storage', 'EE-CP-WORKSHOP-04', '04:7A:B2:C4', -25.684300, 27.813800, 50, 4),
    (gen_random_uuid(), v_site_id, 'Skadunet-tuin / Shade Garden', 'Hydroponics and vegetable tunnel', 'EE-CP-SHADE-GARDEN-05', '04:7A:B2:C5', -25.685100, 27.814900, 50, 5),
    (gen_random_uuid(), v_site_id, 'Grensdraad Noord / North Fence', 'Perimeter fence beacon north', 'EE-CP-NORTH-FENCE-06', '04:7A:B2:C6', -25.682900, 27.814300, 75, 6)
    ON CONFLICT (qr_code_hash) DO NOTHING;

END $$;
