/**
 * Staff account provisioning for POST /api/admin/users (framework-free so it can be tested).
 *
 * Order of trust:
 * 1. The CALLER is verified with their own session (anon key + cookies, RLS applies): signed in,
 *    own profile active, and an admin / super_admin role read from user_roles.
 * 2. The request body is validated (zod). The organisation always comes from the caller's
 *    profile, never from the request. Site ids must be sites the caller can see in that org.
 * 3. Only the Supabase Auth account is created with the service-role client
 *    (auth.admin.createUser, email_confirm: true) — Auth has no other API for it.
 * 4. Profile, role and site assignments are inserted WITH THE CALLER'S SESSION, so Row Level
 *    Security checks them again (same organisation, super_admin only by a super_admin, never the
 *    caller's own roles) and the audit trail records the admin as the actor.
 * 5. On any failure after step 3 the auth account is deleted again (its profile, role and
 *    assignment rows cascade). The response says whether that rollback succeeded.
 * Nothing secret (password, keys, tokens) is ever returned.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createStaffSchema,
  type CreateStaffErrorCode,
  type CreateStaffInput,
  type CreateStaffResponse
} from '@/components/admin/staffSchema';

export type CallerClient = Pick<SupabaseClient, 'auth' | 'from'>;
export type ServiceClient = Pick<SupabaseClient, 'auth'>;

export interface ProvisionDeps {
  /** Supabase client acting as the caller (createRouteHandlerSupabaseClient). */
  caller: CallerClient;
  /** Lazily creates the service-role client (only after the caller is verified). */
  getServiceClient: () => ServiceClient;
  /** Domain for guard short logins (NEXT_PUBLIC_GUARD_LOGIN_DOMAIN). */
  guardLoginDomain: string;
}

export interface ProvisionOutcome {
  status: number;
  body: CreateStaffResponse;
}

function failure(status: number, error: CreateStaffErrorCode, extra: Partial<Extract<CreateStaffResponse, { ok: false }>> = {}): ProvisionOutcome {
  return { status, body: { ok: false, error, ...extra } };
}

/**
 * Cross-site request check for the (cookie-authenticated) POST. Session cookies are SameSite=Lax,
 * which already keeps them off cross-site POSTs; this is a second, explicit check.
 * - Sec-Fetch-Site (sent by current browsers) decides when present: only 'same-origin' passes
 *   ('none' = typed / bookmarked navigation never POSTs JSON here, so it is refused too).
 * - Otherwise an Origin header must name this host: the Host header, X-Forwarded-Host (set by the
 *   hosting proxy; a cross-site page cannot set it without a CORS preflight, which this route never
 *   allows) or the URL the framework resolved. Comparing with the resolved URL alone refused real
 *   admins whenever the framework normalised the host (e.g. 127.0.0.1 vs localhost).
 * - No Origin and no Sec-Fetch-Site (non-browser client): allowed; the session check still applies.
 */
export function isCrossOriginRequest(headers: Pick<Headers, 'get'>, resolvedHost: string): boolean {
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite.trim().toLowerCase() !== 'same-origin';
  const origin = headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const allowed = new Set<string>();
  const add = (value: string | null) => {
    for (const part of (value ?? '').split(',')) {
      const host = part.trim().toLowerCase();
      if (host) allowed.add(host);
    }
  };
  add(headers.get('host'));
  add(headers.get('x-forwarded-host'));
  add(resolvedHost);
  return !allowed.has(originHost);
}

interface VerifiedCaller {
  userId: string;
  organisationId: string;
  isSuperAdmin: boolean;
}

/** Verifies the caller with their own JWT. Returns an outcome to send back when refused. */
export async function verifyAdminCaller(caller: CallerClient): Promise<VerifiedCaller | ProvisionOutcome> {
  const { data: userData, error: userError } = await caller.auth.getUser();
  const userId = userData?.user?.id;
  if (userError || !userId) return failure(401, 'not_signed_in');

  const profile = await caller
    .from('profiles')
    .select('id, organisation_id, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (profile.error) return failure(502, 'auth_service_error');
  const row = profile.data as { id: string; organisation_id: string; is_active: boolean } | null;
  if (!row) return failure(403, 'forbidden');
  if (row.is_active !== true) return failure(403, 'account_disabled');

  const roles = await caller.from('user_roles').select('role').eq('user_id', userId);
  if (roles.error) return failure(502, 'auth_service_error');
  const roleNames = ((roles.data ?? []) as Array<{ role: string }>).map((r) => r.role);
  const isSuperAdmin = roleNames.includes('super_admin');
  if (!isSuperAdmin && !roleNames.includes('admin')) return failure(403, 'forbidden');

  return { userId, organisationId: row.organisation_id, isSuperAdmin };
}

function isOutcome(value: VerifiedCaller | ProvisionOutcome): value is ProvisionOutcome {
  return 'status' in value;
}

function loginEmail(input: CreateStaffInput, domain: string): { email: string; login: string } {
  if (input.login.kind === 'email') return { email: input.login.email, login: input.login.email };
  return { email: `${input.login.username}@${domain.trim().toLowerCase()}`, login: input.login.username };
}

interface AuthAdminErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

function classifyCreateUserError(error: AuthAdminErrorLike): ProvisionOutcome {
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists/i.test(message)) {
    return failure(409, 'login_taken');
  }
  if (code === 'weak_password' || /password/i.test(message)) return failure(400, 'weak_password');
  return failure(502, 'auth_service_error');
}

async function rollback(service: ServiceClient, userId: string): Promise<boolean> {
  try {
    const { error } = await service.auth.admin.deleteUser(userId);
    return !error;
  } catch {
    return false;
  }
}

/** Handles one "create staff account" request whose JSON body is `body`. */
export async function provisionStaffAccount(body: unknown, deps: ProvisionDeps): Promise<ProvisionOutcome> {
  const verified = await verifyAdminCaller(deps.caller);
  if (isOutcome(verified)) return verified;

  const parsed = createStaffSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    return failure(400, 'invalid_input', { fields });
  }
  const input = parsed.data;
  if (input.role === 'super_admin' && !verified.isSuperAdmin) return failure(403, 'super_admin_required');

  if (input.siteIds.length > 0) {
    const sites = await deps.caller.from('sites').select('id, organisation_id').in('id', input.siteIds);
    if (sites.error) return failure(502, 'auth_service_error');
    const visible = ((sites.data ?? []) as Array<{ id: string; organisation_id: string }>).filter(
      (site) => site.organisation_id === verified.organisationId
    );
    const visibleIds = new Set(visible.map((site) => site.id.toLowerCase()));
    if (input.siteIds.some((id) => !visibleIds.has(id))) return failure(400, 'invalid_sites');
  }

  let service: ServiceClient;
  try {
    service = deps.getServiceClient();
  } catch {
    return failure(500, 'server_misconfigured');
  }

  const { email, login } = loginEmail(input, deps.guardLoginDomain);
  let newUserId: string;
  try {
    const created = await service.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { first_name: input.firstName, last_name: input.lastName }
    });
    if (created.error || !created.data?.user?.id) {
      return created.error ? classifyCreateUserError(created.error as AuthAdminErrorLike) : failure(502, 'auth_service_error');
    }
    newUserId = created.data.user.id;
  } catch {
    return failure(502, 'auth_service_error');
  }

  const abort = async (stage: 'profile' | 'role' | 'sites'): Promise<ProvisionOutcome> =>
    failure(500, 'provisioning_failed', { stage, rolledBack: await rollback(service, newUserId) });

  try {
    const profile = await deps.caller
      .from('profiles')
      .insert({
        id: newUserId,
        organisation_id: verified.organisationId,
        first_name: input.firstName,
        last_name: input.lastName,
        employee_number: input.employeeNumber,
        phone_number: input.phoneNumber,
        preferred_language: input.preferredLanguage,
        is_active: true
      })
      .select('id')
      .single();
    if (profile.error || (profile.data as { id?: string } | null)?.id !== newUserId) return abort('profile');

    const role = await deps.caller
      .from('user_roles')
      .insert({ user_id: newUserId, role: input.role })
      .select('user_id, role')
      .single();
    if (role.error || (role.data as { role?: string } | null)?.role !== input.role) return abort('role');

    if (input.siteIds.length > 0) {
      const assignments = await deps.caller
        .from('site_assignments')
        .insert(input.siteIds.map((siteId) => ({ user_id: newUserId, site_id: siteId })))
        .select('site_id');
      const stored = ((assignments.data ?? []) as Array<{ site_id: string }>).map((a) => a.site_id.toLowerCase());
      if (assignments.error || input.siteIds.some((id) => !stored.includes(id))) return abort('sites');
    }
  } catch {
    return abort('profile');
  }

  return {
    status: 201,
    body: { ok: true, user: { id: newUserId, email, login, role: input.role, siteIds: input.siteIds } }
  };
}
