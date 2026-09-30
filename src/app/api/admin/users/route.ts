/**
 * POST /api/admin/users — an organisation admin creates a staff account.
 *
 * /api/* is not covered by src/proxy.ts, so this handler authenticates the caller itself (see
 * ./provision.ts). The service-role key is read only on the server (src/lib/supabase/admin.ts,
 * `server-only`) and only after the caller has been verified as an active admin.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createRouteHandlerSupabaseClient } from '@/lib/supabase/routeHandler';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { guardLoginDomain } from '@/lib/auth/signIn';
import type { CreateStaffErrorCode, CreateStaffResponse } from '@/components/admin/staffSchema';
import { isCrossOriginRequest, provisionStaffAccount } from './provision';

export const runtime = 'nodejs';

/** Generous upper bound for the JSON body (a name, a login, a password and site ids). */
const MAX_BODY_BYTES = 16 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' };

function respond(status: number, body: CreateStaffResponse): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function refuse(status: number, error: CreateStaffErrorCode): NextResponse {
  return respond(status, { ok: false, error });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isCrossOriginRequest(request.headers, request.nextUrl.host)) return refuse(403, 'cross_origin');

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) return refuse(415, 'unsupported_media_type');

  let text: string;
  try {
    text = await request.text();
  } catch {
    return refuse(400, 'invalid_json');
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return refuse(413, 'payload_too_large');

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'invalid_json');
  }

  let caller: Awaited<ReturnType<typeof createRouteHandlerSupabaseClient>>;
  try {
    caller = await createRouteHandlerSupabaseClient();
  } catch {
    return refuse(500, 'server_misconfigured');
  }

  try {
    const outcome = await provisionStaffAccount(body, {
      caller,
      getServiceClient: createServiceRoleClient,
      guardLoginDomain: guardLoginDomain()
    });
    return respond(outcome.status, outcome.body);
  } catch {
    // Never echo internal error text (it could contain configuration details).
    return refuse(502, 'auth_service_error');
  }
}
