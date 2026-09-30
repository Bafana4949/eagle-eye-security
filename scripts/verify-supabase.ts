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

async function main() {
  console.log('1. Checking Storage Buckets...');
  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
  if (bucketError) {
    console.error('Bucket error:', bucketError);
  } else {
    console.log('Buckets:', buckets.map(b => ({ name: b.name, public: b.public })));
    const evidenceBucket = buckets.find(b => b.name === 'evidence-media');
    if (!evidenceBucket) {
      console.log('Creating private evidence-media bucket...');
      const { error: createError } = await supabase.storage.createBucket('evidence-media', {
        public: false,
        fileSizeLimit: 10485760,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
      });
      if (createError) console.error('Error creating evidence-media bucket:', createError);
      else console.log('✓ Created private evidence-media bucket');
    } else {
      console.log('✓ evidence-media bucket exists (public: ' + evidenceBucket.public + ')');
    }
  }

  console.log('\n2. Checking existing auth users...');
  const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
  if (usersError) {
    console.error('Error listing users:', usersError);
  } else {
    console.log(`Found ${users.length} auth users`);
    users.forEach(u => console.log(`- ${u.email} (${u.id})`));
  }
}

main().catch(console.error);
