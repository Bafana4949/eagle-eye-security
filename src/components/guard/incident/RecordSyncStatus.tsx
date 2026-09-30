'use client';

import React, { useState } from 'react';
import { CircleAlert, CircleCheck, Clock, CloudOff, LoaderCircle, RotateCcw } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { syncEngine } from '@/lib/offline/sync';
import { useQueuedEventStatus } from './useQueuedEventStatus';
import { RECORD_STATUS_KEYS, deriveRecordStatus, recordStatusTone, type RecordStatus } from './incidentLogic';

export const TONE_TEXT: Record<ReturnType<typeof recordStatusTone>, string> = {
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger',
  muted: 'text-ee-muted'
};

export function RecordStatusIcon({ status, className = 'h-6 w-6' }: { status: RecordStatus; className?: string }) {
  const common = `${className} shrink-0`;
  switch (status) {
    case 'received':
      return <CircleCheck className={common} aria-hidden="true" />;
    case 'failed':
      return <CircleAlert className={common} aria-hidden="true" />;
    case 'uploading':
    case 'loading':
      return <LoaderCircle className={`${common} animate-spin motion-reduce:animate-none`} aria-hidden="true" />;
    case 'queued_offline':
      return <CloudOff className={common} aria-hidden="true" />;
    default:
      return <Clock className={common} aria-hidden="true" />;
  }
}

/**
 * Truthful upload status of one record saved on this phone: "Saved on this phone …" until the sync
 * engine reports the queue item synced, then "Received by server". Failures show the server's
 * error and a retry button.
 */
export function RecordSyncStatus({ eventId, testIdPrefix }: { eventId: string; testIdPrefix: string }) {
  const { t } = useTranslation();
  const queued = useQueuedEventStatus(eventId);
  const status = deriveRecordStatus(queued);
  const tone = TONE_TEXT[recordStatusTone(status)];
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    if (!syncEngine) return;
    setRetrying(true);
    try {
      // retryFailed re-queues this user's dead-lettered items and starts a pass itself; a pass
      // for a pending item is started without waiting for it (it may upload photos).
      if (status === 'failed') await syncEngine.retryFailed();
      else void syncEngine.triggerSync({ force: true }).catch(() => undefined);
    } catch {
      // The status line keeps showing the real state and error.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-2">
      <p
        role="status"
        aria-live="polite"
        data-testid={`${testIdPrefix}-status`}
        data-status={status}
        className={`flex items-start gap-2 text-base font-semibold ${tone}`}
      >
        <RecordStatusIcon status={status} />
        <span>{t(RECORD_STATUS_KEYS[status])}</span>
      </p>
      {queued.lastError && status !== 'received' && (
        <p className="break-words text-sm text-ee-muted" data-testid={`${testIdPrefix}-error`}>
          {t('incident.status.lastError', queued.lastError)}
        </p>
      )}
      {(status === 'failed' || status === 'retrying') && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          data-testid={`${testIdPrefix}-retry`}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
        >
          <RotateCcw className="h-5 w-5" aria-hidden="true" />
          {t('incident.status.retry')}
        </button>
      )}
    </div>
  );
}
