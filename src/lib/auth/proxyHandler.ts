/**
 * Request-time route protection for the four portals (used by src/proxy.ts).
 *
 * - Refreshes the Supabase session cookies (@supabase/ssr getAll/setAll pattern).
 * - Definitely signed out → /login?next=<path>.
 * - Signed in → roles from user_roles; a role that may not open this portal → its own home.
 * - Network / Supabase errors → NO redirect: the page loads and the client decides (the guard
 *   app must keep working when the server is unreachable).
 * This is navigation UX. Data access is enforced by RLS in Postgres.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createProxySupabaseClient, redirectPreservingCookies, type ProxySupabase } from '@/lib/supabase/server';
import { isDefinitelySignedOut } from './authErrors';
import { areaForPath, isUserRole, resolveRouteAccess } from './routeAccess';

export type ProxyClientFactory = (request: NextRequest) => ProxySupabase;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

function loginUrl(request: NextRequest, reason?: 'disabled' | 'no_profile'): URL {
  const url = new URL('/login', request.url);
  url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (reason) url.searchParams.set('reason', reason);
  return url;
}

export async function handleProxyRequest(
  request: NextRequest,
  createClient: ProxyClientFactory = createProxySupabaseClient
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (!areaForPath(pathname)) return NextResponse.next();

  let client: ProxySupabase;
  try {
    client = createClient(request);
  } catch (error) {
    console.error('[proxy] Supabase client unavailable; not redirecting:', error);
    return noStore(NextResponse.next());
  }
  const { supabase } = client;

  let userId: string | undefined;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error) {
      if (isDefinitelySignedOut(error)) return redirectPreservingCookies(loginUrl(request), client.response());
      return noStore(client.response());
    }
    userId = typeof data?.claims?.sub === 'string' ? data.claims.sub : undefined;
  } catch (error) {
    console.error('[proxy] session check failed; not redirecting:', error);
    return noStore(client.response());
  }
  if (!userId) return redirectPreservingCookies(loginUrl(request), client.response());

  try {
    const [profileResult, rolesResult] = await Promise.all([
      supabase.from('profiles').select('id, is_active').eq('id', userId).maybeSingle(),
      supabase.from('user_roles').select('role').eq('user_id', userId)
    ]);
    if (profileResult.error || rolesResult.error) return noStore(client.response());

    const profile = profileResult.data as { id: string; is_active: boolean } | null;
    if (!profile) return redirectPreservingCookies(loginUrl(request, 'no_profile'), client.response());
    if (profile.is_active !== true) return redirectPreservingCookies(loginUrl(request, 'disabled'), client.response());

    const roles = ((rolesResult.data ?? []) as Array<{ role: unknown }>).map((row) => row.role).filter(isUserRole);
    const access = resolveRouteAccess(pathname, roles);
    if (!access.allowed) {
      return redirectPreservingCookies(new URL(access.redirectTo ?? '/', request.url), client.response());
    }
    return noStore(client.response());
  } catch (error) {
    console.error('[proxy] role lookup failed; not redirecting:', error);
    return noStore(client.response());
  }
}
