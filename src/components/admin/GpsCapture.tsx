'use client';

/**
 * "Use this phone's location" for site / checkpoint coordinates. Takes one fresh high-accuracy
 * fix (no cached watch, no coarse fallback). A fix worse than ±30 m is only used after the admin
 * confirms it; failures are shown as they are.
 */
import React, { useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getLocationFix, type LocationFixResult } from '@/lib/gps/location';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { GPS_ACCEPTABLE_ACCURACY_M } from './validation';
import { Notice } from './ui';

export interface CapturedFix {
  latitude: number;
  longitude: number;
  accuracy: number;
}

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'locating' }
  | { phase: 'poor'; fix: CapturedFix }
  | { phase: 'captured'; fix: CapturedFix }
  | { phase: 'failed'; key: TranslationKey };

const FAILURE_KEYS: Record<string, TranslationKey> = {
  permission_denied: 'admGpsDenied',
  timeout: 'admGpsTimeout',
  unavailable: 'admGpsUnavailable',
  unsupported: 'admGpsUnsupported',
  insecure: 'admGpsInsecure',
  stale: 'admGpsStale'
};

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function GpsCapture({ onCapture, testIdPrefix }: { onCapture: (fix: CapturedFix) => void; testIdPrefix: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CaptureState>({ phase: 'idle' });
  const requestSeq = useRef(0);

  const locate = () => {
    const seq = ++requestSeq.current;
    setState({ phase: 'locating' });
    void getLocationFix({ maxAgeMs: 5000, timeoutMs: 20000, highAccuracy: true, coarseRetry: false, watch: null }).then(
      (result: LocationFixResult) => {
        if (seq !== requestSeq.current) return;
        if (result.status !== 'ok') {
          setState({ phase: 'failed', key: FAILURE_KEYS[result.status] ?? 'admGpsUnavailable' });
          return;
        }
        if (!Number.isFinite(result.accuracy)) {
          setState({ phase: 'failed', key: 'admGpsNoAccuracy' });
          return;
        }
        const fix: CapturedFix = {
          latitude: round6(result.latitude),
          longitude: round6(result.longitude),
          accuracy: Math.round(result.accuracy)
        };
        if (fix.accuracy > GPS_ACCEPTABLE_ACCURACY_M) {
          setState({ phase: 'poor', fix });
          return;
        }
        onCapture(fix);
        setState({ phase: 'captured', fix });
      }
    );
  };

  const acceptPoor = () => {
    if (state.phase !== 'poor') return;
    onCapture(state.fix);
    setState({ phase: 'captured', fix: state.fix });
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        className="min-h-12 w-full sm:w-auto gap-2"
        onClick={locate}
        disabled={state.phase === 'locating'}
        data-testid={`${testIdPrefix}-gps`}
      >
        <Crosshair className="h-4 w-4" aria-hidden />
        <span>{state.phase === 'locating' ? t('admGpsLocating') : t('admGpsUseHere')}</span>
      </Button>
      <div aria-live="polite" data-testid={`${testIdPrefix}-gps-status`}>
        {state.phase === 'captured' && (
          <Notice tone="success">{t('admGpsCaptured', state.fix.latitude.toFixed(6), state.fix.longitude.toFixed(6), state.fix.accuracy)}</Notice>
        )}
        {state.phase === 'poor' && (
          <Notice tone="warning" title={t('admGpsPoorTitle', state.fix.accuracy, GPS_ACCEPTABLE_ACCURACY_M)}>
            <p>{t('admGpsPoorBody')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" className="min-h-12" onClick={locate} data-testid={`${testIdPrefix}-gps-retry`}>
                {t('admGpsTryAgain')}
              </Button>
              <Button type="button" variant="outline" className="min-h-12" onClick={acceptPoor} data-testid={`${testIdPrefix}-gps-accept`}>
                {t('admGpsUseAnyway')}
              </Button>
            </div>
          </Notice>
        )}
        {state.phase === 'failed' && <Notice tone="danger">{t(state.key)}</Notice>}
      </div>
    </div>
  );
}
