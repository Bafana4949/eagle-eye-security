'use client';

/**
 * Shown in the manager portals (admin / supervisor header) when a supervisor or admin is signed in
 * on an ENROLLED patrol phone - e.g. to enrol it, check the list, or by mistake. Guards must never
 * reach /admin or /supervisor, and a manager session left on the shared phone would give the next
 * guard exactly that (the PWA opens on /guard and the proxy sends a manager to their portal). So:
 * - a persistent warning "This is a patrol phone - sign out before you hand it over";
 * - automatic sign-out after MANAGER_IDLE_SIGN_OUT_MS without any touch / key press
 *   (`onIdle` signs out with force: a manager's queued records, if any, stay on the phone).
 * On any other phone this renders nothing.
 */
import React, { useEffect, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { isManagerAccount } from '@/lib/auth/patrolDevice';
import { useTranslation } from '@/lib/i18n/context';
import { usePatrolDevice } from './usePatrolDevice';

/** A manager session on a patrol phone ends after this long without use. */
export const MANAGER_IDLE_SIGN_OUT_MS = 10 * 60_000;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

export function PatrolPhoneManagerNotice({ onIdle, idleMs = MANAGER_IDLE_SIGN_OUT_MS }: { onIdle: () => void; idleMs?: number }) {
  const { t } = useTranslation();
  const { roles, status } = useAuth();
  const device = usePatrolDevice();
  const active = device !== null && status === 'signed_in' && isManagerAccount(roles);
  const onIdleRef = useRef(onIdle);

  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!active) return;
    let timer = window.setTimeout(() => onIdleRef.current(), idleMs);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onIdleRef.current(), idleMs);
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, reset);
    };
  }, [active, idleMs]);

  if (!active) return null;
  return (
    <div className="border-t border-ee-danger/60 bg-ee-danger/15" role="status" data-testid="device-manager-banner">
      <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2 text-ee-text">
        <ShieldAlert className="mt-0.5 h-5 w-5 flex-none text-ee-danger-text" aria-hidden="true" />
        <p className="min-w-0 text-sm">
          <span className="font-semibold">{t('pdevManagerBannerTitle')}</span>{' '}
          <span>{t('pdevManagerBannerBody', Math.round(idleMs / 60_000))}</span>
        </p>
      </div>
    </div>
  );
}
