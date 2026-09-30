import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function seed() {
  console.log('Seeding initial organization and site into live Supabase...');

  const orgId = '11111111-1111-1111-1111-111111111111';
  const siteId = '22222222-2222-2222-2222-222222222222';

  // 1. Organization
  const { error: orgError } = await supabase.from('organisations').upsert({
    id: orgId,
    name: 'Aiguille Security & Farm Operations',
    registration_number: '2026/089412/07',
    contact_phone: '+27 82 000 1234',
    contact_email: 'ops@aiguillesecurity.co.za',
    branding_logo_url: '/logo.png',
    primary_color: '#0f172a'
  });
  if (orgError) console.error('Org error:', orgError);
  else console.log('✓ Organisation seeded');

  // 2. Site
  const { error: siteError } = await supabase.from('sites').upsert({
    id: siteId,
    organisation_id: orgId,
    name: 'Dawie Boerdery - Main Site',
    code: 'DW-01',
    address: 'R512 Farm Road, Brits / Hartbeespoort, North West',
    latitude: -25.684120,
    longitude: 27.814520,
    default_radius_meters: 60,
    day_shift_start: '06:00:00',
    day_shift_end: '18:00:00',
    night_shift_start: '18:00:00',
    night_shift_end: '06:00:00',
    round_interval_minutes: 60,
    emergency_phone: '+27 82 999 4321',
    police_phone: '10111',
    whatsapp_dispatch_number: '+27829994321'
  });
  if (siteError) console.error('Site error:', siteError);
  else console.log('✓ Site seeded');

  // 3. Checkpoints
  const checkpoints = [
    { site_id: siteId, name: 'Hoofhek / Main Gate', description: 'Vehicle access gate and boom control point', qr_code_hash: 'EE-CP-MAIN-GATE-01', nfc_uid: '04:7A:B2:C1', latitude: -25.684120, longitude: 27.814520, permitted_radius_meters: 50, order_index: 1 },
    { site_id: siteId, name: 'Skaapkraal / Sheep Kraal', description: 'East livestock pen boundary', qr_code_hash: 'EE-CP-SHEEP-KRAAL-02', nfc_uid: '04:7A:B2:C2', latitude: -25.684890, longitude: 27.815210, permitted_radius_meters: 60, order_index: 2 },
    { site_id: siteId, name: 'Hoenderhok / Poultry Sheds', description: 'Northern poultry enclosures', qr_code_hash: 'EE-CP-POULTRY-SHED-03', nfc_uid: '04:7A:B2:C3', latitude: -25.683500, longitude: 27.814010, permitted_radius_meters: 50, order_index: 3 },
    { site_id: siteId, name: 'Stoor & Werkswinkel / Workshop', description: 'Equipment depot and diesel storage', qr_code_hash: 'EE-CP-WORKSHOP-04', nfc_uid: '04:7A:B2:C4', latitude: -25.684300, longitude: 27.813800, permitted_radius_meters: 50, order_index: 4 },
    { site_id: siteId, name: 'Skadunet-tuin / Shade Garden', description: 'Hydroponics and vegetable tunnel', qr_code_hash: 'EE-CP-SHADE-GARDEN-05', nfc_uid: '04:7A:B2:C5', latitude: -25.685100, longitude: 27.814900, permitted_radius_meters: 50, order_index: 5 },
    { site_id: siteId, name: 'Grensdraad Noord / North Fence', description: 'Perimeter fence beacon north', qr_code_hash: 'EE-CP-NORTH-FENCE-06', nfc_uid: '04:7A:B2:C6', latitude: -25.682900, longitude: 27.814300, permitted_radius_meters: 75, order_index: 6 }
  ];

  for (const cp of checkpoints) {
    const { error: cpError } = await supabase.from('checkpoints').upsert(cp, { onConflict: 'qr_code_hash' });
    if (cpError) console.error(`Checkpoint error (${cp.name}):`, cpError);
  }
  console.log(`✓ ${checkpoints.length} Checkpoints seeded`);
  console.log('Done seeding live Supabase database!');
}

seed();
