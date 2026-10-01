/**
 * POST /api/auth/device-login  body { deviceSecret, guardId }
 *
 * Signs a guard in on an ENROLLED patrol phone without a password. The phone proves enrolment with
 * its device secret; the guard is picked from that phone's site roster (/api/auth/device-roster).
 * The database (service-role-only device_guard_login) decides whether the guard may sign in there
 * — active guard of the device's organisation, assigned to the device's site, no manager roles —
 * audits the sign-in and supplies the Auth e-mail. The server then generates a magic-link token
 * (no e-mail is sent) and returns only its hash: { ok: true, tokenHash }. The phone exchanges it with
 * supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) for a normal guard session.
 *
 * The request can carry no e-mail or other identity (strict schema), and the e-mail is never
 * returned. Failures are { ok: false, error: '<code>' }; there is no fallback success. Never cached.
 * Logic: src/lib/auth/deviceLogin.ts.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { createDeviceLoginDeps, handleDeviceLoginRequest } from '@/lib/auth/deviceLogin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  let outcome: Awaited<ReturnType<typeof handleDeviceLoginRequest>>;
  try {
    outcome = await handleDeviceLoginRequest(
      {
        contentType: request.headers.get('content-type'),
        contentLength: request.headers.get('content-length'),
        body: request.body
      },
      createDeviceLoginDeps(createServiceRoleClient)
    );
  } catch {
    // Never echo internal error text.
    outcome = { status: 502, body: { ok: false, error: 'session_failed' } };
  }
  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}
