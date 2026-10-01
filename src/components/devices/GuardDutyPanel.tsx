'use client';

/**
 * "Guard duty" tab of /login on a patrol phone: the guards of the phone's site as large name
 * buttons. The roster comes from the server (POST /api/auth/device-roster, authorised by this
 * phone's device secret only); nothing is listed from a cache and nothing is invented.
 * Signing in (the tap) is handled by the login page, which owns the session hand-over.
 *
 * Next to each name: how many of that guard's records are still waiting on THIS phone (read
 * from the offline queue, no network). They upload only when that guard signs in here again,
 * and the server refuses evidence older than 7 days - so the phone must say whose they are.
 * Layout: the names come first (gloves, 320 px screens); explanations follow below them.
 */
import React, { useEffect, useState } from 'react';
import { AlertCircle, CloudUpload, KeyRound, Loader2, MapPin, RefreshCw, Smartphone, UserRound } from 'lucide-react';
import {
  fetchDeviceRoster,
  type DeviceRosterResult,
  type PatrolDevice,
  type PatrolDeviceErrorKind,
  type RosterGuard
} from '@/lib/auth/patrolDevice';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { QueuedCounts } from './devicesData';

/** What to tell a guard for each error kind of the patrol-phone sign-in. */
export const GUARD_DEVICE_ERROR_KEYS: Record<PatrolDeviceErrorKind, TranslationKey> = {
  offline: 'pdevErrOffline',
  timeout: 'pdevErrSlow',
  not_enrolled: 'pdevEnrolmentRemoved',
  not_allowed: 'pdevErrNotAllowed',
  server_not_configured: 'pdevErrServerNotConfigured',
  failed: 'pdevErrFailed'
};

export function rosterGuardName(guard: RosterGuard): string {
  return `${guard.firstName} ${guard.lastName}`.trim();
}

export interface GuardDutyPanelProps {
  /** This phone's enrolment (null: not a patrol phone). */
  device: PatrolDevice | null;
  /**
   * This phone was a patrol phone earlier in this visit and no longer is (the server answered
   * "not enrolled" and the local enrolment was cleared): explain that instead of the generic text.
   */
  enrolmentLost: boolean;
  /** The guard whose sign-in is in progress. */
  busyGuardId: string | null;
  disabled?: boolean;
  /** Translated sign-in error, or null. */
  error: string | null;
  /** Changing it reloads the roster (e.g. after the server refused a guard). */
  reloadSignal: number;
  /** Records on this phone that have not uploaded yet, per guard (offline queue). */
  queued?: QueuedCounts | null;
  /** Nobody is signed in on this phone: show the total of waiting records as a banner. */
  showQueuedTotal?: boolean;
  onSelectGuard: (guard: RosterGuard) => void;
  onUsePassword: () => void;
}

type RosterState = { key: string; result: DeviceRosterResult };

export function GuardDutyPanel({
  device,
  enrolmentLost,
  busyGuardId,
  disabled = false,
  error,
  reloadSignal,
  queued = null,
  showQueuedTotal = false,
  onSelectGuard,
  onUsePassword
}: GuardDutyPanelProps) {
  const { t } = useTranslation();
  const deviceId = device?.deviceId ?? null;
  const [reloadToken, setReloadToken] = useState(0);
  const [roster, setRoster] = useState<RosterState | null>(null);

  const requestKey = deviceId ? `${deviceId}|${reloadToken}|${reloadSignal}` : null;
  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    // On "not enrolled" fetchDeviceRoster clears the local enrolment; `device` then becomes null.
    void fetchDeviceRoster().then((result) => {
      if (!cancelled) setRoster({ key: requestKey, result });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  // Back online: the list may be loadable now.
  useEffect(() => {
    const onOnline = () => setReloadToken((n) => n + 1);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  if (!device) {
    return (
      <div className="space-y-4" data-testid="device-not-enrolled">
        <div className="flex items-start gap-3 rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-4 text-ee-text">
          <Smartphone className="mt-0.5 h-6 w-6 flex-none text-ee-warning" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-base font-semibold" data-testid="device-not-enrolled-text">
              {enrolmentLost ? t('pdevEnrolmentRemoved') : t('pdevNotEnrolled')}
            </p>
            {!enrolmentLost && <p className="text-sm text-ee-muted">{t('pdevNotEnrolledNext')}</p>}
          </div>
        </div>
        {enrolmentLost && showQueuedTotal && queued && queued.total > 0 && (
          <p
            className="flex items-start gap-2 rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-text"
            data-testid="device-queued-banner"
            data-count={queued.total}
          >
            <CloudUpload className="mt-0.5 h-4 w-4 flex-none text-ee-warning" aria-hidden="true" />
            <span>{t('pdevQueuedBanner', queued.total)}</span>
          </p>
        )}
        <button
          type="button"
          onClick={onUsePassword}
          className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-surface px-4 py-3 text-center text-base font-semibold text-ee-text hover:bg-ee-surface-raised focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ee-primary"
          data-testid="device-use-password"
        >
          <KeyRound className="h-5 w-5 flex-none" aria-hidden="true" />
          <span>{t('pdevUsePassword')}</span>
        </button>
      </div>
    );
  }

  // While reloading, keep showing the last answer for this phone instead of flickering.
  const current = roster && requestKey && roster.key === requestKey ? roster.result : null;
  const shown = current ?? (roster && roster.key.startsWith(`${device.deviceId}|`) ? roster.result : null);
  const loading = current === null;
  const siteName = shown?.ok ? shown.site.name : device.siteName;
  const phoneLabel = shown?.ok ? shown.device.label : device.label;
  const busyGuard = shown?.ok && busyGuardId ? shown.guards.find((guard) => guard.id === busyGuardId) ?? null : null;

  return (
    <div className="space-y-3" data-testid="device-guard-duty">
      <div className="rounded-xl border border-ee-border bg-ee-bg px-3 py-2 text-sm">
        <p className="flex items-start gap-2 font-semibold text-ee-text" data-testid="device-site-name">
          <MapPin className="mt-0.5 h-4 w-4 flex-none text-ee-primary" aria-hidden="true" />
          <span className="min-w-0 break-words">{t('pdevPhoneSite', siteName)}</span>
        </p>
        <p className="mt-0.5 flex items-start gap-2 text-ee-muted" data-testid="device-phone-label">
          <Smartphone className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          <span className="min-w-0 break-words">{t('pdevPhoneLabel', phoneLabel)}</span>
        </p>
      </div>

      <h2 className="font-display text-2xl font-semibold">{t('pdevGuardTitle')}</h2>

      <div role="alert" aria-live="assertive" data-testid="device-login-error">
        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm font-semibold text-ee-danger-text">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>

      <p role="status" className="sr-only">
        {busyGuard ? t('pdevSigningInAs', rosterGuardName(busyGuard)) : ''}
      </p>

      {!shown ? (
        <p role="status" className="flex items-center gap-2 text-base text-ee-muted" data-testid="device-roster-loading">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>{t('pdevRosterLoading')}</span>
        </p>
      ) : !shown.ok ? (
        <div className="space-y-3 rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3" data-testid="device-roster-error">
          <p className="text-sm font-semibold text-ee-text">{t('pdevRosterFailed')}</p>
          <p className="text-sm text-ee-text" data-testid="device-roster-error-text">
            {t(GUARD_DEVICE_ERROR_KEYS[shown.error])}
          </p>
          <button
            type="button"
            onClick={() => setReloadToken((n) => n + 1)}
            disabled={loading}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
            data-testid="device-roster-retry"
          >
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            <span>{t('pdevTryAgain')}</span>
          </button>
        </div>
      ) : shown.guards.length === 0 ? (
        <p className="rounded-xl border border-ee-border bg-ee-bg p-3 text-base text-ee-text" data-testid="device-roster-empty">
          {t('pdevRosterEmpty', siteName)}
        </p>
      ) : (
        <ul aria-label={t('pdevRosterListLabel', siteName)} className="grid gap-4" data-testid="device-roster">
          {shown.guards.map((guard) => {
            const name = rosterGuardName(guard);
            const busy = busyGuardId === guard.id;
            const waiting = queued?.byUser[guard.id] ?? 0;
            return (
              <li key={guard.id}>
                <button
                  type="button"
                  onClick={() => onSelectGuard(guard)}
                  disabled={disabled || busyGuardId !== null}
                  aria-busy={busy || undefined}
                  className={`flex min-h-16 w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left text-xl font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ee-primary disabled:cursor-not-allowed ${
                    busy
                      ? 'border-ee-primary bg-ee-primary text-ee-on-primary'
                      : 'border-ee-border bg-ee-bg text-ee-text hover:border-ee-primary hover:bg-ee-surface-raised active:bg-ee-surface-raised disabled:opacity-60'
                  }`}
                  data-testid="device-guard-button"
                  data-guard-id={guard.id}
                >
                  {busy ? (
                    <Loader2 className="h-6 w-6 flex-none animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <UserRound className="h-6 w-6 flex-none" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="block break-words">{busy ? t('pdevSigningInAs', name) : name}</span>
                    {waiting > 0 && !busy && (
                      <span
                        className="mt-0.5 flex items-center gap-1 text-sm font-semibold text-ee-warning"
                        data-testid="device-guard-queued"
                        data-count={waiting}
                      >
                        <CloudUpload className="h-4 w-4 flex-none" aria-hidden="true" />
                        <span className="break-words">{t('pdevGuardQueued', waiting)}</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {showQueuedTotal && queued && queued.total > 0 && (
        <p
          className="flex items-start gap-2 rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-text"
          data-testid="device-queued-banner"
          data-count={queued.total}
        >
          <CloudUpload className="mt-0.5 h-4 w-4 flex-none text-ee-warning" aria-hidden="true" />
          <span>{t('pdevQueuedBanner', queued.total)}</span>
        </p>
      )}

      <p className="text-sm text-ee-muted">{t('pdevGuardIntro')}</p>
      <p className="text-sm text-ee-muted">{t('pdevEvidenceNote')}</p>

      {shown && (
        <button
          type="button"
          onClick={() => setReloadToken((n) => n + 1)}
          disabled={loading || busyGuardId !== null}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold text-ee-primary underline-offset-4 hover:underline disabled:opacity-50"
          data-testid="device-roster-refresh"
        >
          <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          <span>{t('pdevRosterRefresh')}</span>
        </button>
      )}
    </div>
  );
}
