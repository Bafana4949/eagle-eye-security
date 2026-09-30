'use client';

import React, { useRef, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  CloudOff,
  LoaderCircle,
  MessageCircle,
  Phone,
  RotateCcw,
  type LucideIcon
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { syncEngine } from '@/lib/offline/sync';
import { sastTimeHM } from '@/lib/config/siteTime';
import { buildWhatsAppLink, openWhatsAppLink } from '@/lib/whatsapp/summary';
import type { EventLocation } from '@/types/offline';
import type { GpsErrorKind, Site } from '@/types/models';
import { useModalFocus } from './useModalFocus';
import { useQueuedEventStatus } from './useQueuedEventStatus';
import { usePanicAcknowledgement } from './usePanicAcknowledgement';
import {
  buildPanicMessage,
  deriveSosStage,
  gpsErrorLabel,
  newestLocation,
  policeNumber,
  roundedAccuracy,
  shortEventId,
  telHref,
  whatsAppRecipient,
  type MessageLocation,
  type PanicMessageInput,
  type SosStage,
  type Translate
} from './incidentLogic';

/** One raised SOS as this phone knows it. Only real values: nothing is filled in "for show". */
export interface RaisedPanic {
  /** Local key of this SOS (guards async updates of an older SOS). */
  key: number;
  triggeredAt: number;
  /** Queue/event id (= panic_alerts.id / offline_uuid) once stored on this phone. */
  eventId: string | null;
  /** Why storing on this phone failed (nothing was queued). */
  saveError: string | null;
  /** Site the alert was recorded for (its phone numbers are used). */
  site: Site | null;
  /** Location stored with the alert (last fresh fix at the moment of the SOS, or none). */
  savedLocation: EventLocation;
  savedMessageLocation: MessageLocation | null;
  /** Fresh fix requested after the SOS, used only for the WhatsApp text. */
  fresh: { phase: 'finding' | 'done'; location: MessageLocation | null; error: GpsErrorKind | null };
}

interface SosPanicScreenProps {
  panic: RaisedPanic;
  guardName: string | null;
  onClose: () => void;
}

type WhatsAppStatus = 'idle' | 'opened' | 'unavailable';

const STAGE_ICON: Record<SosStage, LucideIcon> = {
  saving: LoaderCircle,
  save_failed: CircleAlert,
  queued: Clock,
  submitted: CircleCheck,
  acknowledged: CircleCheck,
  failed: CircleAlert
};

/** Builds the SOS text at the moment of the tap (position age is measured now) and opens WhatsApp. */
function openPanicWhatsApp(
  input: Omit<PanicMessageInput, 'nowMs'>,
  recipientDigits: string | null,
  t: Translate
): ReturnType<typeof openWhatsAppLink> {
  const text = buildPanicMessage({ ...input, nowMs: Date.now() }, t);
  return openWhatsAppLink(buildWhatsAppLink(recipientDigits, text));
}

/**
 * Full-screen panic panel (reference app: dark red panel with WhatsApp and call buttons).
 * Status is live and truthful: queued on this phone → submitted (sync engine reports the queue
 * item synced) → acknowledged (panic_alerts row). Out-of-band help (WhatsApp, phone) is always
 * offered, whatever the status. Escape does not close it; the guard closes it explicitly.
 */
export function SosPanicScreen({ panic, guardName, onClose }: SosPanicScreenProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>('idle');
  const [retrying, setRetrying] = useState(false);

  useModalFocus(true, containerRef, { initialFocusRef: headingRef });

  const queued = useQueuedEventStatus(panic.eventId);
  const { acknowledgement } = usePanicAcknowledgement(
    panic.eventId,
    panic.site?.id ?? null,
    queued.syncState === 'synced'
  );
  const stage = deriveSosStage({
    eventId: panic.eventId,
    saveError: panic.saveError,
    syncState: queued.syncState,
    acknowledgement
  });

  const site = panic.site;
  const recipient = whatsAppRecipient(site?.whatsappDispatchNumber);
  const controlHref = telHref(site?.emergencyPhone);
  const police = policeNumber(site?.policePhone);
  const policeHref = telHref(police.number);
  const savedAccuracy = roundedAccuracy(panic.savedLocation.accuracyMeters);
  const hasSavedFix = typeof panic.savedLocation.latitude === 'number' && typeof panic.savedLocation.longitude === 'number';
  const messageLocation = newestLocation(panic.savedMessageLocation, panic.fresh.location);

  let headline: string;
  let detail: string | null = null;
  switch (stage) {
    case 'saving':
      headline = t('incident.sos.status.saving');
      break;
    case 'save_failed':
      headline = t('incident.sos.status.saveFailed', panic.saveError ?? '');
      break;
    case 'queued':
      headline = t('incident.sos.status.queued');
      detail = !queued.isOnline
        ? t('incident.sos.status.queuedOffline')
        : queued.lastError
          ? t('incident.sos.status.retrying')
          : t('incident.sos.status.sending');
      break;
    case 'submitted':
      headline = t('incident.sos.status.submitted');
      detail = t('incident.sos.status.waitingAck');
      break;
    case 'acknowledged': {
      const at = acknowledgement?.acknowledgedAt ? sastTimeHM(acknowledgement.acknowledgedAt) : '–';
      headline = acknowledgement?.acknowledgedByName
        ? t('incident.sos.status.ackBy', acknowledgement.acknowledgedByName, at)
        : t('incident.sos.status.ackAt', at);
      detail = acknowledgement?.status === 'resolved' ? t('incident.sos.status.resolvedNote') : null;
      break;
    }
    case 'failed':
      headline = t('incident.sos.status.failed');
      break;
  }
  const StageIcon = stage === 'queued' && !queued.isOnline ? CloudOff : STAGE_ICON[stage];

  const sendWhatsApp = () => {
    const how = openPanicWhatsApp(
      {
        guardName,
        siteName: site?.name ?? null,
        triggeredAt: panic.triggeredAt,
        location: messageLocation,
        alertId: panic.eventId
      },
      recipient.kind === 'ok' ? recipient.digits : null,
      t
    );
    setWaStatus(how === 'unavailable' ? 'unavailable' : 'opened');
  };

  const retry = async () => {
    if (!syncEngine) return;
    setRetrying(true);
    try {
      if (stage === 'failed') await syncEngine.retryFailed();
      else await syncEngine.sendPanicsNow();
    } catch {
      // The status keeps showing the real state.
    } finally {
      setRetrying(false);
    }
  };

  const showRetry = stage === 'failed' || (stage === 'queued' && queued.isOnline && !!queued.lastError);
  const whiteButton =
    'flex w-full items-center justify-center gap-3 rounded-xl bg-ee-on-danger px-4 text-center font-semibold text-ee-sos-deep hover:bg-ee-text disabled:opacity-60';

  return (
    <div
      ref={containerRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sos-panic-title"
      aria-describedby="sos-panic-status"
      tabIndex={-1}
      data-testid="sos-panic-screen"
      className="fixed inset-0 z-50 overflow-y-auto bg-ee-sos-deep text-ee-on-danger focus:outline-none"
    >
      <div
        className="mx-auto w-full max-w-md space-y-5 px-4 pb-8"
        style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <div>
          <h2
            id="sos-panic-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-4xl font-bold uppercase leading-tight focus:outline-none"
          >
            {t('incident.sos.raisedTitle')}
          </h2>
          <p className="text-lg">{t('incident.sos.raisedAt', sastTimeHM(panic.triggeredAt))}</p>
          {panic.eventId && (
            <p className="font-mono text-base" data-testid="sos-alert-id">
              {t('incident.sos.alertId', shortEventId(panic.eventId))}
            </p>
          )}
        </div>

        <div
          id="sos-panic-status"
          role="status"
          aria-live="polite"
          data-testid="sos-status"
          data-status={stage}
          className="space-y-2 rounded-xl border-2 border-ee-on-danger/60 p-4"
        >
          <p className="flex items-start gap-3 text-xl font-bold">
            <StageIcon
              className={`mt-0.5 h-7 w-7 shrink-0 ${stage === 'saving' ? 'animate-spin motion-reduce:animate-none' : ''}`}
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{headline}</span>
          </p>
          {detail && <p className="text-base">{detail}</p>}
          {queued.lastError && stage !== 'submitted' && stage !== 'acknowledged' && (
            <p className="break-words text-sm" data-testid="sos-status-error">
              {t('incident.status.lastError', queued.lastError)}
            </p>
          )}
          {showRetry && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              data-testid="sos-retry"
              className="mt-1 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-ee-on-danger px-4 text-base font-semibold hover:bg-ee-sos disabled:opacity-60"
            >
              <RotateCcw className="h-5 w-5" aria-hidden="true" />
              {t('incident.sos.retry')}
            </button>
          )}
        </div>

        <div className="space-y-1 text-base">
          {/* Only once the alert is really stored on this phone. */}
          {panic.eventId && (
            <p data-testid="sos-location-saved">
              {hasSavedFix
                ? t('incident.sos.loc.withAlert', savedAccuracy ?? '?')
                : t('incident.sos.loc.noneWithAlert')}
            </p>
          )}
          <p data-testid="sos-location-whatsapp" data-status={panic.fresh.phase}>
            {panic.fresh.phase === 'finding' && !messageLocation
              ? t('incident.sos.loc.waFinding')
              : messageLocation
                ? t('incident.sos.loc.waReady', roundedAccuracy(messageLocation.accuracyMeters) ?? '?')
                : t('incident.sos.loc.waNone', gpsErrorLabel(panic.fresh.error ?? panic.savedLocation.gpsError, t))}
          </p>
        </div>

        <div className="space-y-3">
          {recipient.kind !== 'ok' && (
            <p className="text-base font-semibold" data-testid="sos-whatsapp-note">
              {recipient.kind === 'missing' ? t('incident.sos.wa.noNumber') : t('incident.sos.wa.badNumber')}
            </p>
          )}
          <button
            type="button"
            onClick={sendWhatsApp}
            data-testid="sos-whatsapp-send"
            className={`${whiteButton} min-h-16 text-xl`}
          >
            <MessageCircle className="h-6 w-6 shrink-0" aria-hidden="true" />
            {recipient.kind === 'ok' ? t('incident.sos.wa.send') : t('incident.sos.wa.chooseChat')}
          </button>
          <p role="status" aria-live="polite" className="min-h-6 text-base" data-testid="sos-whatsapp-status">
            {waStatus === 'opened' ? t('incident.wa.opened') : waStatus === 'unavailable' ? t('incident.wa.unavailable') : ''}
          </p>

          {/* The inner span carries the colour: globals.css styles bare <a> outside the utility layer. */}
          {controlHref ? (
            <a href={controlHref} data-testid="sos-call-control" className={`${whiteButton} min-h-14 text-lg no-underline`}>
              <span className="flex items-center gap-3 text-ee-sos-deep">
                <Phone className="h-6 w-6 shrink-0" aria-hidden="true" />
                {t('incident.sos.call.control')}
              </span>
            </a>
          ) : (
            <p className="text-base" data-testid="sos-call-control-missing">
              {t('incident.sos.call.controlMissing')}
            </p>
          )}

          {policeHref && (
            <a href={policeHref} data-testid="sos-call-police" className={`${whiteButton} min-h-14 text-lg no-underline`}>
              <span className="flex items-center gap-3 text-ee-sos-deep">
                <Phone className="h-6 w-6 shrink-0" aria-hidden="true" />
                {t('incident.sos.call.police', police.number)}
              </span>
            </a>
          )}
          {police.isNationalFallback && (
            <p className="text-sm" data-testid="sos-police-fallback">
              {t('incident.sos.call.policeFallback')}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          data-testid="sos-close"
          className="flex min-h-14 w-full items-center justify-center rounded-xl border-2 border-ee-on-danger bg-transparent px-4 text-lg font-semibold text-ee-on-danger hover:bg-ee-sos"
        >
          {t('incident.sos.close')}
        </button>
      </div>
    </div>
  );
}
