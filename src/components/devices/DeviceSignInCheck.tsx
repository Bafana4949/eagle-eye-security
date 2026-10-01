'use client';

/**
 * "Signed in as <name> – not you?" on the guard app for a minute after a patrol-phone tap.
 * With gloves a neighbouring name is easily hit, and one tap signs that guard in at once; this
 * makes the name impossible to miss before clock-in and offers the way back to the guard list
 * (/login on a patrol phone shows the list and hands the phone over to the right guard).
 * Only shown after a patrol-phone sign-in on this tab (see markDeviceSignIn in the login page).
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { DEVICE_SIGN_IN_CHECK_MS, clearDeviceSignIn, isFreshDeviceSignIn } from '@/lib/auth/patrolDevice';
import { useTranslation } from '@/lib/i18n/context';

export function DeviceSignInCheck() {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const userId = auth.status === 'signed_in' ? (auth.user?.id ?? null) : null;
  const [shownFor, setShownFor] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    // sessionStorage is read after mounting (the server render never shows the check).
    const show = window.setTimeout(() => setShownFor(isFreshDeviceSignIn(userId) ? userId : null), 0);
    const hide = window.setTimeout(() => {
      setShownFor(null);
      clearDeviceSignIn();
    }, DEVICE_SIGN_IN_CHECK_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [userId]);

  if (!userId || shownFor !== userId) return null;
  const name = auth.profile ? `${auth.profile.firstName} ${auth.profile.lastName}`.trim() : '';

  return (
    <div className="mb-4 rounded-xl border-2 border-ee-primary bg-ee-primary/10 p-3" role="status" data-testid="device-signed-in-check">
      <p className="flex items-start gap-2 text-lg font-bold text-ee-text">
        <UserCheck className="mt-1 h-5 w-5 flex-none text-ee-primary" aria-hidden="true" />
        <span className="min-w-0 break-words">{t('pdevJustSignedIn', name)}</span>
      </p>
      <div className="mt-3 grid gap-2 min-[360px]:grid-cols-2">
        <button
          type="button"
          onClick={() => {
            clearDeviceSignIn();
            setShownFor(null);
          }}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-ee-primary bg-ee-primary px-3 text-base font-semibold text-ee-on-primary hover:bg-ee-primary-strong"
          data-testid="device-signed-in-confirm"
        >
          {t('pdevThatsMe')}
        </button>
        <button
          type="button"
          onClick={() => {
            clearDeviceSignIn();
            setShownFor(null);
            router.push('/login');
          }}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-ee-border bg-ee-surface px-3 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
          data-testid="device-not-you"
        >
          {t('pdevNotYou')}
        </button>
      </div>
    </div>
  );
}
