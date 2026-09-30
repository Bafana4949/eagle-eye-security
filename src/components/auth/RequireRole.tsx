'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ShieldAlert, WifiOff } from 'lucide-react';
import type { UserRole } from '@/types/models';
import { useAuth } from '@/lib/auth/AuthProvider';
import { hasAnyRole, homeForRoles } from '@/lib/auth/routeAccess';

interface RequireRoleProps {
  roles: readonly UserRole[];
  children: React.ReactNode;
}

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="min-h-[60vh] w-full flex flex-col items-center justify-center gap-4 p-8" role="status" aria-live="polite">
      <div className="h-10 w-10 rounded-full border-4 border-slate-700 border-t-blue-500 animate-spin" aria-hidden="true" />
      <p className="text-sm text-slate-300">{label}</p>
    </div>
  );
}

/**
 * Client-side gate for a portal. Shows a loading state while the session is checked, sends
 * signed-out users to /login, and tells signed-in users without the role that they are not
 * authorised. UX only — the database (RLS) is what actually protects the data.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  const mustLogIn = auth.status === 'signed_out' && auth.reason !== 'unavailable' && auth.reason !== 'config_error';

  useEffect(() => {
    if (!mustLogIn) return;
    const params = new URLSearchParams({ next: pathname || '/' });
    if (auth.reason) params.set('reason', auth.reason);
    router.replace(`/login?${params.toString()}`);
  }, [mustLogIn, auth.reason, pathname, router]);

  if (auth.status === 'loading') return <LoadingSkeleton label="Checking your sign-in…" />;

  if (auth.status === 'signed_out') {
    if (mustLogIn) return <LoadingSkeleton label="Redirecting to sign in…" />;
    return (
      <div className="min-h-[60vh] w-full flex flex-col items-center justify-center gap-4 p-8 text-center" role="alert">
        <WifiOff className="h-10 w-10 text-amber-400" aria-hidden="true" />
        <h1 className="text-lg font-bold text-slate-100">
          {auth.reason === 'config_error' ? 'App not configured' : 'Cannot verify your account'}
        </h1>
        <p className="text-sm text-slate-300 max-w-sm">
          {auth.reason === 'config_error'
            ? 'This installation is missing its Supabase settings. Contact your administrator.'
            : 'Your account details are not stored on this phone yet and the server cannot be reached. Connect to the internet once, then try again.'}
        </p>
        {auth.error && <p className="text-xs text-slate-400 max-w-sm break-words">{auth.error}</p>}
        <button
          type="button"
          onClick={() => void auth.refresh()}
          className="min-h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-bold"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!hasAnyRole(auth.roles, roles)) {
    const home = homeForRoles(auth.roles);
    return (
      <div className="min-h-[60vh] w-full flex flex-col items-center justify-center gap-4 p-8 text-center" role="alert">
        <ShieldAlert className="h-10 w-10 text-red-400" aria-hidden="true" />
        <h1 className="text-lg font-bold text-slate-100">Not authorised for this area</h1>
        <p className="text-sm text-slate-300 max-w-sm">
          Your account ({auth.user?.email ?? 'unknown'}) does not have access to this part of Eagle Eye.
        </p>
        <div className="flex gap-3">
          {home !== '/' && (
            <Link href={home} className="min-h-11 px-5 inline-flex items-center rounded-xl bg-blue-600 text-white text-sm font-bold">
              Go to my area
            </Link>
          )}
          <button
            type="button"
            onClick={() =>
              void auth.signOut().then((result) => {
                if (!result.ok) {
                  setSignOutNotice(
                    `${result.pendingCount} record(s) recorded on this phone have not reached the server yet. Sign out from your own area once they have synced.`
                  );
                }
              })
            }
            className="min-h-11 px-5 rounded-xl border border-slate-600 text-slate-100 text-sm font-bold"
          >
            Sign out
          </button>
        </div>
        {signOutNotice && (
          <p className="text-xs text-amber-300 max-w-sm" role="status">
            {signOutNotice}
          </p>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
