import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTimeoutFetch } from './timeouts';

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/**
 * Public project settings. Read with literal `process.env.NEXT_PUBLIC_*` accesses so Next.js
 * inlines them into the browser bundle. There is no placeholder fallback: a missing value is a
 * deployment error and must be visible, not silently pointed at a fake project.
 */
export function getSupabasePublicEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const missing = [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY'].filter(Boolean);
  if (!url || !anonKey) {
    throw new SupabaseConfigError(
      `Supabase is not configured: set ${missing.join(' and ')} (see .env.example) and rebuild the app.`
    );
  }
  return { url, anonKey };
}

let browserClient: SupabaseClient | null = null;

/**
 * The app's Supabase client. In the browser this is ONE shared instance (session in cookies,
 * so the proxy can read it; auto-refresh on). Call it from effects and event handlers, not during
 * render. On the server it returns a fresh client without a session (anonymous: RLS returns
 * nothing) — server code that needs the user's session uses src/lib/supabase/server.ts.
 *
 * Every request has a time limit (./timeouts.ts): on a black-holed rural connection a call fails
 * after its deadline instead of hanging forever, so sync passes and sign-in checks always finish.
 */
export function createClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const { url, anonKey } = getSupabasePublicEnv();
  if (typeof window === 'undefined') {
    return createBrowserClient(url, anonKey, { isSingleton: false, global: { fetch: createTimeoutFetch() } });
  }
  browserClient = createBrowserClient(url, anonKey, { global: { fetch: createTimeoutFetch() } });
  return browserClient;
}
