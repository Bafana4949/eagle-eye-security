import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client for trusted server code only (e.g. the admin user-provisioning route
 * handler, which must verify the caller is an org admin BEFORE using it). It bypasses RLS.
 *
 * The key is read from SUPABASE_SERVICE_ROLE_KEY — never a NEXT_PUBLIC_* variable — and the
 * `server-only` import makes any accidental client-side import fail the build.
 */
export function createServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error('Server misconfigured: NEXT_PUBLIC_SUPABASE_URL is not set.');
  }
  if (!serviceRoleKey) {
    throw new Error('Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set (server environment only).');
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}
