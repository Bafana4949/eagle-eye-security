'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { MapPinOff } from 'lucide-react';
import { RequireRole } from '@/components/auth/RequireRole';
import { HeaderBar, SiteChoiceList, useActiveShiftRecord } from '@/components/guard/HeaderBar';
import { BottomNav } from '@/components/guard/BottomNav';
import { SosPanicModal } from '@/components/guard/SosPanicModal';
import { SignOutControl, SyncStatusButton } from '@/components/shared/HeaderNav';
import { DeviceSignInCheck } from '@/components/devices/DeviceSignInCheck';
import { useAuth } from '@/lib/auth/AuthProvider';
import { browserStorage, readActiveSiteId } from '@/lib/auth/identity';
import { useTranslation } from '@/lib/i18n/context';

const GUARD_ROLES = ['guard'] as const;

/** Plain full-screen message used when the guard app cannot open yet (no site / choose a site). */
function GuardGate({ children, testId }: { children: React.ReactNode; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col bg-ee-bg text-ee-text" data-testid={testId}>
      <header className="border-b border-ee-border pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-md items-center gap-3 px-4 py-3">
          <Image
            src="/eagle_eye_enhanced_emblem.jpg"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 rounded-lg border border-ee-primary/60 object-cover"
          />
          <span className="flex-1 font-display text-xl font-bold uppercase tracking-wide">{t('authBrandName')}</span>
          <SyncStatusButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}

function GuardShell({ children }: { children: React.ReactNode }) {
  const { t, applyPreferredLanguage } = useTranslation();
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const activeShift = useActiveShiftRecord(userId);
  const [pickedThisVisit, setPickedThisVisit] = useState(false);

  // The account's language (set by the administrator) applies until the guard picks one on this phone.
  useEffect(() => {
    applyPreferredLanguage(auth.profile?.preferredLanguage);
    return () => applyPreferredLanguage(null);
  }, [applyPreferredLanguage, auth.profile?.preferredLanguage]);

  // An open shift belongs to one site: keep that site active while the shift runs.
  const shiftSiteId = activeShift?.siteId ?? null;
  const { setActiveSiteId, sites } = auth;
  const activeSiteId = auth.activeSite?.id ?? null;
  useEffect(() => {
    if (shiftSiteId && shiftSiteId !== activeSiteId && sites.some((site) => site.id === shiftSiteId)) {
      setActiveSiteId(shiftSiteId);
    }
  }, [shiftSiteId, activeSiteId, sites, setActiveSiteId]);

  // A guard with several sites chooses one explicitly the first time (stored per user on this phone).
  const hasStoredChoice = useMemo(() => {
    if (!userId || !activeSiteId) return false;
    return readActiveSiteId(browserStorage(), userId) === activeSiteId;
  }, [userId, activeSiteId]);

  if (auth.sites.length === 0 || !auth.activeSite) {
    return (
      <GuardGate testId="chrome-no-site">
        <MapPinOff className="h-12 w-12 text-ee-warning" aria-hidden="true" />
        <h1 className="mt-4 font-display text-3xl font-semibold">{t('authNoSiteTitle')}</h1>
        <p className="mt-2 text-base text-ee-muted">{t('authNoSiteBody')}</p>
        <p className="mt-4 rounded-xl border border-ee-border bg-ee-surface p-3 text-sm">{t('authNoSiteEmergency')}</p>
        <div className="mt-6 grid gap-3">
          <button
            type="button"
            onClick={() => void auth.refresh()}
            className="inline-flex min-h-14 items-center justify-center rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold hover:bg-ee-surface-raised"
            data-testid="chrome-no-site-refresh"
          >
            {t('authTryAgain')}
          </button>
          <SignOutControl variant="full" testId="chrome-no-site-signout" />
        </div>
      </GuardGate>
    );
  }

  const mayNeedSiteChoice = auth.sites.length > 1 && !hasStoredChoice && !pickedThisVisit;
  if (mayNeedSiteChoice && activeShift === undefined) {
    // Still reading this phone's open shift (a running shift decides the site by itself).
    return (
      <GuardGate testId="chrome-site-loading">
        <p role="status" className="text-base text-ee-muted">
          {t('authLoading')}
        </p>
      </GuardGate>
    );
  }
  if (mayNeedSiteChoice && activeShift === null) {
    return (
      <GuardGate testId="chrome-site-choice">
        <h1 className="font-display text-3xl font-semibold">{t('authSitePickTitle')}</h1>
        <p className="mb-4 mt-1 text-base text-ee-muted">{t('authSitePickBody')}</p>
        <SiteChoiceList onChosen={() => setPickedThisVisit(true)} />
      </GuardGate>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ee-bg text-ee-text">
      <HeaderBar siteLocked={!!activeShift} />
      <main className="mx-auto w-full max-w-md flex-1 px-4 pt-4 pb-[calc(9rem+env(safe-area-inset-bottom))]">
        <DeviceSignInCheck />
        {children}
      </main>
      <SosPanicModal />
      <BottomNav />
    </div>
  );
}

export default function GuardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole roles={GUARD_ROLES}>
      <GuardShell>{children}</GuardShell>
    </RequireRole>
  );
}
