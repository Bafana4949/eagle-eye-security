'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CircleCheck, CloudUpload, MessageCircle, Plus, RefreshCw, Share2, Smartphone, TriangleAlert } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { GateEntryPayload } from '@/types/offline';
import { syncEngine } from '@/lib/offline/sync';
import { sastDateString } from '@/lib/config/siteTime';
import { formatDuration } from '@/features/shifts/shiftCalculator';
import { buildWhatsAppLink, normalizeSouthAfricanMobile, openWhatsAppLink } from '@/lib/whatsapp/summary';
import { formatGateWhatsAppText, type GateEntryMethod } from './gateLogic';
import { useQueueItemStatus } from './useQueueItemStatus';
import { noticeClass, primaryButtonClass, secondaryButtonClass } from './styles';

export interface SavedGateEntry {
  /** Queue event id = server row id. */
  eventId: string;
  payload: GateEntryPayload;
  method: GateEntryMethod;
  /** Device time of the entry (epoch ms). */
  recordedAt: number;
  photo: Blob | null;
}

interface GateResultPanelProps {
  saved: SavedGateEntry;
  guardName: string;
  siteName: string | null;
  /** activeSite.whatsappDispatchNumber of the shift's site (from the database). */
  whatsappNumber: string | null | undefined;
  onNewEntry: () => void;
}

type HandOff = 'idle' | 'opened' | 'unavailable';

/**
 * After a save: the entry's real upload state (queued on the phone → received by server, or the
 * server's rejection), the time on site for an OUT, and the optional WhatsApp hand-off, which is
 * only ever "opened" — the guard presses Send in WhatsApp.
 */
export function GateResultPanel({ saved, guardName, siteName, whatsappNumber, onNewEntry }: GateResultPanelProps) {
  const { t } = useTranslation();
  const status = useQueueItemStatus(saved.eventId);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [whatsApp, setWhatsApp] = useState<HandOff>('idle');
  const [share, setShare] = useState<HandOff>('idle');
  const [shareSupported] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function');

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const p = saved.payload;
  const isOut = p.direction === 'out';
  const expired = !!p.discExpiryDate && p.discExpiryDate < sastDateString(saved.recordedAt);
  const recipient = normalizeSouthAfricanMobile(whatsappNumber ?? null);

  const messageText = () =>
    formatGateWhatsAppText(
      { payload: p, method: saved.method, guardName, siteName, recordedAt: saved.recordedAt },
      t
    );

  const openWhatsApp = () => {
    const text = messageText();
    let url: string;
    try {
      url = buildWhatsAppLink(recipient.ok ? recipient.digits : null, text);
    } catch {
      url = buildWhatsAppLink(null, text);
    }
    setWhatsApp(openWhatsAppLink(url) === 'unavailable' ? 'unavailable' : 'opened');
  };

  const sharePhoto = async () => {
    if (!saved.photo) return;
    try {
      const file = new File([saved.photo], `vehicle-${p.licensePlate}.jpg`, { type: saved.photo.type || 'image/jpeg' });
      if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
        setShare('unavailable');
        return;
      }
      await navigator.share({ files: [file], text: messageText() });
      setShare('opened');
    } catch (error) {
      // The guard closing the share sheet is not an error.
      if (error instanceof Error && error.name === 'AbortError') return;
      setShare('unavailable');
    }
  };

  const uploading = status.state === 'syncing' || (status.state === 'pending' && status.isSyncing && status.isOnline);
  // Online, but the last attempt was refused or failed: say so instead of "will upload when online".
  const retrying = !uploading && status.state === 'pending' && status.isOnline && !!status.lastError;
  let statusView: React.ReactNode;
  if (status.state === 'synced') {
    statusView = (
      <p className={`flex items-start gap-2 ${noticeClass.success}`}>
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('gateStatusSynced')}</span>
      </p>
    );
  } else if (status.state === 'failed') {
    statusView = (
      <div className={noticeClass.danger}>
        <p className="flex items-start gap-2 font-semibold">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('gateStatusFailed')}</span>
        </p>
        {status.lastError && <p className="mt-1 break-words">{t('gateStatusReason', status.lastError)}</p>}
      </div>
    );
  } else {
    statusView = (
      <div className={noticeClass.warning}>
        <p className="flex items-start gap-2">
          {uploading ? (
            <CloudUpload className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            {uploading ? t('gateStatusUploading') : retrying ? t('gateStatusRetrying') : t('gateStatusQueued')}
          </span>
        </p>
        {status.lastError && <p className="mt-1 break-words text-ee-muted">{t('gateStatusReason', status.lastError)}</p>}
      </div>
    );
  }

  return (
    <section aria-labelledby="gate-result-heading" data-testid="gate-result" className="space-y-3">
      <h2
        id="gate-result-heading"
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-2xl font-bold uppercase tracking-wide break-words text-ee-text"
      >
        {t(isOut ? 'gateSavedOut' : 'gateSavedIn', p.licensePlate)}
      </h2>

      <div role="status" aria-live="polite" data-testid="gate-result-status" data-sync-state={status.state ?? 'unknown'}>
        {statusView}
      </div>

      {status.state === 'failed' && (
        <button
          type="button"
          onClick={() => void syncEngine?.retryFailed()}
          data-testid="gate-result-retry"
          className={secondaryButtonClass}
        >
          <RefreshCw className="h-5 w-5" aria-hidden="true" />
          <span>{t('gateRetry')}</span>
        </button>
      )}
      {status.state === 'pending' && status.isOnline && !uploading && (
        <button
          type="button"
          onClick={() => void syncEngine?.triggerSync({ force: true })}
          data-testid="gate-result-upload-now"
          className={secondaryButtonClass}
        >
          <CloudUpload className="h-5 w-5" aria-hidden="true" />
          <span>{t('gateUploadNow')}</span>
        </button>
      )}

      <dl className="divide-y divide-ee-border rounded-lg border border-ee-border bg-ee-surface text-sm">
        {isOut && (
          <div className="px-3 py-2" data-testid="gate-result-dwell">
            {p.linkedEntryId && typeof p.dwellDurationSeconds === 'number'
              ? t('gateDwell', formatDuration(p.dwellDurationSeconds * 1000))
              : t('gateDwellUnknown')}
          </div>
        )}
        {p.discExpiryDate && (
          <div className={`px-3 py-2 ${expired ? 'font-bold text-ee-danger' : ''}`} data-testid="gate-result-expiry">
            {t('gateDiscExpiry')}: {p.discExpiryDate}
            {expired && ` – ${t('gateDiscExpired')}`}
          </div>
        )}
        {(p.latitude === null || p.latitude === undefined) && (
          <div className="px-3 py-2 text-ee-muted" data-testid="gate-result-nogps">
            {t('gateMsgNoGps')}
          </div>
        )}
        <div className="px-3 py-2 text-ee-muted">
          {t(saved.method === 'disc' ? 'gateMsgViaDisc' : saved.method === 'list' ? 'gateMsgViaList' : 'gateMsgViaManual')}
        </div>
      </dl>

      <div className="space-y-2">
        {!recipient.ok && (
          <p data-testid="gate-whatsapp-no-number" className={noticeClass.info}>
            {t('gateWhatsAppNoNumber')}
          </p>
        )}
        <button type="button" onClick={openWhatsApp} data-testid="gate-whatsapp" className={secondaryButtonClass}>
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          <span>{recipient.ok ? t('gateWhatsApp') : t('gateWhatsAppChooseChat')}</span>
        </button>
        {saved.photo && shareSupported && (
          <button type="button" onClick={() => void sharePhoto()} data-testid="gate-share-photo" className={secondaryButtonClass}>
            <Share2 className="h-5 w-5" aria-hidden="true" />
            <span>{t('gateSharePhoto')}</span>
          </button>
        )}
        <p role="status" aria-live="polite" data-testid="gate-whatsapp-status" className="min-h-5 text-sm">
          {whatsApp === 'opened' && <span className="text-ee-text">{t('gateWhatsAppOpened')}</span>}
          {whatsApp === 'unavailable' && <span className="text-ee-danger">{t('gateWhatsAppUnavailable')}</span>}
          {share === 'opened' && <span className="block text-ee-text">{t('gateShareOpened')}</span>}
          {share === 'unavailable' && <span className="block text-ee-danger">{t('gateShareUnavailable')}</span>}
        </p>
      </div>

      <button type="button" onClick={onNewEntry} data-testid="gate-new-entry" className={primaryButtonClass}>
        <Plus className="h-5 w-5" aria-hidden="true" />
        <span>{t('gateNewEntry')}</span>
      </button>
    </section>
  );
}
