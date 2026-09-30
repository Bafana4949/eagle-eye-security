import 'server-only';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { getSupabasePublicEnv } from './client';

/**
 * Supabase client acting AS THE CALLER (anon key + the caller's session cookies) for Route
 * Handlers and Server Functions. Privileged handlers (e.g. admin user provisioning) must use it
 * to verify who is calling — `auth.getUser()` and the caller's roles — BEFORE touching the
 * service-role client from ./admin.ts.
 */
export async function createRouteHandlerSupabaseClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getSupabasePublicEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component render, where cookies are read-only; the proxy refreshes them.
        }
      }
    }
  });
}
