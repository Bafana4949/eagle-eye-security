/**
 * Which roles may open which portal. Pure functions shared by src/proxy.ts (server redirect)
 * and <RequireRole> (client). This is navigation UX only — data access is enforced by RLS.
 */
import type { UserRole } from '@/types/models';

export type PortalArea = 'admin' | 'supervisor' | 'guard' | 'viewer';

export const AREA_ROLES: Readonly<Record<PortalArea, readonly UserRole[]>> = {
  admin: ['admin', 'super_admin'],
  supervisor: ['supervisor', 'admin', 'super_admin'],
  guard: ['guard'],
  viewer: ['client_viewer', 'admin', 'super_admin']
};

const AREA_PREFIXES: ReadonlyArray<[PortalArea, string]> = [
  ['admin', '/admin'],
  ['supervisor', '/supervisor'],
  ['guard', '/guard'],
  ['viewer', '/viewer']
];

const ALL_ROLES: readonly UserRole[] = ['super_admin', 'admin', 'supervisor', 'guard', 'client_viewer'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

/** Protected portal for a pathname ('/admin', '/admin/…'), or null for public routes ('/', '/login', '/administrator'). */
export function areaForPath(pathname: string): PortalArea | null {
  const path = (pathname || '/').toLowerCase();
  for (const [area, prefix] of AREA_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return area;
  }
  return null;
}

/** Landing page for a set of roles: admin > supervisor > guard > client viewer; '/' when none. */
export function homeForRoles(roles: readonly UserRole[]): string {
  if (roles.includes('super_admin') || roles.includes('admin')) return '/admin';
  if (roles.includes('supervisor')) return '/supervisor';
  if (roles.includes('guard')) return '/guard';
  if (roles.includes('client_viewer')) return '/viewer';
  return '/';
}

export function hasAnyRole(roles: readonly UserRole[], allowed: readonly UserRole[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

export interface RouteAccess {
  allowed: boolean;
  /** Where to send a signed-in user who may not open this path (never the same area, so no loops). */
  redirectTo?: string;
}

/** Decides whether a signed-in user with `roles` may open `pathname`. */
export function resolveRouteAccess(pathname: string, roles: readonly UserRole[]): RouteAccess {
  const area = areaForPath(pathname);
  if (!area) return { allowed: true };
  if (hasAnyRole(roles, AREA_ROLES[area])) return { allowed: true };
  return { allowed: false, redirectTo: homeForRoles(roles) };
}

/** ASCII control characters and any whitespace: the URL parser silently drops tab/CR/LF. */
const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/;
/** Fixed stand-in origin used only to resolve and compare paths. */
const RESOLVE_BASE = 'https://eagle-eye.invalid';

/**
 * Sanitises a post-login `next` parameter: only same-origin absolute paths are honoured.
 * Rejects protocol-relative '//host', backslashes and control/whitespace characters
 * ('/\t/evil.example' would otherwise resolve to https://evil.example), then resolves the path
 * and requires it to stay on this origin. Returns the normalised path + query + hash.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (
    typeof next !== 'string' ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.includes('\\') ||
    CONTROL_OR_WHITESPACE.test(next)
  ) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(next, RESOLVE_BASE);
  } catch {
    return fallback;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalise into '//host' ('/.//evil.example'), which is protocol-relative again.
  if (url.origin !== RESOLVE_BASE || !path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}
