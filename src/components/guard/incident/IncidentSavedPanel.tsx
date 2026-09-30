'use client';

import React, { forwardRef, useState } from 'react';
import { MessageCircle, Plus, Share2 } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { buildWhatsAppLink, openWhatsAppLink } from '@/lib/whatsapp/summary';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import type { EventLocation } from '@/types/offline';
import type { IncidentSeverity } from '@/types/models';
import { RecordSyncStatus } from './RecordSyncStatus';
import type { IncidentPhoto } from './IncidentPhotoPicker';
import {
  buildIncidentMessage,
  gpsErrorLabel,
  incidentTypeLabel,
  roundedAccuracy,
  severityLabel,
  shortEventId,
  whatsAppRecipient,
  type MessageLocation
} from './incidentLogic';

/** What was actually queued (shown back to the guard; nothing here is invented). */
export interface SavedIncident {
  eventId: string;
  incidentType: string;
  severity: IncidentSeverity;
  description: string;
  reportedAt: number;
  location: EventLocation;
  messageLocation: MessageLocation | null;
  photo: IncidentPhoto | null;
  canSharePhoto: boolean;
  guardName: string | null;
  siteName: string | null;
  whatsappDispatchNumber: string | null;
}

type ShareStatus = 'idle' | 'opened' | 'unavailable' | 'share_opened' | 'share_failed';

interface IncidentSavedPanelProps {
  saved: SavedIncident;
  onReportAnother: () => void;
}

/** Confirmation after "Save report": truthful upload status, record id and optional WhatsApp share. */
export const IncidentSavedPanel = forwardRef<HTMLHeadingElement, IncidentSavedPanelProps>(function IncidentSavedPanel(
  { saved, onReportAnother },
  headingRef
) {
  const { t } = useTranslation();
  const [shareStatus, setShareStatus] = useState<ShareStatus>('idle');
  const recipient = whatsAppRecipient(saved.whatsappDispatchNumber);
  const accuracy = roundedAccuracy(saved.location.accuracyMeters);
  const hasFix = typeof saved.location.latitude === 'number' && typeof saved.location.longitude === 'number';

  const messageText = () =>
    buildIncidentMessage(
      {
        incidentType: saved.incidentType,
        severity: saved.severity,
        description: saved.description,
        guardName: saved.guardName,
        siteName: saved.siteName,
        reportedAt: saved.reportedAt,
        location: saved.messageLocation,
        recordId: saved.eventId,
        nowMs: Date.now()
      },
      t
    );

  const shareOnWhatsApp = () => {
    const url = buildWhatsAppLink(recipient.kind === 'ok' ? recipient.digits : null, messageText());
    setShareStatus(openWhatsAppLink(url) === 'unavailable' ? 'unavailable' : 'opened');
  };

  const shareWithPhoto = async () => {
    if (!saved.photo) return;
    const file = new File([saved.photo.blob], `incident-${shortEventId(saved.eventId)}.jpg`, {
      type: saved.photo.blob.type || 'image/jpeg'
    });
    try {
      await navigator.share({ files: [file], text: messageText() });
      setShareStatus('share_opened');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShareStatus('share_failed');
    }
  };

  const shareMessage: Record<Exclude<ShareStatus, 'idle'>, { text: string; tone: string }> = {
    opened: { text: t('incident.wa.opened'), tone: 'text-ee-text' },
    unavailable: { text: t('incident.wa.unavailable'), tone: 'text-ee-danger' },
    share_opened: { text: t('incident.wa.shareOpened'), tone: 'text-ee-text' },
    share_failed: { text: t('incident.wa.shareFailed'), tone: 'text-ee-danger' }
  };

  const details: Array<[string, string]> = [
    [t('incident.field.type'), incidentTypeLabel(saved.incidentType, t)],
    [t('incident.field.severity'), severityLabel(saved.severity, t)],
    [t('incident.field.time'), `${sastDateString(saved.reportedAt)} ${sastTimeHM(saved.reportedAt)}`],
    [
      t('incident.field.location'),
      hasFix
        ? accuracy !== null
          ? t('incident.gps.ok', accuracy)
          : t('incident.gps.weak', '?')
        : t('incident.gps.none', gpsErrorLabel(saved.location.gpsError, t))
    ],
    [t('incident.field.photo'), saved.photo ? t('incident.field.attached') : t('incident.field.none')]
  ];

  return (
    <section
      aria-labelledby="incident-saved-title"
      className="rounded-2xl border border-ee-border bg-ee-surface"
      data-testid="incident-result"
    >
      <div className="space-y-3 p-4">
        <h1
          id="incident-saved-title"
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-2xl font-bold text-ee-text focus:outline-none"
        >
          {t('incident.done.title')}
        </h1>
        <RecordSyncStatus eventId={saved.eventId} testIdPrefix="incident-result" />
        <p className="font-mono text-base text-ee-muted" data-testid="incident-result-id">
          {t('incident.recordId', shortEventId(saved.eventId))}
        </p>
      </div>

      <dl className="divide-y divide-ee-border border-t border-ee-border">
        {details.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-base text-ee-muted">{label}</dt>
            <dd className="min-w-0 break-words text-right text-base font-semibold text-ee-text">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3 border-t border-ee-border p-4">
        {recipient.kind !== 'ok' && (
          <p className="text-sm text-ee-warning" data-testid="incident-whatsapp-note">
            {recipient.kind === 'missing' ? t('incident.wa.noNumber') : t('incident.wa.badNumber')}
          </p>
        )}
        <button
          type="button"
          onClick={shareOnWhatsApp}
          data-testid="incident-whatsapp-share"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
        >
          <MessageCircle className="h-5 w-5 text-ee-success" aria-hidden="true" />
          {t('incident.wa.share')}
        </button>
        {saved.photo && saved.canSharePhoto && (
          <button
            type="button"
            onClick={() => void shareWithPhoto()}
            data-testid="incident-share-photo"
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
          >
            <Share2 className="h-5 w-5" aria-hidden="true" />
            {t('incident.wa.sharePhoto')}
          </button>
        )}
        <p role="status" aria-live="polite" className="min-h-5 text-sm" data-testid="incident-whatsapp-status">
          {shareStatus !== 'idle' ? (
            <span className={shareMessage[shareStatus].tone}>{shareMessage[shareStatus].text}</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={onReportAnother}
          data-testid="incident-new"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-ee-primary px-4 text-base font-bold text-ee-on-primary hover:bg-ee-primary-strong"
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
          {t('incident.another')}
        </button>
      </div>
    </section>
  );
});
