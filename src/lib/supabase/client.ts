import { createBrowserClient } from '@supabase/ssr';

const DEFAULT_SUPABASE_URL = 'https://zuqcmqrfdousdcjybycr.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWNtcXJmZG91c2RjanlieWNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NTQ5ODgsImV4cCI6MjEwNjMzMDk4OH0.O_kAVfI1ume-5eBE4qYzGZ2XSTN43Z1XcLcIQgU6N-4';

function cleanKey(raw: string | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^["'\s\\]+|["'\s\\]+$/g, '').trim();
}

export function createClient() {
  const envUrl = cleanKey(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const envKey = cleanKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  const supabaseUrl = envUrl && envUrl.startsWith('http') ? envUrl : DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = envKey && envKey.length > 20 ? envKey : DEFAULT_SUPABASE_ANON_KEY;

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

export const supabase = typeof window !== 'undefined' ? createClient() : null;
