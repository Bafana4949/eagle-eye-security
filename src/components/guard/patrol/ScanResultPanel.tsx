'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, MapPin, RefreshCw, UploadCloud, XCircle } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import { confidenceTone, syncTone, toneTextClass, type ShiftScan } from './patrolLogic';
import { confidenceText, methodText, syncText, type Translate } from './patrolText';
import type { ScanOutcome } from './usePatrolScanner';

interface ScanResultPanelProps {
  outcome: ScanOutcome | null;
  outcomeSeq: number;
  /** This shift's scans (upload state of the recorded scan is looked up here). */
  scans: ReadonlyArray<ShiftScan>;
  onRetryUpload: () => void;
  retrying: boolean;
}

function problemText(t: Translate, outcome: Extract<ScanOutcome, { kind: 'rejected' | 'error' }>): string {
  if (outcome.kind === 'rejected') {
    switch (outcome.reason) {
      case 'unknown_tag':
        return t('patrolUnknownTag');
      case 'unknown_qr':
        return outcome.notCheckpointCard ? t('patrolNotCheckpointQr') : t('patrolUnknownQr');
      case 'legacy_disabled':
        return t('patrolLegacyDisabled');
      case 'inactive':
        return t('patrolInactive', outcome.checkpointName);
    }
  }
  switch (outcome.reason) {
    case 'no_shift':
      return t('patrolShiftGone');
    case 'no_checkpoints':
      return t('patrolNoCheckpointsYet');
    case 'crypto':
      return t('patrolCryptoUnavailable');
    case 'save_failed':
      return t('patrolSaveFailed', outcome.message);
  }
}

function statusKey(outcome: ScanOutcome): string {
  if (outcome.kind === 'busy') return `busy_${outcome.stage}`;
  if (outcome.kind === 'rejected' || outcome.kind === 'error') return outcome.reason;
  return outcome.kind;
}

/**
 * The result of the latest scan, announced to screen readers. A recorded scan shows the phone's
 * GPS estimate (never a "verified" banner unless the estimate is 'verified') and its real upload
 * state from the sync queue.
 */
export function ScanResultPanel({ outcome, outcomeSeq, scans, onRetryUpload, retrying }: ScanResultPanelProps) {
  const { t } = useTranslation();

  let body: React.ReactNode = null;
  if (outcome?.kind === 'busy') {
    body = (
      <p className="flex items-center gap-2 text-ee-muted">
        <Loader2 className="h-5 w-5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
        <span>{outcome.stage === 'checking' ? t('patrolChecking') : t('patrolGettingGps', outcome.checkpointName)}</span>
      </p>
    );
  } else if (outcome?.kind === 'duplicate') {
    body = (
      <p className="flex items-start gap-2 text-ee-warning">
        <Clock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{t('patrolDuplicate', outcome.checkpointName, formatTimeHM(outcome.lastAtMs))}</span>
      </p>
    );
  } else if (outcome?.kind === 'rejected' || outcome?.kind === 'error') {
    body = (
      <p role="alert" className="flex items-start gap-2 font-semibold text-ee-danger">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{problemText(t, outcome)}</span>
      </p>
    );
  } else if (outcome?.kind === 'recorded') {
    const stored = scans.find((scan) => scan.id === outcome.eventId);
    // enqueue() resolved, so the scan is at least queued on this phone.
    const syncState = stored?.syncState ?? 'pending';
    const lastError = stored?.lastError ?? null;
    const atMs = stored?.atMs ?? outcome.atMs;
    const { assessment } = outcome;
    const gpsTone = confidenceTone(assessment.confidence);
    const syncClass = toneTextClass(syncTone(syncState));
    body = (
      <div className="space-y-2">
        <p className="flex items-start gap-2 font-display text-xl font-semibold leading-tight text-ee-text" data-testid="patrol-result-checkpoint">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-ee-text" aria-hidden="true" />
          <span>{t('patrolRecorded', outcome.checkpointName, formatTimeHM(atMs))}</span>
        </p>
        <p className="text-sm text-ee-muted">{methodText(t, outcome.method, outcome.payloadType)}</p>
        <div data-testid="patrol-result-gps" data-confidence={assessment.confidence}>
          <p className={`flex items-start gap-2 font-semibold ${toneTextClass(gpsTone)}`}>
            {gpsTone === 'danger' || gpsTone === 'warning' ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <MapPin className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span>
              {confidenceText(t, assessment.confidence, assessment.distanceMeters, assessment.accuracyMeters, outcome.gpsError)}
            </span>
          </p>
          <p className="ml-7 text-xs text-ee-muted">{t('patrolGpsEstimate')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p
            className={`flex items-start gap-2 text-sm font-semibold ${syncClass}`}
            data-testid="patrol-result-sync"
            data-sync={syncState}
          >
            <UploadCloud className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{syncText(t, syncState, lastError)}</span>
          </p>
          {syncState === 'failed' && (
            <button
              type="button"
              onClick={onRetryUpload}
              disabled={retrying}
              data-testid="patrol-result-retry"
              className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-ee-border bg-ee-surface px-4 font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${retrying ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
              {t('patrolSyncRetry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-live="polite"
      aria-atomic="true"
      data-testid="patrol-result"
      data-seq={outcomeSeq}
      className={outcome ? 'rounded-xl border border-ee-border bg-ee-surface p-4' : 'sr-only'}
    >
      {outcome && (
        <div data-testid="patrol-result-status" data-status={statusKey(outcome)}>
          {body}
        </div>
      )}
    </section>
  );
}
