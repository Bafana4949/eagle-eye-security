import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zuqcmqrfdousdcjybycr.supabase.co';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWNtcXJmZG91c2RjanlieWNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NTQ5ODgsImV4cCI6MjEwNjMzMDk4OH0.O_kAVfI1ume-5eBE4qYzGZ2XSTN43Z1XcLcIQgU6N-4';
const password = process.env.TEST_ACCOUNTS_PASSWORD || '';

describe('Live Supabase Auth & RLS Policy Enforcement', () => {
  test('Anonymous client cannot read protected operational sites', async () => {
    const anon = createClient(supabaseUrl, anonKey);
    const { data } = await anon.from('sites').select('*');
    assert.strictEqual((data || []).length, 0, 'Anonymous users must receive empty result due to RLS');
  });

  test('Guard can sign in and read assigned site checkpoints', async () => {
    const client = createClient(supabaseUrl, anonKey);
    const { data: auth, error } = await client.auth.signInWithPassword({
      email: 'guard@aiguillesecurity.co.za',
      password
    });

    assert.strictEqual(error, null, 'Guard authentication must succeed');
    assert.ok(auth.user?.id, 'Guard must have user ID');

    const { data: checkpoints, error: cpError } = await client.from('checkpoints').select('id, name');
    assert.strictEqual(cpError, null, 'Guard must be able to read checkpoints');
    assert.ok((checkpoints || []).length > 0, 'Checkpoints must be returned for assigned site');
  });

  test('Guard CANNOT elevate own role in user_roles', async () => {
    const client = createClient(supabaseUrl, anonKey);
    const { data: auth } = await client.auth.signInWithPassword({
      email: 'guard@aiguillesecurity.co.za',
      password
    });

    if (auth.user) {
      const { error } = await client.from('user_roles').insert({
        user_id: auth.user.id,
        role: 'super_admin'
      });
      assert.ok(error !== null, 'Guard role elevation must be blocked by RLS');
    }
  });

  test('Client viewer can authenticate and has strictly read-only access', async () => {
    const client = createClient(supabaseUrl, anonKey);
    const { data: auth, error } = await client.auth.signInWithPassword({
      email: 'viewer@dawieboerdery.co.za',
      password
    });

    assert.strictEqual(error, null, 'Client viewer authentication must succeed');
    assert.ok(auth.user?.id, 'Viewer must have valid user ID');

    // Attempt insert into patrol_scans
    const { error: writeError } = await client.from('patrol_scans').insert({
      offline_uuid: crypto.randomUUID(),
      shift_id: '00000000-0000-0000-0000-000000000000',
      checkpoint_id: '00000000-0000-0000-0000-000000000000',
      guard_id: auth.user!.id,
      scan_timestamp_device: new Date().toISOString()
    });

    assert.ok(writeError !== null, 'Client viewer writing operational records must be prohibited');
  });

  test('Supervisor can authenticate and view operational incidents', async () => {
    const client = createClient(supabaseUrl, anonKey);
    const { data: auth, error } = await client.auth.signInWithPassword({
      email: 'supervisor@aiguillesecurity.co.za',
      password
    });

    assert.strictEqual(error, null, 'Supervisor authentication must succeed');
    assert.ok(auth.user?.id, 'Supervisor must have valid user ID');

    const { error: incError } = await client.from('incidents').select('*');
    assert.strictEqual(incError, null, 'Supervisor can view incidents in their organisation');
  });

  test('Admin can authenticate and access administration data', async () => {
    const client = createClient(supabaseUrl, anonKey);
    const { data: auth, error } = await client.auth.signInWithPassword({
      email: 'admin@aiguillesecurity.co.za',
      password
    });

    assert.strictEqual(error, null, 'Admin authentication must succeed');
    assert.ok(auth.user?.id, 'Admin must have valid user ID');

    const { data: sites, error: sitesError } = await client.from('sites').select('*');
    assert.strictEqual(sitesError, null, 'Admin can view sites');
    assert.ok((sites || []).length > 0, 'Admin can view organisation sites');
  });
});
