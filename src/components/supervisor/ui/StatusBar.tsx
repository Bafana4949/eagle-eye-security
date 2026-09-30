'use client';

import React from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { formatWhen } from '../data/derive';
import type { RealtimeState } from '../hooks/useRealtimeChannel';
import { loadProblemMessage } from './labels';

export interface StatusBarProps {
  /** 'realtime' (supervisor) shows Live / Reconnecting; 'poll' (viewer) shows the refresh period. */
  mode: 'realtime' | 'poll';
  realtime?: RealtimeState;
  online: boolean;
  loading: boolean;
  lastSuccessAt: number | null;
  error: unknown;
  pollSeconds: number;
  onRefresh: () => void;
  now: number;
  testIdPrefix: string;
  children?: React.ReactNode;
}

/**
 * Connection and freshness of the data on screen. Never claims "live" unless the realtime
 * channel reports SUBSCRIBED; when it does not, it says how often the page re-reads instead.
 */
export function StatusBar({
  mode,
  realtime,
  online,
  loading,
  lastSuccessAt,
  error,
  pollSeconds,
  onRefresh,
  now,
  testIdPrefix,
  children
}: StatusBarProps) {
  const { t } = useTranslation();

  let state: 'offline' | 'live' | 'connecting' | 'reconnecting' | 'polling';
  if (!online) state = 'offline';
  else if (mode === 'poll') state = 'polling';
  else if (realtime === 'live') state = 'live';
  else if (realtime === 'connecting') state = 'connecting';
  else state = 'reconnecting';

  const updated = lastSuccessAt !== null ? formatWhen(lastSuccessAt, now) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-ee-border bg-ee-surface px-3 py-2">
      {/* Phones: the status gets its own row; the site filter and Refresh share the next one. */}
      <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1">
        {/* Only the connection state is announced; the "Updated" time changes on every poll and would be noise. */}
        <p
          className="flex flex-wrap items-center gap-2 text-sm font-semibold"
          aria-live="polite"
          data-testid={`${testIdPrefix}-connection`}
          data-state={state}
        >
          {state === 'offline' && (
            <span className="inline-flex items-center gap-1.5 text-ee-warning">
              <WifiOff className="h-4 w-4 flex-none" aria-hidden="true" />
              {updated ? t('supOfflineShowing', updated) : t('supOfflineNoData')}
            </span>
          )}
          {state === 'live' && (
            <span className="inline-flex items-center gap-1.5 text-ee-success">
              <span className="h-2.5 w-2.5 flex-none rounded-full bg-ee-success" aria-hidden="true" />
              {t('supLive', pollSeconds)}
            </span>
          )}
          {state === 'connecting' && <span className="text-ee-muted">{t('supConnecting')}</span>}
          {state === 'reconnecting' && (
            <span className="inline-flex items-center gap-1.5 text-ee-warning">
              <span className="h-2.5 w-2.5 flex-none rounded-full bg-ee-warning" aria-hidden="true" />
              {t('supReconnecting', pollSeconds)}
            </span>
          )}
          {state === 'polling' && <span className="text-ee-muted">{t('supPolling', pollSeconds)}</span>}
        </p>
        <p className="text-xs text-ee-muted" data-testid={`${testIdPrefix}-updated`}>
          {updated ? t('supUpdatedAt', updated) : loading ? t('supLoading') : t('supNotLoaded')}
        </p>
        {error != null && online && (
          <p className="text-xs font-semibold text-ee-danger-text" role="alert" data-testid={`${testIdPrefix}-load-error`}>
            {loadProblemMessage(t, error)}
            {updated ? ` ${t('supShowingFrom', updated)}` : ''}
          </p>
        )}
      </div>
      {children}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="ml-auto inline-flex min-h-11 flex-none items-center gap-2 rounded-lg border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-60"
        data-testid={`${testIdPrefix}-refresh`}
      >
        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
        {loading ? t('supRefreshing') : t('supRefresh')}
      </button>
    </div>
  );
}

/** Site filter: all visible sites or one of them. Hidden when the caller sees only one site. */
export function SiteFilter({
  sites,
  value,
  onChange,
  testId
}: {
  sites: ReadonlyArray<{ id: string; name: string; isActive: boolean }>;
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  if (sites.length < 2) return null;
  return (
    <label className="flex flex-1 items-center gap-2 text-sm text-ee-muted sm:flex-none">
      <span className="flex-none">{t('supSiteFilter')}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full min-w-32 rounded-lg border border-ee-border bg-ee-bg px-2 text-sm text-ee-text sm:w-auto sm:max-w-56"
        data-testid={testId}
      >
        <option value="all">{t('supAllSites', sites.length)}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.isActive ? site.name : `${site.name} (${t('supSiteInactive')})`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Lists the sections whose row limit was reached (so an incomplete list is never presented as complete). */
export function PartialNotice({ sections, testId }: { sections: readonly string[]; testId: string }) {
  const { t } = useTranslation();
  if (sections.length === 0) return null;
  const names: Record<string, TranslationKey> = {
    shifts: 'supSecShifts',
    scans: 'supSecScans',
    incidents: 'supSecIncidents',
    panic: 'supSecSos',
    gate: 'supSecGate',
    checkpoints: 'supSecCheckpoints',
    media: 'supSecPhotos'
  };
  const hasPeople = sections.includes('people');
  const others = [...new Set(sections.filter((s) => s !== 'people'))].map((s) => (names[s] ? t(names[s]) : s));
  return (
    <div className="space-y-1 rounded-lg border border-ee-warning/40 bg-ee-warning/10 px-3 py-2 text-xs text-ee-warning" role="status" data-testid={testId}>
      {others.length > 0 && <p>{t('supPartialData', others.join(', '))}</p>}
      {hasPeople && <p>{t('supNamesUnavailable')}</p>}
    </div>
  );
}
