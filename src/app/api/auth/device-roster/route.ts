/**
 * POST /api/auth/device-roster  body { deviceSecret }
 *
 * Lists the guards who may sign in on an ENROLLED patrol phone (the phone proves enrolment with
 * the device secret it received from public.enrol_patrol_device). Unknown or revoked phones get
 * 401 { ok: false, error: 'device_not_enrolled' } and must use e-mail + password instead.
 *
 * /api/* is not covered by src/proxy.ts and the caller has no session yet: the device secret is
 * the only credential, and it is checked in the database (service-role-only device_roster).
 * Success: 200 { ok: true, device, site, guards } with first and last names only — no e-mail,
 * phone or employee numbers. Never cached.
 * Logic: src/lib/auth/deviceLogin.ts.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { createDeviceLoginDeps, handleDeviceRosterRequest } from '@/lib/auth/deviceLogin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  let outcome: Awaited<ReturnType<typeof handleDeviceRosterRequest>>;
  try {
    outcome = await handleDeviceRosterRequest(
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
