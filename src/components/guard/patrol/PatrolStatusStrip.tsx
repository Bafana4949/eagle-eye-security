'use client';

import React from 'react';
import { BellRing, ListChecks, Navigation, RefreshCw, Smartphone } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { STALE_FIX_MS } from '@/lib/gps/location';
import type { LocationWatchState } from '@/lib/gps/useLocationWatch';
import { toneTextClass, type Tone } from './patrolLogic';
import { ageText, type Translate } from './patrolText';
import type { CheckpointsState } from './usePatrolData';

/** Accuracy above this is shown as weak (the reference app only trusted fixes of ±30 m or better). */
const WEAK_ACCURACY_METERS = 30;
/** While the watch reports an error, a fix older than this (the scan's max fix age) is no longer shown as ready. */
const FRESH_FIX_MS = 30000;

interface PatrolStatusStripProps {
  watch: LocationWatchState;
  screenAwake: boolean;
  checkpoints: CheckpointsState;
  now: number | null;
  onRetryCheckpoints: () => void;
  onSoundTest: () => void;
}

function gpsLine(t: Translate, watch: LocationWatchState, now: number | null): { tone: Tone; text: string; state: string } {
  const fix = watch.fix;
  // The watched fix ages while no new one arrives (indoors, GPS lost): never keep calling it "ready".
  const fixAgeMs =
    fix && fix.status === 'ok' && now !== null ? fix.ageMs + Math.max(0, now - (fix.receivedAt ?? fix.timestamp)) : 0;
  if (fix && fix.status === 'ok' && fixAgeMs <= STALE_FIX_MS && !(watch.error && fixAgeMs > FRESH_FIX_MS)) {
    const accuracy = Number.isFinite(fix.accuracy) ? Math.round(fix.accuracy) : null;
    if (accuracy === null) return { tone: 'warning', text: t('patrolGpsWeak', '?'), state: 'weak' };
    return accuracy <= WEAK_ACCURACY_METERS
      ? { tone: 'success', text: t('patrolGpsReady', accuracy), state: 'ready' }
      : { tone: 'warning', text: t('patrolGpsWeak', accuracy), state: 'weak' };
  }
  if (watch.error) {
    switch (watch.error.status) {
      case 'permission_denied':
        return { tone: 'danger', text: t('patrolGpsDenied'), state: 'denied' };
      case 'timeout':
        return { tone: 'warning', text: t('patrolGpsTimeout'), state: 'timeout' };
      case 'unsupported':
        return { tone: 'danger', text: t('patrolGpsUnsupported'), state: 'unsupported' };
      case 'insecure':
        return { tone: 'danger', text: t('patrolGpsInsecure'), state: 'insecure' };
      default:
        return { tone: 'warning', text: t('patrolGpsUnavailable'), state: 'unavailable' };
    }
  }
  if (fix && fix.status === 'stale') return { tone: 'warning', text: t('patrolGpsStale'), state: 'stale' };
  return { tone: 'muted', text: t('patrolGpsWaiting'), state: 'waiting' };
}

function checkpointsLine(
  t: Translate,
  state: CheckpointsState,
  now: number | null
): { tone: Tone; text: string; detail: string | null; retry: boolean; source: string } {
  if (state.status === 'loading') return { tone: 'muted', text: t('patrolCpLoading'), detail: null, retry: false, source: 'loading' };
  if (state.status === 'error') {
    const text =
      state.reason === 'offline_no_cache' ? t('patrolCpOfflineNoCache') : t('patrolCpNetworkNoCache', state.message);
    return { tone: 'danger', text, detail: null, retry: true, source: 'error' };
  }
  const { result } = state;
  const count = result.checkpoints.filter((cp) => cp.isActive).length;
  if (result.source === 'network') {
    return { tone: 'success', text: t('patrolCpFresh', count), detail: null, retry: false, source: 'network' };
  }
  const cachedAtMs = Date.parse(result.cachedAt);
  const age = now !== null && Number.isFinite(cachedAtMs) ? ageText(t, now - cachedAtMs) : '?';
  return {
    tone: 'warning',
    text: t('patrolCpCached', count, age),
    detail: result.networkError ? t('patrolCpRefreshFailed', result.networkError) : null,
    retry: true,
    source: 'cache'
  };
}

/** GPS, screen wake lock and checkpoint-list status, each stated plainly. */
export function PatrolStatusStrip({ watch, screenAwake, checkpoints, now, onRetryCheckpoints, onSoundTest }: PatrolStatusStripProps) {
  const { t } = useTranslation();
  const gps = gpsLine(t, watch, now);
  const cps = checkpointsLine(t, checkpoints, now);

  return (
    <ul className="divide-y divide-ee-border rounded-xl border border-ee-border bg-ee-surface text-sm">
      <li className={`flex items-start gap-2 px-4 py-3 ${toneTextClass(gps.tone)}`} data-testid="patrol-gps-status" data-state={gps.state}>
        <Navigation className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{gps.text}</span>
      </li>
      <li
        className={`flex items-start gap-2 px-4 py-3 ${screenAwake ? 'text-ee-success' : 'text-ee-warning'}`}
        data-testid="patrol-screen-awake"
        data-state={screenAwake ? 'on' : 'may_sleep'}
      >
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{screenAwake ? t('patrolScreenAwake') : t('patrolScreenMaySleep')}</span>
      </li>
      <li className="px-4 py-3" data-testid="patrol-checkpoints-source" data-source={cps.source}>
        <p className={`flex items-start gap-2 ${toneTextClass(cps.tone)}`}>
          <ListChecks className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{cps.text}</span>
        </p>
        {cps.detail && <p className="ml-6 mt-1 text-xs text-ee-muted">{cps.detail}</p>}
        {cps.retry && (
          <button
            type="button"
            onClick={onRetryCheckpoints}
            data-testid="patrol-checkpoints-retry"
            className="ml-6 mt-2 inline-flex min-h-12 items-center gap-2 rounded-lg border border-ee-border px-4 font-semibold text-ee-text hover:bg-ee-surface-raised"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('patrolCpRetry')}
          </button>
        )}
      </li>
      <li className="px-4 py-2">
        <button
          type="button"
          onClick={onSoundTest}
          data-testid="patrol-sound-test"
          className="inline-flex min-h-12 items-center gap-2 rounded-lg px-2 font-semibold text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text"
        >
          <BellRing className="h-4 w-4" aria-hidden="true" />
          {t('patrolSoundTest')}
        </button>
      </li>
    </ul>
  );
}
