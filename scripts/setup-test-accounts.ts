import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zuqcmqrfdousdcjybycr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ID = '22222222-2222-2222-2222-222222222222';

// Test password provided via environment variable
const DEFAULT_PASSWORD = process.env.TEST_ACCOUNTS_PASSWORD || '';

interface AccountConfig {
  email: string;
  role: 'admin' | 'supervisor' | 'guard' | 'client_viewer';
  firstName: string;
  lastName: string;
  employeeNo: string;
  phone: string;
}

const ACCOUNTS: AccountConfig[] = [
  {
    email: 'admin@aiguillesecurity.co.za',
    role: 'admin',
    firstName: 'Dawie',
    lastName: 'Snyman',
    employeeNo: 'ADM-01',
    phone: '+27829994321'
  },
  {
    email: 'supervisor@aiguillesecurity.co.za',
    role: 'supervisor',
    firstName: 'Johan',
    lastName: 'Coetzee',
    employeeNo: 'SUP-01',
    phone: '+27821234567'
  },
  {
    email: 'guard@aiguillesecurity.co.za',
    role: 'guard',
    firstName: 'Sipho',
    lastName: 'Khoza',
    employeeNo: 'G-101',
    phone: '+27821112222'
  },
  {
    email: 'viewer@dawieboerdery.co.za',
    role: 'client_viewer',
    firstName: 'Client',
    lastName: 'Viewer',
    employeeNo: 'CL-01',
    phone: '+27823334444'
  }
];

async function setupAccounts() {
  console.log('--- Setting Up Live Supabase Test Accounts ---');

  for (const acc of ACCOUNTS) {
    console.log(`\nProcessing account: ${acc.email} (${acc.role})...`);

    // 1. Check if user already exists in auth.users
    const { data: { users } } = await supabase.auth.admin.listUsers();
    let authUser = users?.find(u => u.email === acc.email);

    if (!authUser) {
      console.log(`Creating auth user ${acc.email}...`);
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email: acc.email,
        password: DEFAULT_PASSWORD,
        email_confirm: true,
        user_metadata: {
          first_name: acc.firstName,
          last_name: acc.lastName,
          role: acc.role
        }
      });

      if (createError) {
        console.error(`Failed to create auth user ${acc.email}:`, createError.message);
        continue;
      }
      authUser = created.user;
      console.log(`✓ Created auth user (ID: ${authUser.id})`);
    } else {
      console.log(`Auth user already exists (ID: ${authUser.id}). Updating password & metadata...`);
      await supabase.auth.admin.updateUserById(authUser.id, {
        password: DEFAULT_PASSWORD,
        email_confirm: true,
        user_metadata: {
          first_name: acc.firstName,
          last_name: acc.lastName,
          role: acc.role
        }
      });
    }

    if (!authUser) continue;

    // 2. Upsert profile
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: authUser.id,
      organisation_id: ORG_ID,
      first_name: acc.firstName,
      last_name: acc.lastName,
      employee_number: acc.employeeNo,
      phone_number: acc.phone,
      is_active: true
    });

    if (profileError) {
      console.error(`Profile error for ${acc.email}:`, profileError.message);
    } else {
      console.log(`✓ Profile synced in profiles table`);
    }

    // 3. Upsert user_role
    // First remove any existing role for this user
    await supabase.from('user_roles').delete().eq('user_id', authUser.id);
    const { error: roleError } = await supabase.from('user_roles').insert({
      user_id: authUser.id,
      role: acc.role
    });

    if (roleError) {
      console.error(`Role error for ${acc.email}:`, roleError.message);
    } else {
      console.log(`✓ Role assigned: ${acc.role}`);
    }

    // 4. Assign site for guard, supervisor, and viewer
    await supabase.from('site_assignments').delete().eq('user_id', authUser.id).eq('site_id', SITE_ID);
    const { error: assignError } = await supabase.from('site_assignments').insert({
      user_id: authUser.id,
      site_id: SITE_ID
    });

    if (assignError) {
      console.error(`Site assignment error:`, assignError.message);
    } else {
      console.log(`✓ Assigned to site: Dawie Boerdery (${SITE_ID})`);
    }
  }

  console.log('\n✓ All 4 accounts configured successfully on live Supabase!');
}

setupAccounts().catch(console.error);
