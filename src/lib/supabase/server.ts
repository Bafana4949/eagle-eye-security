import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabasePublicEnv } from './client';
import { createTimeoutFetch } from './timeouts';

/**
 * Limit for each Supabase call made while a page request waits in the proxy. On timeout the
 * proxy lets the request through (the client re-checks), instead of stalling navigation.
 */
export const PROXY_REQUEST_TIMEOUT_MS = 8_000;

export interface ProxySupabase {
  supabase: SupabaseClient;
  /**
   * The pass-through response carrying any refreshed session cookies. Read it AFTER the auth
   * call: a token refresh replaces it (the @supabase/ssr getAll/setAll contract).
   */
  response: () => NextResponse;
}

/**
 * Supabase client bound to one proxy request (anon key + the user's session cookies).
 * Create one per request; never share it between requests.
 */
export function createProxySupabaseClient(request: NextRequest): ProxySupabase {
  const { url, anonKey } = getSupabasePublicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    global: { fetch: createTimeoutFetch(undefined, () => PROXY_REQUEST_TIMEOUT_MS) },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // Make refreshed tokens visible to the rendering that follows, and send them to the browser.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      }
    }
  });

  return { supabase, response: () => response };
}

/** Redirect that keeps any session cookies the auth call set (otherwise a refresh would be lost). */
export function redirectPreservingCookies(target: URL, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(target);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  redirect.headers.set('Cache-Control', 'private, no-store');
  return redirect;
}
