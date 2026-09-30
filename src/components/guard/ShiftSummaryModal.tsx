'use client';

/**
 * End-of-shift (or current-shift) WhatsApp summary.
 *
 * Every figure comes from the records stored on this phone for that shift (Dexie localEvents),
 * the site's checkpoint list and the site's round interval, through the foundation
 * computeShiftStats / formatWhatsAppShiftSummary. Nothing is defaulted or invented.
 * The app can only PREPARE the text and OPEN WhatsApp; it cannot know whether the guard pressed
 * Send, so the status never says "sent" or "delivered".
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import Dexie from 'dexie';
import { AlertTriangle, ClipboardCopy, Loader2, MessageCircle, X } from 'lucide-react';
import type { GpsConfidence, ShiftType, Site, VehicleDirection } from '@/types/models';
import type { CheckpointScanPayload, GateEntryPayload, ShiftStartPayload } from '@/types/offline';
import { offlineDB, type EagleEyeOfflineDB, type LocalEventRecord } from '@/lib/offline/db';
import { loadCheckpoints } from '@/lib/data/checkpoints';
import {
  buildWhatsAppLink,
  computeShiftStats,
  copySummaryToClipboard,
  formatWhatsAppShiftSummary,
  normalizeSouthAfricanMobile,
  openWhatsAppLink
} from '@/lib/whatsapp/summary';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import { sastDateString } from '@/lib/config/siteTime';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { trapFocusWithin } from '@/components/shared/CameraCaptureModal';

/** A shift as the summary needs it (from the active-shift record or the phone's clock-in/out events). */
export interface SummaryShift {
  shiftId: string;
  siteId: string;
  shiftType: ShiftType;
  /** ISO times of the schedule the shift was started with. */
  scheduledStart: string;
  scheduledEnd: string;
  /** Clock-in time; null when not known on this phone. */
  startedAt: string | null;
  /** Clock-out time; null while the shift is running. */
  endedAt: string | null;
}

export interface ShiftEventGroups {
  scans: Array<{ id: string; checkpointId: string; at: string; gpsConfidence: GpsConfidence | null }>;
  incidents: Array<{ id: string; at: string }>;
  panics: Array<{ id: string; at: string }>;
  gate: Array<{ id: string; at: string; direction: VehicleDirection }>;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * This guard's records of one shift on this phone: every event linked to the shift id, plus
 * incidents, SOS alerts and gate entries this guard recorded at the shift's site during the shift
 * without a shift link. Oldest first.
 */
export async function loadShiftEvents(
  userId: string,
  shift: Pick<SummaryShift, 'shiftId' | 'siteId' | 'startedAt' | 'endedAt'>,
  db: EagleEyeOfflineDB | null = offlineDB
): Promise<LocalEventRecord[]> {
  if (!db || !userId) return [];
  const linked = await db.localEvents
    .where('shiftId')
    .equals(shift.shiftId)
    .filter((event) => event.userId === userId)
    .toArray();
  const from = toIso(shift.startedAt);
  let unlinked: LocalEventRecord[] = [];
  if (from) {
    const to = toIso(shift.endedAt);
    unlinked = await db.localEvents
      .where('createdAt')
      .between(from, to ?? Dexie.maxKey, true, true)
      .filter(
        (event) =>
          event.userId === userId &&
          event.shiftId === null &&
          event.siteId === shift.siteId &&
          (event.type === 'incident' || event.type === 'panic' || event.type === 'gate_entry')
      )
      .toArray();
  }
  const byId = new Map<string, LocalEventRecord>();
  for (const event of [...linked, ...unlinked]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

/** The last shift this guard clocked out of on this phone, rebuilt from its clock-in/out events. */
export async function loadLastEndedShift(
  userId: string,
  db: EagleEyeOfflineDB | null = offlineDB
): Promise<{ shift: SummaryShift; endEventId: string } | null> {
  if (!db || !userId) return null;
  const lastEnd = await db.localEvents
    .where('[userId+type+sequenceNumber]')
    .between([userId, 'shift_end', Dexie.minKey], [userId, 'shift_end', Dexie.maxKey])
    .last();
  if (!lastEnd || !lastEnd.shiftId) return null;
  const start = await db.localEvents
    .where('shiftId')
    .equals(lastEnd.shiftId)
    .filter((event) => event.type === 'shift_start' && event.userId === userId)
    .first();
  // A shift restored from the server (clock-in on another phone) has no local clock-in record.
  if (!start) return null;
  const payload = start.payload as ShiftStartPayload;
  return {
    shift: {
      shiftId: lastEnd.shiftId,
      siteId: start.siteId,
      shiftType: payload.shiftType,
      scheduledStart: payload.scheduledStart,
      scheduledEnd: payload.scheduledEnd,
      startedAt: start.createdAt,
      endedAt: lastEnd.createdAt
    },
    endEventId: lastEnd.id
  };
}

/** Splits a shift's records into scans, incidents, SOS alerts and gate entries. */
export function groupShiftEvents(events: readonly LocalEventRecord[]): ShiftEventGroups {
  const groups: ShiftEventGroups = { scans: [], incidents: [], panics: [], gate: [] };
  for (const event of events) {
    if (event.type === 'checkpoint_scan') {
      const payload = event.payload as CheckpointScanPayload;
      groups.scans.push({
        id: event.id,
        checkpointId: payload.checkpointId,
        at: event.createdAt,
        gpsConfidence: payload.gpsConfidence ?? null
      });
    } else if (event.type === 'incident') {
      groups.incidents.push({ id: event.id, at: event.createdAt });
    } else if (event.type === 'panic') {
      groups.panics.push({ id: event.id, at: event.createdAt });
    } else if (event.type === 'gate_entry') {
      const payload = event.payload as GateEntryPayload;
      groups.gate.push({ id: event.id, at: event.createdAt, direction: payload.direction });
    }
  }
  return groups;
}

/** Upload state of these records in this phone's queue. */
export async function countUploads(
  eventIds: readonly string[],
  db: EagleEyeOfflineDB | null = offlineDB
): Promise<{ waiting: number; failed: number }> {
  if (!db || eventIds.length === 0) return { waiting: 0, failed: 0 };
  const items = await db.syncQueue.bulkGet([...eventIds]);
  let waiting = 0;
  let failed = 0;
  for (const item of items) {
    if (!item) continue;
    if (item.syncState === 'pending' || item.syncState === 'syncing') waiting += 1;
    else if (item.syncState === 'failed') failed += 1;
  }
  return { waiting, failed };
}

export interface ShiftSummaryModalProps {
  open: boolean;
  onClose: () => void;
  shift: SummaryShift | null;
  userId: string;
  guardName: string;
  /** The site the shift was worked at (name, round interval, WhatsApp dispatch number). */
  site: Site | null;
  /** Right after clock-out (changes the heading). */
  justEnded?: boolean;
}

type PrepareFailure = 'no_site' | 'no_checkpoints' | 'bad_schedule' | 'failed';

type Prepared =
  | { status: 'loading' }
  | { status: 'error'; reason: PrepareFailure; detail: string }
  | { status: 'ready'; text: string; waiting: number; failed: number; recordCount: number };

type ShareStatus = 'prepared' | 'opened' | 'open_failed' | 'copied' | 'copy_failed';

export function ShiftSummaryModal(props: ShiftSummaryModalProps) {
  if (!props.open || !props.shift) return null;
  return <ShiftSummaryDialog {...props} shift={props.shift} />;
}

function ShiftSummaryDialog({
  onClose,
  shift,
  userId,
  guardName,
  site,
  justEnded = false
}: ShiftSummaryModalProps & { shift: SummaryShift }) {
  const { t, language } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [prepared, setPrepared] = useState<Prepared>({ status: 'loading' });
  const [share, setShare] = useState<ShareStatus>('prepared');

  const { shiftId, siteId, shiftType, scheduledStart, scheduledEnd, startedAt, endedAt } = shift;
  const siteName = site?.name ?? null;
  const roundIntervalMinutes = site?.roundIntervalMinutes ?? null;
  const dispatchNumber = site?.whatsappDispatchNumber ?? null;
  const recipient = normalizeSouthAfricanMobile(dispatchNumber);

  // Prepare the text from the records on this phone.
  useEffect(() => {
    let cancelled = false;
    const fail = (reason: PrepareFailure, detail = '') => {
      if (!cancelled) setPrepared({ status: 'error', reason, detail });
    };
    void (async () => {
      if (siteName === null || roundIntervalMinutes === null) return fail('no_site');
      let checkpoints;
      try {
        checkpoints = (await loadCheckpoints(siteId, { cache: offlineDB?.checkpointCache ?? null })).checkpoints;
      } catch (error) {
        return fail('no_checkpoints', error instanceof Error ? error.message : String(error));
      }
      try {
        const events = await loadShiftEvents(userId, { shiftId, siteId, startedAt, endedAt });
        const groups = groupShiftEvents(events);
        const uploads = await countUploads(events.map((event) => event.id));
        let stats;
        try {
          stats = computeShiftStats({
            siteName,
            guardName,
            shift: { id: shiftId, shiftType, scheduledStart, scheduledEnd, actualStart: startedAt, actualEnd: endedAt },
            roundIntervalMinutes,
            checkpoints: checkpoints.map((cp) => ({ id: cp.id, name: cp.name, isActive: cp.isActive })),
            scans: groups.scans.map((scan) => ({ checkpointId: scan.checkpointId, timestamp: scan.at, gpsConfidence: scan.gpsConfidence })),
            incidents: groups.incidents.map((incident) => ({ timestamp: incident.at })),
            panicAlerts: groups.panics.map((panic) => ({ timestamp: panic.at })),
            gateEntries: groups.gate.map((entry) => ({ timestamp: entry.at, direction: entry.direction })),
            pendingUploadCount: uploads.waiting,
            failedUploadCount: uploads.failed,
            now: Date.now()
          });
        } catch (error) {
          return fail('bad_schedule', error instanceof Error ? error.message : String(error));
        }
        const text = formatWhatsAppShiftSummary(stats, { lang: language });
        if (!cancelled) {
          setPrepared({ status: 'ready', text, waiting: uploads.waiting, failed: uploads.failed, recordCount: events.length });
        }
      } catch (error) {
        fail('failed', error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shiftId, siteId, shiftType, scheduledStart, scheduledEnd, startedAt, endedAt, siteName, roundIntervalMinutes, userId, guardName, language]);

  // Focus moves into the dialog and returns to the opener on close; the page behind does not scroll.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  const handleOpenWhatsApp = () => {
    if (prepared.status !== 'ready' || !recipient.ok) return;
    try {
      const how = openWhatsAppLink(buildWhatsAppLink(recipient.digits, prepared.text));
      setShare(how === 'unavailable' ? 'open_failed' : 'opened');
    } catch {
      setShare('open_failed');
    }
  };

  const handleCopy = async () => {
    if (prepared.status !== 'ready') return;
    const copied = await copySummaryToClipboard(prepared.text);
    setShare(copied ? 'copied' : 'copy_failed');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    trapFocusWithin(event, dialogRef.current);
  };

  const shiftTypeKey: Record<ShiftType, TranslationKey> = {
    day: 'guardHome.shiftType.day',
    night: 'guardHome.shiftType.night',
    custom: 'guardHome.shiftType.custom'
  };
  const shiftLine = t(
    'guardHome.summary.shiftLine',
    t(shiftTypeKey[shiftType]),
    sastDateString(scheduledStart),
    formatTimeHM(scheduledStart),
    formatTimeHM(scheduledEnd)
  );

  const failureKey: Record<PrepareFailure, TranslationKey> = {
    no_site: 'guardHome.summary.errorNoSite',
    no_checkpoints: 'guardHome.summary.errorNoCheckpoints',
    bad_schedule: 'guardHome.summary.errorSchedule',
    failed: 'guardHome.summary.errorFailed'
  };
  const shareKey: Record<ShareStatus, TranslationKey> = {
    prepared: 'guardHome.summary.statusPrepared',
    opened: 'guardHome.summary.statusOpened',
    open_failed: 'guardHome.summary.statusOpenFailed',
    copied: 'guardHome.summary.statusCopied',
    copy_failed: 'guardHome.summary.statusCopyFailed'
  };
  const shareTone =
    share === 'open_failed' || share === 'copy_failed' ? 'text-ee-danger' : share === 'prepared' ? 'text-ee-muted' : 'text-ee-success';

  const recipientProblemKey: TranslationKey | null = recipient.ok
    ? null
    : recipient.reason === 'empty'
      ? 'guardHome.summary.noNumber'
      : 'guardHome.summary.badNumber';

  const buttonBase =
    'inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ee-bg/80 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="flex max-h-full w-full max-w-md flex-col rounded-t-2xl border border-ee-border bg-ee-surface text-ee-text outline-none sm:rounded-2xl"
        data-testid="shiftSummary-dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-ee-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-2xl font-bold leading-tight">
              {justEnded ? t('guardHome.summary.titleEnded') : t('guardHome.summary.title')}
            </h2>
            <p id={descriptionId} className="mt-0.5 text-sm text-ee-muted">
              {shiftLine}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('guardHome.summary.close')}
            className="inline-flex min-h-12 min-w-12 flex-none items-center justify-center rounded-xl border border-ee-border text-ee-text hover:bg-ee-surface-raised"
            data-testid="shiftSummary-close-x"
          >
            <X className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {prepared.status === 'loading' && (
            <p className="flex items-center gap-2 text-ee-muted" role="status" data-testid="shiftSummary-loading">
              <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>{t('guardHome.summary.loading')}</span>
            </p>
          )}

          {prepared.status === 'error' && (
            <div role="alert" className="rounded-xl border border-ee-danger/50 bg-ee-danger/15 p-3 text-ee-danger" data-testid="shiftSummary-error" data-reason={prepared.reason}>
              <p className="font-semibold">{t(failureKey[prepared.reason])}</p>
              {prepared.detail && <p className="mt-1 break-words text-sm">{prepared.detail}</p>}
            </div>
          )}

          {prepared.status === 'ready' && (
            <>
              <p className={`text-base font-semibold ${shareTone}`} role="status" aria-live="polite" data-testid="shiftSummary-status" data-status={share}>
                {t(shareKey[share])}
              </p>

              {(prepared.waiting > 0 || prepared.failed > 0) && (
                <p className="flex gap-2 text-sm text-ee-warning" data-testid="shiftSummary-uploads-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                  <span>
                    {prepared.failed > 0
                      ? t('guardHome.summary.uploadsFailed', prepared.waiting, prepared.failed)
                      : t('guardHome.summary.uploadsWaiting', prepared.waiting)}
                  </span>
                </p>
              )}

              {recipient.ok ? (
                <p className="text-sm text-ee-muted" data-testid="shiftSummary-recipient">
                  {t('guardHome.summary.recipient', recipient.display)}
                </p>
              ) : (
                <p className="flex gap-2 text-sm text-ee-warning" data-testid="shiftSummary-no-recipient" data-reason={recipient.reason}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                  <span>{recipientProblemKey ? t(recipientProblemKey) : ''}</span>
                </p>
              )}

              <label className="block text-sm text-ee-muted" htmlFor={`${titleId}-text`}>
                {t('guardHome.summary.textLabel')}
              </label>
              <textarea
                id={`${titleId}-text`}
                readOnly
                value={prepared.text}
                rows={12}
                className="w-full resize-y rounded-xl border border-ee-border bg-ee-bg p-3 font-mono text-sm leading-relaxed text-ee-text"
                data-testid="shiftSummary-text"
              />
              <p className="text-xs text-ee-muted">{t('guardHome.summary.localNote', prepared.recordCount)}</p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-ee-border px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
          {recipient.ok && (
            <button
              type="button"
              onClick={handleOpenWhatsApp}
              disabled={prepared.status !== 'ready'}
              className={`${buttonBase} min-h-14 bg-ee-primary text-lg text-ee-on-primary hover:bg-ee-primary-strong`}
              data-testid="shiftSummary-open-whatsapp"
            >
              <MessageCircle className="h-6 w-6" aria-hidden="true" />
              <span>{t('guardHome.summary.openWhatsApp')}</span>
            </button>
          )}
          <div className="flex flex-col gap-2 min-[360px]:flex-row">
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={prepared.status !== 'ready'}
              className={`${buttonBase} min-h-12 flex-1 border ${
                recipient.ok
                  ? 'border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised'
                  : 'border-ee-primary bg-ee-primary text-ee-on-primary hover:bg-ee-primary-strong'
              }`}
              data-testid="shiftSummary-copy"
            >
              <ClipboardCopy className="h-5 w-5" aria-hidden="true" />
              <span>{t('guardHome.summary.copy')}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`${buttonBase} min-h-12 flex-1 border border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised`}
              data-testid="shiftSummary-close"
            >
              {t('guardHome.summary.done')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
