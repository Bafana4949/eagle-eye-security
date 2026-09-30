import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkTables() {
  const tables = [
    'organisations',
    'sites',
    'profiles',
    'user_roles',
    'checkpoints',
    'shifts',
    'patrol_scans',
    'incidents',
    'gate_entries',
    'panic_alerts'
  ];

  console.log('Checking tables on live Supabase...');
  for (const table of tables) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`❌ Table ${table}: Error ${error.message} (${error.code})`);
    } else {
      console.log(`✓ Table ${table}: Exists (Row count: ${count})`);
    }
  }
}

checkTables();
