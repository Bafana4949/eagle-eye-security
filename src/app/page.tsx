'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { LogIn, ShieldAlert, WifiOff } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { homeForRoles } from '@/lib/auth/routeAccess';
import { useTranslation } from '@/lib/i18n/context';
import { SignOutControl } from '@/components/shared/HeaderNav';

function Brand() {
  const { t } = useTranslation();
  return (
    <div className="text-center">
      <Image
        src="/Eagle_Eye_Logo.jpg"
        alt={t('authLogoAlt')}
        width={96}
        height={96}
        className="mx-auto h-24 w-24 rounded-2xl border-2 border-ee-primary/80 object-cover"
        loading="eager"
      />
      <h1 className="mt-4 font-display text-4xl font-bold uppercase tracking-wide">{t('authBrandName')}</h1>
      <p className="mt-1 text-sm font-semibold uppercase tracking-wider text-ee-muted">{t('authBrandOrgFull')}</p>
    </div>
  );
}

export default function RootPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const home = auth.status === 'signed_in' ? homeForRoles(auth.roles) : null;
  const redirecting = home !== null && home !== '/';

  useEffect(() => {
    if (redirecting && home) router.replace(home);
  }, [redirecting, home, router]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-ee-bg px-4 py-10 text-ee-text">
      <div className="w-full max-w-sm space-y-8">
        <Brand />

        {(auth.status === 'loading' || redirecting) && (
          <p role="status" aria-live="polite" className="text-center text-base text-ee-muted" data-testid="auth-home-checking">
            {redirecting ? t('authOpeningYourArea') : t('authCheckingSignIn')}
          </p>
        )}

        {auth.status === 'signed_in' && !redirecting && (
          <div className="space-y-4 text-center" role="alert" data-testid="auth-home-no-role">
            <ShieldAlert className="mx-auto h-10 w-10 text-ee-warning" aria-hidden="true" />
            <p className="text-base">{t('authNoRoleBody', auth.user?.email ?? '')}</p>
            <SignOutControl variant="full" testId="auth-home-signout" />
          </div>
        )}

        {auth.status === 'signed_out' && (
          <div className="space-y-4">
            <p className="text-center text-base text-ee-muted">{t('authPortalIntro')}</p>
            {(auth.reason === 'unavailable' || auth.reason === 'config_error') && (
              <div
                className="rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-warning"
                role="alert"
                data-testid="auth-home-unavailable"
              >
                <p className="flex items-center gap-2 font-semibold">
                  <WifiOff className="h-4 w-4 flex-none" aria-hidden="true" />
                  {auth.reason === 'config_error' ? t('authConfigError') : t('authCannotCheckSignIn')}
                </p>
                {auth.reason === 'unavailable' && (
                  <button
                    type="button"
                    onClick={() => void auth.refresh()}
                    className="mt-2 min-h-11 rounded-lg border border-ee-warning/60 px-4 font-semibold"
                    data-testid="auth-home-retry"
                  >
                    {t('authTryAgain')}
                  </button>
                )}
              </div>
            )}
            <Link
              href="/login"
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-primary bg-ee-primary px-6 text-lg font-bold text-ee-on-primary no-underline hover:bg-ee-primary-strong"
              data-testid="auth-home-signin"
            >
              <LogIn className="h-5 w-5" aria-hidden="true" />
              {t('authSignIn')}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
