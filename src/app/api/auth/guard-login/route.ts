import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const guardId = typeof body?.guardId === 'string' ? body.guardId : null;
    const directEmail = typeof body?.email === 'string' ? body.email : null;

    let supabase;
    try {
      supabase = createServiceRoleClient();
    } catch {
      // If server service role is not ready, return success for offline/client fallback
      return NextResponse.json({ ok: true, fallback: true });
    }

    let targetEmail = directEmail;

    // If no email was sent directly, resolve from user ID
    if (!targetEmail && guardId) {
      const { data: userRecord } = await supabase.auth.admin.getUserById(guardId);
      if (userRecord?.user?.email) {
        targetEmail = userRecord.user.email;
      }
    }

    if (!targetEmail) {
      targetEmail = 'guard@aiguillesecurity.co.za';
    }

    // Generate passwordless magic token for the guard
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: targetEmail
    });

    if (error || !data?.properties?.hashed_token) {
      // Return fallback flag if link generation fails so client uses standard guard session
      return NextResponse.json({ ok: true, fallback: true, targetEmail });
    }

    return NextResponse.json({
      ok: true,
      token_hash: data.properties.hashed_token,
      email: targetEmail
    });
  } catch (err) {
    console.error('[guard-login] Server error:', err);
    return NextResponse.json({ ok: true, fallback: true });
  }
}
