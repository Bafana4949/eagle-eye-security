'use client';

/**
 * Guard home: clock-in / clock-out (selfie + GPS), today's status and the shift summary.
 *
 * Truthfulness rules:
 * - Identity and site settings come only from useAuth(); the shift only from shiftStore
 *   (getActiveShift / startShift / endShift). Nothing is hard-coded.
 * - Clock-in/out are saved on this phone first. The page says "received by the server" only
 *   when the sync engine reports that event as synced.
 * - Today's figures are counted from this phone's records of the shift (Dexie localEvents) and
 *   the site's checkpoint list; an unknown value is shown as unknown, never guessed.
 */

import React, { useEffect, useId, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Circle, Loader2, MapPin, MessageCircle, ScanLine, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { useAuth } from '@/lib/auth/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { CameraCaptureModal, trapFocusWithin } from '@/components/shared/CameraCaptureModal';
import {
  ShiftSummaryModal,
  groupShiftEvents,
  loadLastEndedShift,
  loadShiftEvents,
  type SummaryShift
} from '@/components/guard/ShiftSummaryModal';
import {
  determineShiftForClockIn,
  formatDuration,
  formatTimeHM,
  generateShiftRounds,
  type ClockInOption,
  type ClockInShift,
  type RoundWindow
} from '@/features/shifts/shiftCalculator';
import {
  ShiftStoreError,
  endShift,
  getActiveShift,
  reconcileActiveShift,
  startShift,
  type ActiveShiftRecord,
  type ReconcileResult
} from '@/lib/data/shiftStore';
import { CheckpointLoadError, loadCheckpoints } from '@/lib/data/checkpoints';
import { offlineDB, type LocalEventRecord } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import { getLocationFix, type LocationFailureStatus, type LocationFixResult } from '@/lib/gps/location';
import { useLocationWatch } from '@/lib/gps/useLocationWatch';
import { useKeepScreenAwake } from '@/lib/patrol/useKeepScreenAwake';
import { sastDateString } from '@/lib/config/siteTime';
import type { Checkpoint, ShiftType, Site } from '@/types/models';
import type { SyncState } from '@/types/offline';

// ---------------------------------------------------------------------------
// Clock (client only: the server render never bakes in a time of day)
// ---------------------------------------------------------------------------

const CLOCK_TICK_MS = 15_000;
function subscribeClock(onChange: () => void): () => void {
  const id = window.setInterval(onChange, CLOCK_TICK_MS);
  return () => window.clearInterval(id);
}
function clockSnapshot(): number {
  return Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}
function serverClockSnapshot(): number | null {
  return null;
}

/** GPS wait before "Save without GPS" is offered. */
const GPS_SKIP_AFTER_MS = 8_000;
/** Clock-out this much before the scheduled end counts as early (a warning, never a block). */
const EARLY_CLOCK_OUT_WARN_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecordSync = SyncState | 'on_server';

interface LastShiftInfo {
  shift: SummaryShift;
  endEventId: string;
}

type ClockIntent =
  | { action: 'in'; option: ClockInOption; siteId: string; organisationId: string }
  | { action: 'out'; shift: ActiveShiftRecord };

type ClockFlow =
  | { step: 'idle' }
  | { step: 'confirm_in'; plan: ClockInShift; useAlternative: boolean; siteId: string; organisationId: string }
  | { step: 'confirm_out'; shift: ActiveShiftRecord }
  | { step: 'camera'; intent: ClockIntent }
  | { step: 'locating'; intent: ClockIntent }
  | { step: 'saving'; intent: ClockIntent }
  | { step: 'failed'; intent: ClockIntent; selfie: Blob; fix: LocationFixResult; message: string; canRetry: boolean };

interface ResultMessage {
  tone: 'success' | 'warning' | 'error' | 'info';
  text: string;
  detail?: string;
}

type CheckpointState =
  | { siteId: string; status: 'ok'; checkpoints: Checkpoint[]; source: 'network' | 'cache'; cachedAt: string | null }
  | { siteId: string; status: 'error'; reason: 'offline_no_cache' | 'network_error_no_cache' | 'failed' };

const SHIFT_TYPE_KEY: Record<ShiftType, TranslationKey> = {
  day: 'guardHome.shiftType.day',
  night: 'guardHome.shiftType.night',
  custom: 'guardHome.shiftType.custom'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summaryShiftFromActive(active: ActiveShiftRecord): SummaryShift {
  return {
    shiftId: active.shiftId,
    siteId: active.siteId,
    shiftType: active.shiftType,
    scheduledStart: active.scheduledStart,
    scheduledEnd: active.scheduledEnd,
    startedAt: active.startedAt,
    endedAt: null
  };
}

function optionFromPlan(plan: ClockInShift, useAlternative: boolean): ClockInOption {
  if (useAlternative && plan.alternative) return plan.alternative;
  return { shiftType: plan.shiftType, scheduledStart: plan.scheduledStart, scheduledEnd: plan.scheduledEnd, date: plan.date };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON = `${BUTTON_BASE} min-h-14 bg-ee-primary text-lg text-ee-on-primary hover:bg-ee-primary-strong`;
const SECONDARY_BUTTON = `${BUTTON_BASE} min-h-12 border border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised`;

const TONE_CLASS: Record<ResultMessage['tone'], string> = {
  success: 'border-ee-success/50 bg-ee-success/15 text-ee-success',
  warning: 'border-ee-warning/50 bg-ee-warning/15 text-ee-warning',
  error: 'border-ee-danger/50 bg-ee-danger/15 text-ee-danger',
  info: 'border-ee-border bg-ee-surface text-ee-text'
};

/**
 * Modal dialog: role="dialog", aria-modal, labelled by its heading; focus moves in and Tab stays
 * inside. Escape closes it only when onEscape is given (not while something is being saved).
 */
function FlowDialog({
  title,
  children,
  onEscape,
  testId,
  describedBy
}: {
  title: string;
  children: React.ReactNode;
  onEscape?: () => void;
  testId: string;
  describedBy?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    const target = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node;
    target?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation();
      onEscape();
      return;
    }
    trapFocusWithin(event, ref.current);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ee-bg/80 sm:items-center sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-t-2xl border border-ee-border bg-ee-surface px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] text-ee-text outline-none sm:rounded-2xl"
        data-testid={testId}
      >
        <h2 id={titleId} className="font-display text-2xl font-bold leading-tight">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** "Save without GPS" appears only after a real wait, so guards do not skip GPS by habit. */
function LocatingDialog({ onSkip, onCancel }: { onSkip: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [canSkip, setCanSkip] = useState(false);
  const descriptionId = useId();
  useEffect(() => {
    const id = window.setTimeout(() => setCanSkip(true), GPS_SKIP_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <FlowDialog title={t('guardHome.flow.locatingTitle')} testId="guardHome-locating" describedBy={descriptionId}>
      <p id={descriptionId} className="mt-3 flex items-center gap-2 text-ee-muted" role="status">
        <Loader2 className="h-5 w-5 flex-none animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>{t('guardHome.flow.locatingText')}</span>
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {canSkip && (
          <button type="button" onClick={onSkip} className={SECONDARY_BUTTON} data-testid="guardHome-skip-gps">
            {t('guardHome.flow.skipGps')}
          </button>
        )}
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON} data-autofocus data-testid="guardHome-locating-cancel">
          {t('guardHome.flow.cancel')}
        </button>
      </div>
    </FlowDialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GuardHomePage() {
  const { t } = useTranslation();
  const { status, user, profile, sites, activeSite, isOfflineSession } = useAuth();
  const userId = user?.id ?? null;
  const organisationId = profile?.organisationId ?? null;
  const guardName = profile ? `${profile.firstName} ${profile.lastName}`.trim() : '';

  const now = useSyncExternalStore<number | null>(subscribeClock, clockSnapshot, serverClockSnapshot);

  // --- Active shift (this phone's record) --------------------------------
  const [shiftLoad, setShiftLoad] = useState<{ userId: string; active: ActiveShiftRecord | null } | null>(null);
  const [shiftVersion, reloadShift] = useReducer((n: number) => n + 1, 0);
  const active = shiftLoad && shiftLoad.userId === userId ? shiftLoad.active : undefined;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getActiveShift(userId).then(
      (record) => {
        if (!cancelled) setShiftLoad({ userId, active: record });
      },
      () => {
        if (!cancelled) setShiftLoad({ userId, active: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [userId, shiftVersion]);

  // --- Online check against the server (restores / closes the open shift) ---
  const [reconcileNotice, setReconcileNotice] = useState<ReconcileResult['status'] | null>(null);
  const reconciledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'signed_in' || !userId || !organisationId || isOfflineSession) return;
    if (reconciledForRef.current === userId) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    reconciledForRef.current = userId;
    void (async () => {
      try {
        const outcome = await reconcileActiveShift(createClient(), { userId, organisationId });
        if (outcome.status === 'restored' || outcome.status === 'closed_on_server' || outcome.status === 'ambiguous') {
          setReconcileNotice(outcome.status);
        }
        if (outcome.status === 'restored' || outcome.status === 'closed_on_server') reloadShift();
      } catch {
        // Not configured or not reachable: the phone's own record stays authoritative.
      }
    })();
  }, [status, userId, organisationId, isOfflineSession]);

  // --- Sync engine: refresh local figures whenever the queue changes ---------
  const [dataVersion, bumpData] = useReducer((n: number) => n + 1, 0);
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    if (!syncEngine) return;
    return syncEngine.subscribe((summary) => {
      setIsOnline(summary.isOnline);
      bumpData();
    });
  }, []);

  // --- Last finished shift on this phone --------------------------------------
  const [lastLoaded, setLastLoaded] = useState<{ userId: string; info: LastShiftInfo | null } | null>(null);
  const [justEnded, setJustEnded] = useState<LastShiftInfo | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadLastEndedShift(userId).then(
      (info) => {
        if (!cancelled) setLastLoaded({ userId, info });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [userId, dataVersion]);
  const lastShift: LastShiftInfo | null =
    justEnded ?? (lastLoaded && lastLoaded.userId === userId ? lastLoaded.info : null);

  // --- Site for this screen: the running shift's site, else the selected site ---
  const shiftSite: Site | null = active ? sites.find((site) => site.id === active.siteId) ?? null : null;
  const focusSite: Site | null = active ? shiftSite : activeSite;
  const focusSiteId = active ? active.siteId : activeSite?.id ?? null;

  // --- Checkpoints of that site (network, else this phone's saved copy) -----
  const [checkpointState, setCheckpointState] = useState<CheckpointState | null>(null);
  useEffect(() => {
    if (!focusSiteId) return;
    let cancelled = false;
    loadCheckpoints(focusSiteId, { cache: offlineDB?.checkpointCache ?? null }).then(
      (result) => {
        if (!cancelled) {
          setCheckpointState({
            siteId: focusSiteId,
            status: 'ok',
            checkpoints: result.checkpoints,
            source: result.source,
            cachedAt: result.cachedAt ?? null
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setCheckpointState({
            siteId: focusSiteId,
            status: 'error',
            reason: error instanceof CheckpointLoadError ? error.reason : 'failed'
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [focusSiteId, isOnline]);
  const checkpoints = checkpointState && checkpointState.siteId === focusSiteId ? checkpointState : null;
  const activeCheckpoints =
    checkpoints?.status === 'ok'
      ? checkpoints.checkpoints.filter((cp) => cp.isActive).sort((a, b) => a.orderIndex - b.orderIndex)
      : null;

  // --- This shift's records on this phone ----------------------------------
  const [shiftEvents, setShiftEvents] = useState<{ shiftId: string; events: LocalEventRecord[] } | null>(null);
  const activeShiftId = active?.shiftId ?? null;
  const activeSiteIdOfShift = active?.siteId ?? null;
  const activeStartedAt = active?.startedAt ?? null;
  useEffect(() => {
    if (!userId || !activeShiftId || !activeSiteIdOfShift) return;
    let cancelled = false;
    loadShiftEvents(userId, { shiftId: activeShiftId, siteId: activeSiteIdOfShift, startedAt: activeStartedAt, endedAt: null }).then(
      (events) => {
        if (!cancelled) setShiftEvents({ shiftId: activeShiftId, events });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [userId, activeShiftId, activeSiteIdOfShift, activeStartedAt, dataVersion]);
  const events = shiftEvents && shiftEvents.shiftId === activeShiftId ? shiftEvents.events : null;

  // --- Upload state of the clock-in / clock-out records ---------------------
  const startEventId = active?.startEventId ?? null;
  const restoredFromServer = !!active && active.startEventId === active.shiftId;
  const endEventId = !active ? lastShift?.endEventId ?? null : null;
  const [recordSync, setRecordSync] = useState<{ id: string; state: SyncState | undefined }[]>([]);
  useEffect(() => {
    const ids = [startEventId, endEventId].filter((id): id is string => !!id);
    if (!syncEngine || ids.length === 0) return;
    const engine = syncEngine;
    let cancelled = false;
    Promise.all(ids.map(async (id) => ({ id, state: await engine.getSyncState(id) }))).then(
      (states) => {
        if (!cancelled) setRecordSync(states);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [startEventId, endEventId, dataVersion]);
  const syncOf = (id: string | null): RecordSync | undefined => {
    if (!id) return undefined;
    const state = recordSync.find((entry) => entry.id === id)?.state;
    if (state === undefined && id === startEventId && restoredFromServer) return 'on_server';
    return state;
  };

  // --- GPS warm-up and screen wake lock -------------------------------------
  const [flow, setFlow] = useState<ClockFlow>({ step: 'idle' });
  const onDuty = !!active;
  const watch = useLocationWatch(onDuty || flow.step !== 'idle');
  const screenAwake = useKeepScreenAwake(onDuty);

  // --- Messages ---------------------------------------------------------------
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [summaryOpen, setSummaryOpen] = useState<{ shift: SummaryShift; justEnded: boolean } | null>(null);

  /** Invalidates a GPS wait that the guard cancelled. */
  const attemptRef = useRef(0);
  const skipGpsRef = useRef<(() => void) | null>(null);

  // When the clock flow and the summary are finished, focus returns to the punch button
  // (unless something else already holds focus).
  const punchRef = useRef<HTMLButtonElement | null>(null);
  const busy = flow.step !== 'idle' || summaryOpen !== null;
  const wasBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (!wasBusy || busy) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) punchRef.current?.focus();
  }, [busy]);

  // ---------------------------------------------------------------------------
  // Clock-in / clock-out flow
  // ---------------------------------------------------------------------------

  const gpsDetail = (fix: LocationFixResult): string => {
    switch (fix.status) {
      case 'ok':
        return t('guardHome.gps.recorded', Number.isFinite(fix.accuracy) ? Math.round(fix.accuracy) : '?');
      case 'stale':
        return t('guardHome.gps.noneStale');
      case 'permission_denied':
        return t('guardHome.gps.nonePermission');
      case 'timeout':
        return t('guardHome.gps.noneTimeout');
      case 'unavailable':
        return t('guardHome.gps.noneUnavailable');
      case 'unsupported':
        return t('guardHome.gps.noneUnsupported');
      case 'insecure':
        return t('guardHome.gps.noneInsecure');
    }
  };

  const shiftLabel = (shiftType: ShiftType, start: string | number, end: string | number) =>
    t('guardHome.shiftLabel', t(SHIFT_TYPE_KEY[shiftType]), formatTimeHM(start), formatTimeHM(end));

  const handlePunch = () => {
    if (flow.step !== 'idle' || active === undefined || !userId || !organisationId) return;
    setResult(null);
    if (active) {
      setFlow({ step: 'confirm_out', shift: active });
      return;
    }
    if (!activeSite) return;
    let plan: ClockInShift;
    try {
      plan = determineShiftForClockIn(activeSite, Date.now());
    } catch {
      setResult({ tone: 'error', text: t('guardHome.error.siteTimes') });
      return;
    }
    setFlow({ step: 'confirm_in', plan, useAlternative: false, siteId: activeSite.id, organisationId });
  };

  const saveClock = async (intent: ClockIntent, selfie: Blob, fix: LocationFixResult) => {
    if (!userId) return;
    setFlow({ step: 'saving', intent });
    const location = eventLocationFromFix(fix);
    try {
      if (intent.action === 'in') {
        const record = await startShift({
          ctx: { userId, organisationId: intent.organisationId, siteId: intent.siteId },
          shiftType: intent.option.shiftType,
          scheduledStart: new Date(intent.option.scheduledStart).toISOString(),
          scheduledEnd: new Date(intent.option.scheduledEnd).toISOString(),
          selfieBlob: selfie,
          location
        });
        setShiftLoad({ userId, active: record });
        setJustEnded(null);
        setReconcileNotice(null);
        setResult({
          tone: fix.status === 'ok' ? 'success' : 'warning',
          text: t('guardHome.result.clockedIn', formatTimeHM(record.startedAt), shiftLabel(record.shiftType, record.scheduledStart, record.scheduledEnd)),
          detail: gpsDetail(fix)
        });
      } else {
        const shift = intent.shift;
        const ended = await endShift({
          ctx: { userId, organisationId: shift.organisationId, siteId: shift.siteId },
          shiftId: shift.shiftId,
          selfieBlob: selfie,
          location
        });
        const info: LastShiftInfo = {
          shift: { ...summaryShiftFromActive(shift), endedAt: ended.endedAt },
          endEventId: ended.eventId
        };
        setShiftLoad({ userId, active: null });
        setJustEnded(info);
        setReconcileNotice(null);
        setResult({
          tone: fix.status === 'ok' ? 'success' : 'warning',
          text: t('guardHome.result.clockedOut', formatTimeHM(ended.endedAt)),
          detail: gpsDetail(fix)
        });
        setSummaryOpen({ shift: info.shift, justEnded: true });
      }
      setFlow({ step: 'idle' });
      bumpData();
    } catch (error) {
      if (error instanceof ShiftStoreError && error.code !== 'unavailable') {
        // The phone's shift record changed underneath (other tab, server check): show the truth.
        reloadShift();
        setFlow({ step: 'idle' });
        const key: TranslationKey =
          error.code === 'already_active' ? 'guardHome.error.alreadyActive' : 'guardHome.error.noActiveShift';
        setResult({ tone: 'error', text: t(key) });
        return;
      }
      setFlow({ step: 'failed', intent, selfie, fix, message: describeError(error), canRetry: true });
    }
  };

  const handleSelfie = async (intent: ClockIntent, selfie: Blob) => {
    const attempt = ++attemptRef.current;
    setFlow({ step: 'locating', intent });
    const skipped = new Promise<LocationFixResult>((resolve) => {
      skipGpsRef.current = () =>
        resolve({ status: 'timeout', message: 'The guard continued without waiting for GPS.' });
    });
    const fix = await Promise.race([getLocationFix({ maxAgeMs: 30_000, timeoutMs: 10_000 }), skipped]);
    skipGpsRef.current = null;
    if (attempt !== attemptRef.current) return; // cancelled while waiting
    await saveClock(intent, selfie, fix);
  };

  const cancelFlow = () => {
    attemptRef.current += 1;
    skipGpsRef.current = null;
    setFlow({ step: 'idle' });
  };

  // ---------------------------------------------------------------------------
  // Derived view data
  // ---------------------------------------------------------------------------

  let rounds: RoundWindow[] | null = null;
  let roundsError = false;
  if (active && focusSite && now !== null) {
    try {
      rounds = generateShiftRounds(
        {
          startTime: Date.parse(active.scheduledStart),
          endTime: Date.parse(active.scheduledEnd),
          roundIntervalMinutes: focusSite.roundIntervalMinutes
        },
        now
      );
    } catch {
      roundsError = true;
    }
  }
  const currentRound = rounds?.find((round) => round.isCurrent) ?? null;
  const beforeFirstRound = !!active && now !== null && now < Date.parse(active.scheduledStart);
  const afterShiftEnd = !!active && now !== null && now >= Date.parse(active.scheduledEnd);

  const groups = events ? groupShiftEvents(events) : null;
  const scannedThisRound = new Map<string, string>();
  if (groups && currentRound) {
    for (const scan of groups.scans) {
      const at = Date.parse(scan.at);
      if (at >= currentRound.windowStart && at < currentRound.windowEnd && !scannedThisRound.has(scan.checkpointId)) {
        scannedThisRound.set(scan.checkpointId, scan.at);
      }
    }
  }
  const doneThisRound = activeCheckpoints ? activeCheckpoints.filter((cp) => scannedThisRound.has(cp.id)).length : null;
  const vehiclesIn = groups ? groups.gate.filter((entry) => entry.direction === 'in').length : null;
  const vehiclesOut = groups ? groups.gate.filter((entry) => entry.direction === 'out').length : null;

  let nextPlan: ClockInShift | null = null;
  let siteTimesInvalid = false;
  if (!active && activeSite && now !== null) {
    try {
      nextPlan = determineShiftForClockIn(activeSite, now);
    } catch {
      siteTimesInvalid = true;
    }
  }

  const summaryTarget: SummaryShift | null = active ? summaryShiftFromActive(active) : lastShift?.shift ?? null;
  const summarySite = summaryOpen ? sites.find((site) => site.id === summaryOpen.shift.siteId) ?? null : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (status !== 'signed_in' || !user || !profile) {
    return (
      <p className="py-10 text-center text-ee-muted" role="status" data-testid="guardHome-loading">
        {t('guardHome.loading')}
      </p>
    );
  }

  const noSite = !active && !activeSite;
  const shiftLoading = active === undefined;
  const punchDisabled = shiftLoading || flow.step !== 'idle' || noSite || (!active && siteTimesInvalid);

  const syncText = (state: RecordSync | undefined): { text: string; tone: string } | null => {
    switch (state) {
      case 'pending':
      case 'syncing':
        return { text: t('guardHome.sync.queued'), tone: 'text-ee-warning' };
      case 'synced':
        return { text: t('guardHome.sync.received'), tone: 'text-ee-success' };
      case 'on_server':
        return { text: t('guardHome.sync.onServer'), tone: 'text-ee-success' };
      case 'failed':
        return { text: t('guardHome.sync.failed'), tone: 'text-ee-danger' };
      default:
        return null;
    }
  };
  const startSync = active ? syncText(syncOf(startEventId)) : null;
  const endSync = !active && lastShift ? syncText(syncOf(lastShift.endEventId)) : null;

  let gpsLine: { text: string; tone: string } | null = null;
  if (onDuty) {
    if (watch.fix && (watch.fix.status === 'ok' || watch.fix.status === 'stale')) {
      gpsLine =
        watch.fix.status === 'ok'
          ? {
              text: t('guardHome.gps.ready', Number.isFinite(watch.fix.accuracy) ? Math.round(watch.fix.accuracy) : '?'),
              tone: 'text-ee-success'
            }
          : { text: t('guardHome.gps.stale'), tone: 'text-ee-warning' };
    } else if (watch.error) {
      const errorKey: Record<LocationFailureStatus, TranslationKey> = {
        permission_denied: 'guardHome.gps.watchPermission',
        timeout: 'guardHome.gps.watchWaiting',
        unavailable: 'guardHome.gps.watchUnavailable',
        unsupported: 'guardHome.gps.watchUnsupported',
        insecure: 'guardHome.gps.watchInsecure'
      };
      gpsLine = { text: t(errorKey[watch.error.status]), tone: 'text-ee-warning' };
    } else {
      gpsLine = { text: t('guardHome.gps.watchWaiting'), tone: 'text-ee-muted' };
    }
  }

  const reconcileKey: Partial<Record<ReconcileResult['status'], TranslationKey>> = {
    restored: 'guardHome.reconcile.restored',
    closed_on_server: 'guardHome.reconcile.closed',
    ambiguous: 'guardHome.reconcile.ambiguous'
  };

  const confirmInOption = flow.step === 'confirm_in' ? optionFromPlan(flow.plan, flow.useAlternative) : null;
  const confirmInReasonKey: TranslationKey | null =
    flow.step === 'confirm_in'
      ? flow.plan.reason === 'next_due'
        ? 'guardHome.confirmIn.reasonNextDue'
        : flow.plan.reason === 'early_for_next'
          ? 'guardHome.confirmIn.reasonEarly'
          : flow.plan.alternative
            ? 'guardHome.confirmIn.reasonChoose'
            : 'guardHome.confirmIn.reasonInWindow'
      : null;

  const earlyByMs =
    flow.step === 'confirm_out' && now !== null ? Date.parse(flow.shift.scheduledEnd) - now : 0;

  const siteNameShown = active ? shiftSite?.name ?? t('guardHome.unknownSite') : activeSite?.name ?? null;

  return (
    <div className="space-y-6 pb-6" data-testid="guardHome-page">
      {/* Status header (Dawie style: plain text, large condensed heading) */}
      <section aria-labelledby="guardHome-duty-heading" className="pt-1">
        {siteNameShown && (
          <p className="flex items-center gap-1.5 text-sm text-ee-muted" data-testid="guardHome-site">
            <MapPin className="h-4 w-4 flex-none" aria-hidden="true" />
            <span className="min-w-0 truncate">{siteNameShown}</span>
          </p>
        )}
        <h1
          id="guardHome-duty-heading"
          className={`font-display text-4xl font-bold leading-tight ${onDuty ? 'text-ee-success' : 'text-ee-text'}`}
          data-testid="guardHome-duty-state"
          data-state={shiftLoading ? 'loading' : onDuty ? 'on_duty' : 'off_duty'}
        >
          {shiftLoading ? t('guardHome.checkingShift') : onDuty ? t('guardHome.onDuty') : t('guardHome.offDuty')}
        </h1>
        <p className="text-base text-ee-muted" data-testid="guardHome-shift-info">
          {active
            ? shiftLabel(active.shiftType, active.scheduledStart, active.scheduledEnd)
            : nextPlan
              ? t(
                  nextPlan.reason === 'in_window' ? 'guardHome.shiftNow' : 'guardHome.shiftNext',
                  shiftLabel(nextPlan.shiftType, nextPlan.scheduledStart, nextPlan.scheduledEnd)
                )
              : ''}
        </p>
        {isOfflineSession && (
          <p className="mt-1 text-sm text-ee-warning" data-testid="guardHome-offline-session">
            {t('guardHome.offlineSession')}
          </p>
        )}
      </section>

      {noSite && (
        <p role="alert" className="rounded-xl border border-ee-warning/50 bg-ee-warning/15 p-3 text-ee-warning" data-testid="guardHome-no-site">
          {t('guardHome.noSite')}
        </p>
      )}
      {!active && siteTimesInvalid && (
        <p role="alert" className="rounded-xl border border-ee-danger/50 bg-ee-danger/15 p-3 text-ee-danger" data-testid="guardHome-site-times-invalid">
          {t('guardHome.error.siteTimes')}
        </p>
      )}

      {reconcileNotice && reconcileKey[reconcileNotice] && (
        <div
          role="status"
          className={`flex items-start gap-2 rounded-xl border p-3 ${reconcileNotice === 'restored' ? TONE_CLASS.info : TONE_CLASS.warning}`}
          data-testid="guardHome-reconcile-notice"
          data-status={reconcileNotice}
        >
          <p className="flex-1 text-sm">{t(reconcileKey[reconcileNotice] as TranslationKey)}</p>
          <button
            type="button"
            onClick={() => setReconcileNotice(null)}
            aria-label={t('guardHome.dismiss')}
            className="inline-flex min-h-12 min-w-12 flex-none items-center justify-center rounded-lg hover:bg-ee-surface-raised"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Punch-clock button (Dawie's one bold element) */}
      <section className="flex flex-col items-center" aria-label={t('guardHome.punchSection')}>
        <button
          ref={punchRef}
          type="button"
          onClick={handlePunch}
          disabled={punchDisabled}
          className="punch-btn mt-4 mb-2 aspect-square w-[min(64vw,236px)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          aria-describedby="guardHome-punch-hint"
          data-testid="guardHome-punch"
          data-action={onDuty ? 'clock_out' : 'clock_in'}
        >
          <span className="flex flex-col items-center px-4 text-center">
            <span className="font-display text-4xl font-bold leading-none">
              {onDuty ? t('guardHome.clockOut') : t('guardHome.clockIn')}
            </span>
            <span className="mt-1.5 text-sm font-semibold">{t('guardHome.punchSub')}</span>
          </span>
        </button>
        <p id="guardHome-punch-hint" className="mt-4 text-center text-sm text-ee-muted">
          {onDuty ? t('guardHome.punchHintOut') : t('guardHome.punchHintIn')}
        </p>

        {active && (
          <div className="mt-3 w-full space-y-1 text-center text-sm">
            <p className="text-ee-text" data-testid="guardHome-on-duty-since">
              {t('guardHome.onDutySince', formatTimeHM(active.startedAt), now !== null ? formatDuration(Math.max(0, now - Date.parse(active.startedAt))) : '…')}
            </p>
            {startSync && (
              <p className={startSync.tone} data-testid="guardHome-start-sync" data-state={syncOf(startEventId)}>
                {t('guardHome.sync.clockInLabel', startSync.text)}
              </p>
            )}
            {gpsLine && (
              <p className={gpsLine.tone} data-testid="guardHome-gps-status">
                {gpsLine.text}
              </p>
            )}
            {!screenAwake && (
              <p className="text-ee-warning" data-testid="guardHome-screen-awake-warning">
                {t('guardHome.screenMaySleep')}
              </p>
            )}
          </div>
        )}

        {!active && lastShift && (
          <div className="mt-3 w-full space-y-1 text-center text-sm">
            <p className="text-ee-muted" data-testid="guardHome-last-shift">
              {t('guardHome.lastShiftEnded', lastShift.shift.endedAt ? formatTimeHM(lastShift.shift.endedAt) : '–', lastShift.shift.endedAt ? sastDateString(lastShift.shift.endedAt) : '')}
            </p>
            {endSync && (
              <p className={endSync.tone} data-testid="guardHome-end-sync" data-state={syncOf(lastShift.endEventId)}>
                {t('guardHome.sync.clockOutLabel', endSync.text)}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Result of the last clock action (announced) */}
      <div aria-live="polite" role="status">
        {result && (
          <div className={`flex items-start gap-2 rounded-xl border p-3 ${TONE_CLASS[result.tone]}`} data-testid="guardHome-result" data-tone={result.tone}>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{result.text}</p>
              {result.detail && <p className="mt-0.5 text-sm">{result.detail}</p>}
            </div>
            <button
              type="button"
              onClick={() => setResult(null)}
              aria-label={t('guardHome.dismiss')}
              className="inline-flex min-h-12 min-w-12 flex-none items-center justify-center rounded-lg hover:bg-ee-surface-raised"
              data-testid="guardHome-result-dismiss"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Today's status for the running shift, counted from this phone's records */}
      {active && (
        <section aria-labelledby="guardHome-today-heading">
          <h2 id="guardHome-today-heading" className="mb-2 font-display text-2xl font-semibold">
            {t('guardHome.today.title')}
          </h2>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ee-border bg-ee-border">
            <div className="bg-ee-surface p-3" data-testid="guardHome-stat-round">
              <dt className="text-sm text-ee-muted">{t('guardHome.today.round')}</dt>
              <dd className="font-display text-3xl font-bold leading-tight">
                {currentRound && doneThisRound !== null && activeCheckpoints ? `${doneThisRound}/${activeCheckpoints.length}` : '–'}
              </dd>
            </div>
            <div className="bg-ee-surface p-3" data-testid="guardHome-stat-incidents">
              <dt className="text-sm text-ee-muted">{t('guardHome.today.incidents')}</dt>
              <dd className="font-display text-3xl font-bold leading-tight">{groups ? groups.incidents.length : '–'}</dd>
            </div>
            <div className="bg-ee-surface p-3" data-testid="guardHome-stat-vehicles">
              <dt className="text-sm text-ee-muted">{t('guardHome.today.vehicles')}</dt>
              <dd className="font-display text-3xl font-bold leading-tight">
                {vehiclesIn !== null && vehiclesOut !== null ? `${vehiclesIn} / ${vehiclesOut}` : '–'}
              </dd>
            </div>
            <div className="bg-ee-surface p-3" data-testid="guardHome-stat-sos">
              <dt className="text-sm text-ee-muted">{t('guardHome.today.sos')}</dt>
              <dd className={`font-display text-3xl font-bold leading-tight ${groups && groups.panics.length > 0 ? 'text-ee-danger' : ''}`}>
                {groups ? groups.panics.length : '–'}
              </dd>
            </div>
          </dl>
          <p className="mt-1.5 text-xs text-ee-muted">{t('guardHome.today.localNote')}</p>
        </section>
      )}

      {/* Checkpoints of the current round */}
      {active && (
        <section aria-labelledby="guardHome-round-heading">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 id="guardHome-round-heading" className="font-display text-2xl font-semibold">
              {currentRound ? t('guardHome.round.title', currentRound.roundNumber, rounds?.length ?? 0) : t('guardHome.round.titlePlain')}
            </h2>
            {currentRound && (
              <span className="font-display text-xl font-semibold text-ee-muted" data-testid="guardHome-round-window">
                {formatTimeHM(currentRound.windowStart)}–{formatTimeHM(currentRound.windowEnd)}
              </span>
            )}
          </div>

          {roundsError && (
            <p className="text-ee-danger" role="alert" data-testid="guardHome-round-error">
              {t('guardHome.round.intervalInvalid')}
            </p>
          )}
          {!roundsError && beforeFirstRound && (
            <p className="text-ee-muted" data-testid="guardHome-round-not-started">
              {t('guardHome.round.notStarted', formatTimeHM(active.scheduledStart))}
            </p>
          )}
          {!roundsError && afterShiftEnd && (
            <p className="text-ee-warning" data-testid="guardHome-round-shift-over">
              {t('guardHome.round.shiftOver', formatTimeHM(active.scheduledEnd))}
            </p>
          )}

          {checkpoints === null && (
            <p className="text-ee-muted" role="status">
              {t('guardHome.checkpoints.loading')}
            </p>
          )}
          {checkpoints?.status === 'error' && (
            <p className="text-ee-warning" role="alert" data-testid="guardHome-checkpoints-error" data-reason={checkpoints.reason}>
              {checkpoints.reason === 'offline_no_cache' ? t('guardHome.checkpoints.offlineNoCache') : t('guardHome.checkpoints.loadFailed')}
            </p>
          )}
          {activeCheckpoints && activeCheckpoints.length === 0 && (
            <p className="text-ee-muted" data-testid="guardHome-checkpoints-empty">
              {t('guardHome.checkpoints.none')}
            </p>
          )}
          {activeCheckpoints && activeCheckpoints.length > 0 && currentRound && (
            <ul className="border-t border-ee-border" data-testid="guardHome-round-list">
              {activeCheckpoints.map((cp) => {
                const scannedAt = scannedThisRound.get(cp.id);
                return (
                  <li
                    key={cp.id}
                    className="flex items-center justify-between gap-3 border-b border-ee-border py-3"
                    data-testid="guardHome-round-item"
                    data-state={scannedAt ? 'done' : 'waiting'}
                  >
                    <span className="min-w-0 break-words">{cp.name}</span>
                    {scannedAt ? (
                      <span className="flex flex-none items-center gap-1.5 font-semibold text-ee-success">
                        <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                        <span>{t('guardHome.round.doneAt', formatTimeHM(scannedAt))}</span>
                      </span>
                    ) : (
                      <span className="flex flex-none items-center gap-1.5 text-ee-muted">
                        <Circle className="h-5 w-5" aria-hidden="true" />
                        <span>{t('guardHome.round.waiting')}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {checkpoints?.status === 'ok' && checkpoints.source === 'cache' && (
            <p className="mt-1.5 text-xs text-ee-muted" data-testid="guardHome-checkpoints-cached">
              {t('guardHome.checkpoints.fromCache', checkpoints.cachedAt ? `${sastDateString(checkpoints.cachedAt)} ${formatTimeHM(checkpoints.cachedAt)}` : '–')}
            </p>
          )}

          {/* text-ee-on-primary! overrides the global (unlayered) `a { color }` rule in globals.css. */}
          <Link href="/guard/patrol" className={`${PRIMARY_BUTTON} mt-4 text-ee-on-primary! no-underline`} data-testid="guardHome-patrol-link">
            <ScanLine className="h-6 w-6" aria-hidden="true" />
            <span>{t('guardHome.goPatrol')}</span>
          </Link>
        </section>
      )}

      {/* Shift summary for the running or the last shift */}
      {summaryTarget && (
        <section>
          <button
            type="button"
            onClick={() => setSummaryOpen({ shift: summaryTarget, justEnded: false })}
            className={SECONDARY_BUTTON}
            data-testid="guardHome-summary-open"
          >
            <MessageCircle className="h-5 w-5" aria-hidden="true" />
            <span>{active ? t('guardHome.summaryCurrent') : t('guardHome.summaryLast')}</span>
          </button>
        </section>
      )}

      {/* ----------------------------- Dialogs ----------------------------- */}

      {flow.step === 'confirm_in' && confirmInOption && confirmInReasonKey && (
        <FlowDialog title={t('guardHome.confirmIn.title')} onEscape={cancelFlow} testId="guardHome-confirm-in">
          <p className="mt-2 text-ee-muted">{t(confirmInReasonKey)}</p>
          <div className="mt-3 flex flex-col gap-2" role="group" aria-label={t('guardHome.confirmIn.choiceLabel')}>
            {[false, true].map((isAlternative) => {
              if (isAlternative && !flow.plan.alternative) return null;
              const option = optionFromPlan(flow.plan, isAlternative);
              const selected = flow.useAlternative === isAlternative;
              return (
                <button
                  key={isAlternative ? 'alternative' : 'primary'}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFlow({ ...flow, useAlternative: isAlternative })}
                  className={`flex min-h-14 w-full flex-col items-start justify-center rounded-xl border px-4 py-2 text-left ${
                    selected ? 'border-ee-primary bg-ee-primary/15 text-ee-text' : 'border-ee-border bg-ee-bg text-ee-muted hover:bg-ee-surface-raised'
                  }`}
                  data-testid={isAlternative ? 'guardHome-shift-option-alternative' : 'guardHome-shift-option-primary'}
                >
                  <span className="text-lg font-semibold">{shiftLabel(option.shiftType, option.scheduledStart, option.scheduledEnd)}</span>
                  <span className="text-sm">{t('guardHome.confirmIn.startsOn', option.date)}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              data-autofocus
              onClick={() =>
                setFlow({
                  step: 'camera',
                  intent: { action: 'in', option: confirmInOption, siteId: flow.siteId, organisationId: flow.organisationId }
                })
              }
              className={PRIMARY_BUTTON}
              data-testid="guardHome-confirm-continue"
            >
              {t('guardHome.flow.continueSelfie')}
            </button>
            <button type="button" onClick={cancelFlow} className={SECONDARY_BUTTON} data-testid="guardHome-confirm-cancel">
              {t('guardHome.flow.cancel')}
            </button>
          </div>
        </FlowDialog>
      )}

      {flow.step === 'confirm_out' && (
        <FlowDialog title={t('guardHome.confirmOut.title')} onEscape={cancelFlow} testId="guardHome-confirm-out">
          <p className="mt-2 text-ee-muted">
            {shiftLabel(flow.shift.shiftType, flow.shift.scheduledStart, flow.shift.scheduledEnd)}
          </p>
          {earlyByMs > EARLY_CLOCK_OUT_WARN_MS && (
            <p className="mt-2 flex gap-2 font-semibold text-ee-warning" data-testid="guardHome-early-warning">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
              <span>{t('guardHome.confirmOut.early', formatDuration(earlyByMs), formatTimeHM(flow.shift.scheduledEnd))}</span>
            </p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              data-autofocus
              onClick={() => setFlow({ step: 'camera', intent: { action: 'out', shift: flow.shift } })}
              className={PRIMARY_BUTTON}
              data-testid="guardHome-confirm-continue"
            >
              {t('guardHome.flow.continueSelfie')}
            </button>
            <button type="button" onClick={cancelFlow} className={SECONDARY_BUTTON} data-testid="guardHome-confirm-cancel">
              {t('guardHome.flow.cancel')}
            </button>
          </div>
        </FlowDialog>
      )}

      {flow.step === 'camera' && (
        <CameraCaptureModal
          isOpen
          facingMode="user"
          isSelfie
          title={flow.intent.action === 'in' ? t('guardHome.flow.selfieInTitle') : t('guardHome.flow.selfieOutTitle')}
          onClose={cancelFlow}
          onCapture={(blob) => void handleSelfie(flow.intent, blob)}
        />
      )}

      {flow.step === 'locating' && (
        <LocatingDialog onSkip={() => skipGpsRef.current?.()} onCancel={cancelFlow} />
      )}

      {flow.step === 'saving' && (
        <FlowDialog title={t('guardHome.flow.savingTitle')} testId="guardHome-saving">
          <p className="mt-3 flex items-center gap-2 text-ee-muted" role="status">
            <Loader2 className="h-5 w-5 flex-none animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>{t('guardHome.flow.savingText')}</span>
          </p>
        </FlowDialog>
      )}

      {flow.step === 'failed' && (
        <FlowDialog title={t('guardHome.flow.failedTitle')} onEscape={cancelFlow} testId="guardHome-save-failed">
          <p className="mt-2 text-ee-danger" role="alert">
            {flow.intent.action === 'in' ? t('guardHome.flow.failedIn') : t('guardHome.flow.failedOut')}
          </p>
          <p className="mt-1 break-words text-sm text-ee-muted" data-testid="guardHome-save-failed-detail">
            {flow.message}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {flow.canRetry && (
              <button
                type="button"
                data-autofocus
                onClick={() => void saveClock(flow.intent, flow.selfie, flow.fix)}
                className={PRIMARY_BUTTON}
                data-testid="guardHome-save-retry"
              >
                {t('guardHome.flow.retry')}
              </button>
            )}
            <button type="button" onClick={cancelFlow} className={SECONDARY_BUTTON} data-testid="guardHome-save-cancel">
              {t('guardHome.flow.cancel')}
            </button>
          </div>
        </FlowDialog>
      )}

      <ShiftSummaryModal
        open={!!summaryOpen}
        onClose={() => setSummaryOpen(null)}
        shift={summaryOpen?.shift ?? null}
        userId={user.id}
        guardName={guardName}
        site={summarySite}
        justEnded={summaryOpen?.justEnded ?? false}
        key={summaryOpen?.shift.shiftId ?? 'closed'}
      />
    </div>
  );
}
