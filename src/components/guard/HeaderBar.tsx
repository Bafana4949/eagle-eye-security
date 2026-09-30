'use client';

import React, { useEffect, useId, useState } from 'react';
import Image from 'next/image';
import { liveQuery } from 'dexie';
import { Check, ChevronDown, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import { sastTimeHM } from '@/lib/config/siteTime';
import type { Site } from '@/types/models';
import { offlineDB, type ActiveShiftRecord } from '@/lib/offline/db';
import { getActiveShift } from '@/lib/data/shiftStore';
import { ModalDialog, SyncStatusButton } from '@/components/shared/HeaderNav';

/** SAST wall-clock time, refreshed every 15 s. Empty until mounted (server HTML has no time). */
function useSastClock(): string {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => setTime(sastTimeHM(Date.now()));
    const first = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, []);
  return time;
}

/** The guard's open shift on this phone (live), or null. `undefined` while loading. */
export function useActiveShiftRecord(userId: string | null): ActiveShiftRecord | null | undefined {
  const [state, setState] = useState<{ userId: string | null; record: ActiveShiftRecord | null | undefined }>({
    userId: null,
    record: undefined
  });
  useEffect(() => {
    if (!userId || !offlineDB) return;
    const subscription = liveQuery(() => getActiveShift(userId)).subscribe({
      next: (record) => setState({ userId, record }),
      error: () => setState({ userId, record: null })
    });
    return () => subscription.unsubscribe();
  }, [userId]);
  if (!userId || !offlineDB) return null;
  return state.userId === userId ? state.record : undefined;
}

/** Active sites first (by name); inactive ones last. */
export function orderSites(sites: readonly Site[]): Site[] {
  return [...sites].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
}

export interface SiteChoiceListProps {
  /** A shift is open on this phone: the site cannot change until the guard clocks out. */
  locked?: boolean;
  onChosen?: (site: Site) => void;
}

/** The guard's assigned sites as large buttons; choosing one makes it the active site (stored per user). */
export function SiteChoiceList({ locked = false, onChosen }: SiteChoiceListProps) {
  const { t } = useTranslation();
  const auth = useAuth();
  const sites = orderSites(auth.sites);

  return (
    <div className="space-y-3">
      {locked && (
        <p className="rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-warning" data-testid="chrome-site-locked">
          {t('authSiteLocked')}
        </p>
      )}
      <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="chrome-site-list">
        {sites.map((site) => {
          const current = auth.activeSite?.id === site.id;
          const disabled = locked || !site.isActive;
          return (
            <li key={site.id}>
              <button
                type="button"
                disabled={disabled && !current}
                aria-pressed={current}
                onClick={() => {
                  if (disabled && !current) return;
                  // Also for the current site: stores the choice so the guard is not asked again.
                  auth.setActiveSiteId(site.id);
                  onChosen?.(site);
                }}
                className="flex min-h-14 w-full items-center justify-between gap-3 px-2 py-2 text-left hover:bg-ee-surface-raised disabled:opacity-50"
                data-testid={`chrome-site-option-${site.code || site.id}`}
              >
                <span className="min-w-0">
                  <span className={`block truncate text-base font-semibold ${current ? 'text-ee-primary' : 'text-ee-text'}`}>
                    {site.name}
                  </span>
                  <span className="block truncate text-sm text-ee-muted">
                    {site.isActive ? site.code : t('authSiteInactive', site.code)}
                  </span>
                </span>
                {current && <Check className="h-6 w-6 flex-none text-ee-primary" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface HeaderBarProps {
  /** A shift is open on this phone (the site switch is then locked). */
  siteLocked?: boolean;
}

export function HeaderBar({ siteLocked = false }: HeaderBarProps) {
  const { t } = useTranslation();
  const auth = useAuth();
  const clock = useSastClock();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerTitleId = useId();

  const guardName = auth.profile ? `${auth.profile.firstName} ${auth.profile.lastName}`.trim() : '';
  const site = auth.activeSite;
  const canSwitch = auth.sites.length > 1;

  const identity = (
    <>
      <span className="block truncate text-sm font-semibold text-ee-text" data-testid="chrome-guard-name">
        {guardName}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-sm text-ee-muted">
        <MapPin className="h-4 w-4 flex-none" aria-hidden="true" />
        <span className="truncate" data-testid="chrome-site-name">
          {site?.name ?? t('authNoSiteShort')}
        </span>
        {canSwitch && <ChevronDown className="h-4 w-4 flex-none text-ee-primary" aria-hidden="true" />}
      </span>
    </>
  );

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-ee-border bg-ee-bg pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-md items-center gap-2 px-4 py-2">
          <Image
            src="/Eagle_Eye_Logo.jpg"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 flex-none rounded-lg border border-ee-primary/60 object-cover max-[359px]:hidden"
            loading="eager"
          />
          {canSwitch ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
              aria-label={t('authSiteChangeLabel', guardName, site?.name ?? '')}
              className="min-h-12 min-w-0 flex-1 rounded-lg px-1 text-left hover:bg-ee-surface-raised"
              data-testid="chrome-site-switch"
            >
              {identity}
            </button>
          ) : (
            <div className="min-w-0 flex-1 px-1">{identity}</div>
          )}
          <span
            className="flex-none font-display text-2xl font-bold tabular-nums leading-none max-[359px]:hidden"
            aria-hidden="true"
            data-testid="chrome-clock"
          >
            {clock || '--:--'}
          </span>
          <SyncStatusButton className="flex-none" />
        </div>
        {auth.isOfflineSession && (
          <p
            className="border-t border-ee-border px-4 py-1.5 text-center text-xs font-semibold text-ee-warning"
            data-testid="chrome-offline-session"
          >
            {t('authOfflineSessionBanner')}
          </p>
        )}
      </header>

      {canSwitch && (
        <ModalDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          labelledBy={pickerTitleId}
          testId="chrome-site-dialog"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id={pickerTitleId} className="font-display text-2xl font-semibold">
              {t('authSitePickTitle')}
            </h2>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="min-h-11 rounded-xl border border-ee-border px-4 text-sm font-semibold hover:bg-ee-surface-raised"
            >
              {t('authClose')}
            </button>
          </div>
          <SiteChoiceList locked={siteLocked} onChosen={() => setPickerOpen(false)} />
        </ModalDialog>
      )}
    </>
  );
}
