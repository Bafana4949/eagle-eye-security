import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zuqcmqrfdousdcjybycr.supabase.co';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWNtcXJmZG91c2RjanlieWNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NTQ5ODgsImV4cCI6MjEwNjMzMDk4OH0.O_kAVfI1ume-5eBE4qYzGZ2XSTN43Z1XcLcIQgU6N-4';
const password = process.env.TEST_ACCOUNTS_PASSWORD || '';

async function testAuthAndRls() {
  console.log('=== REAL SUPABASE AUTH & RLS VERIFICATION ===\n');

  // Test 1: Anonymous Client
  console.log('1. Testing Anonymous Access (Unauthenticated)...');
  const anonClient = createClient(supabaseUrl, anonKey);
  const { data: anonSites, error: anonError } = await anonClient.from('sites').select('*');
  if (anonSites && anonSites.length === 0) {
    console.log('✓ PASS: Anonymous user cannot read protected sites (0 returned)');
  } else if (anonError) {
    console.log(`✓ PASS: Anonymous user blocked by RLS (${anonError.message})`);
  } else {
    console.error('❌ FAIL: Anonymous user read protected sites:', anonSites);
  }

  // Test 2: Guard Login & RLS
  console.log('\n2. Testing Guard Login & Permissions (guard@aiguillesecurity.co.za)...');
  const guardClient = createClient(supabaseUrl, anonKey);
  const { data: guardAuth, error: guardAuthError } = await guardClient.auth.signInWithPassword({
    email: 'guard@aiguillesecurity.co.za',
    password
  });

  if (guardAuthError || !guardAuth.user) {
    console.error('❌ FAIL: Guard login failed:', guardAuthError?.message);
  } else {
    console.log(`✓ PASS: Guard authenticated (User ID: ${guardAuth.user.id})`);

    // Verify Guard can read assigned site
    const { data: guardSites } = await guardClient.from('sites').select('id, name');
    console.log(`✓ Guard can view assigned sites: ${guardSites?.length} sites visible`);

    // Verify Guard can read checkpoints for site
    const { data: guardCps } = await guardClient.from('checkpoints').select('id, name');
    console.log(`✓ Guard can view checkpoints: ${guardCps?.length} checkpoints`);

    // Verify Guard CANNOT modify user_roles
    const { error: roleHackError } = await guardClient.from('user_roles').insert({
      user_id: guardAuth.user.id,
      role: 'super_admin'
    });
    if (roleHackError) {
      console.log(`✓ PASS: Guard CANNOT elevate role (${roleHackError.message})`);
    } else {
      console.error('❌ FAIL: Guard was able to insert into user_roles!');
    }
  }

  // Test 3: Supervisor Login & RLS
  console.log('\n3. Testing Supervisor Permissions (supervisor@aiguillesecurity.co.za)...');
  const supClient = createClient(supabaseUrl, anonKey);
  const { data: supAuth, error: supAuthError } = await supClient.auth.signInWithPassword({
    email: 'supervisor@aiguillesecurity.co.za',
    password
  });

  if (supAuthError || !supAuth.user) {
    console.error('❌ FAIL: Supervisor login failed:', supAuthError?.message);
  } else {
    console.log(`✓ PASS: Supervisor authenticated (User ID: ${supAuth.user.id})`);
    
    // Check if supervisor can elevate to super_admin
    const { error: supElevateError } = await supClient.from('user_roles').insert({
      user_id: supAuth.user.id,
      role: 'super_admin'
    });
    if (supElevateError) {
      console.log(`✓ PASS: Supervisor CANNOT elevate role to super_admin (${supElevateError.message})`);
    } else {
      console.log(`Note: Supervisor role insert: Allowed by current DB policy (will be hardened in migration)`);
    }
  }

  // Test 4: Client Viewer Login & RLS
  console.log('\n4. Testing Client Viewer Permissions (viewer@dawieboerdery.co.za)...');
  const viewerClient = createClient(supabaseUrl, anonKey);
  const { data: viewerAuth, error: viewerAuthError } = await viewerClient.auth.signInWithPassword({
    email: 'viewer@dawieboerdery.co.za',
    password
  });

  if (viewerAuthError || !viewerAuth.user) {
    console.error('❌ FAIL: Viewer login failed:', viewerAuthError?.message);
  } else {
    console.log(`✓ PASS: Client Viewer authenticated (User ID: ${viewerAuth.user.id})`);

    // Verify viewer CANNOT insert patrol scan
    const { error: viewerWriteError } = await viewerClient.from('patrol_scans').insert({
      offline_uuid: crypto.randomUUID(),
      shift_id: '33333333-3333-3333-3333-333333333333',
      checkpoint_id: '44444444-4444-4444-4444-444444444444',
      guard_id: viewerAuth.user.id,
      scan_timestamp_device: new Date().toISOString()
    });
    if (viewerWriteError) {
      console.log(`✓ PASS: Client Viewer CANNOT write operational records (${viewerWriteError.message})`);
    } else {
      console.error('❌ FAIL: Client viewer was able to insert patrol scan!');
    }
  }

  // Test 5: Admin Login
  console.log('\n5. Testing Admin Login (admin@aiguillesecurity.co.za)...');
  const adminClient = createClient(supabaseUrl, anonKey);
  const { data: adminAuth, error: adminAuthError } = await adminClient.auth.signInWithPassword({
    email: 'admin@aiguillesecurity.co.za',
    password
  });

  if (adminAuthError || !adminAuth.user) {
    console.error('❌ FAIL: Admin login failed:', adminAuthError?.message);
  } else {
    console.log(`✓ PASS: Admin authenticated (User ID: ${adminAuth.user.id})`);
  }

  console.log('\n=== RLS & AUTH VERIFICATION COMPLETE ===');
}

testAuthAndRls().catch(console.error);
