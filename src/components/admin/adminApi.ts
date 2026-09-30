/**
 * Browser side of POST /api/admin/users. The session cookie authenticates the admin; the server
 * re-checks everything. A missing / non-JSON answer is reported as such, never as success.
 */
import type { CreateStaffErrorCode, CreateStaffRequest, CreateStaffResponse } from './staffSchema';

export type CreateStaffClientResult =
  | Extract<CreateStaffResponse, { ok: true }>
  | Extract<CreateStaffResponse, { ok: false }>
  | { ok: false; error: 'network' | 'bad_response'; status?: number };

const REQUEST_TIMEOUT_MS = 30_000;

const KNOWN_ERRORS: ReadonlySet<CreateStaffErrorCode> = new Set<CreateStaffErrorCode>([
  'invalid_input',
  'invalid_json',
  'unsupported_media_type',
  'payload_too_large',
  'cross_origin',
  'not_signed_in',
  'account_disabled',
  'forbidden',
  'super_admin_required',
  'invalid_sites',
  'login_taken',
  'weak_password',
  'server_misconfigured',
  'auth_service_error',
  'provisioning_failed'
]);

export async function createStaffAccount(request: CreateStaffRequest): Promise<CreateStaffClientResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch('/api/admin/users', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal
    });
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'bad_response', status: response.status };
  }
  const parsed = body as Partial<CreateStaffResponse> | null;
  if (parsed && parsed.ok === true && response.status === 201 && parsed.user && typeof parsed.user.id === 'string') {
    return { ok: true, user: parsed.user };
  }
  if (parsed && parsed.ok === false && typeof parsed.error === 'string' && KNOWN_ERRORS.has(parsed.error)) {
    return parsed as Extract<CreateStaffResponse, { ok: false }>;
  }
  return { ok: false, error: 'bad_response', status: response.status };
}
