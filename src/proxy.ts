import type { NextRequest } from 'next/server';
import { handleProxyRequest } from '@/lib/auth/proxyHandler';

/**
 * Next.js 16 request interception (formerly middleware). Protects /admin, /supervisor, /guard
 * and /viewer: refreshes the Supabase session, sends signed-out users to /login and users
 * without the portal's role to their own home. See src/lib/auth/proxyHandler.ts.
 */
export async function proxy(request: NextRequest) {
  return handleProxyRequest(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, API routes, the service worker, PWA files and static assets.
    '/((?!_next/static|_next/image|_next/data|api/|sw\\.js|manifest\\.json|offline\\.html|icons/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|js|css|map|woff2?|json)$).*)'
  ]
};
