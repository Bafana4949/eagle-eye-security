'use client';

/**
 * Shared app chrome: the manager header (HeaderNav) plus the pieces the guard header and the
 * guard "More" page reuse — an accessible modal dialog, the truthful upload (sync) status, and
 * the sign-out flow that refuses to hide unsynced records.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { liveQuery } from 'dexie';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CloudUpload,
  LogOut,
  RefreshCw,
  RotateCcw,
  Users,
  WifiOff,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { homeForRoles } from '@/lib/auth/routeAccess';
import { SUPPORTED_LANGUAGES, useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { syncEngine, type SyncRunReport } from '@/lib/offline/sync';
import { offlineDB } from '@/lib/offline/db';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import { EMPTY_SYNC_SUMMARY, type OfflineEventType, type OfflineQueueItem, type OfflineSyncSummary } from '@/types/offline';
import type { SupportedLanguage, UserRole } from '@/types/models';
import { EVENT_TYPE_KEYS, readableSyncError } from '@/app/guard/history/guardEvents';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** sessionStorage key the sign-out flow uses to tell the login page how sign-out went. */
export const SIGN_OUT_NOTICE_KEY = 'ee.signout.notice';

export const EVENT_TYPE_LABEL_KEYS: Readonly<Record<OfflineEventType, TranslationKey>> = EVENT_TYPE_KEYS;

/** "2026-09-30 14:05" in SAST (all site times are SAST, whatever the phone's time zone). */
export function formatSastDateTime(value: string | number | Date): string {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return `${sastDateString(ms)} ${sastTimeHM(ms)}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold select-none disabled:opacity-50 disabled:pointer-events-none';
export const chromeButton = {
  primary: `${buttonBase} min-h-12 px-4 bg-ee-primary text-ee-on-primary border border-ee-primary hover:bg-ee-primary-strong`,
  secondary: `${buttonBase} min-h-12 px-4 bg-ee-surface text-ee-text border border-ee-border hover:bg-ee-surface-raised`,
  danger: `${buttonBase} min-h-12 px-4 bg-ee-surface text-ee-danger-text border border-ee-danger hover:bg-ee-danger/15`
} as const;

// ---------------------------------------------------------------------------
// Language switch (Dawie's three pill buttons)
// ---------------------------------------------------------------------------

const LANGUAGE_LABEL_KEYS: Record<SupportedLanguage, TranslationKey> = {
  af: 'authLangAf',
  en: 'authLangEn',
  zu: 'authLangZu'
};

export function LanguageSwitch({ testIdPrefix = 'chrome-lang' }: { testIdPrefix?: string }) {
  const { t, language, setLanguage } = useTranslation();
  return (
    <div role="group" aria-label={t('authLanguageGroup')} className="flex gap-2">
      {SUPPORTED_LANGUAGES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={language === code}
          onClick={() => setLanguage(code)}
          className={`min-h-12 flex-1 rounded-full border px-2 text-base ${
            language === code
              ? 'border-ee-primary font-semibold text-ee-primary'
              : 'border-ee-border text-ee-muted hover:text-ee-text'
          }`}
          data-testid={`${testIdPrefix}-${code}`}
        >
          {t(LANGUAGE_LABEL_KEYS[code])}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal dialog (native <dialog>: focus moves in, background is inert, Escape = cancel)
// ---------------------------------------------------------------------------

export interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  /** id of the element holding the dialog title. */
  labelledBy: string;
  describedBy?: string;
  /** Escape and a tap outside close the dialog (default true). */
  dismissible?: boolean;
  className?: string;
  testId?: string;
  children: React.ReactNode;
}

export function ModalDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  dismissible = true,
  className = '',
  testId,
  children
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      const target =
        dialog.querySelector<HTMLElement>('[data-autofocus]') ??
        dialog.querySelector<HTMLElement>('button, [href], input, select, textarea');
      target?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onCloseRef.current();
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onCloseRef.current();
      }}
      className={`m-auto w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-ee-border bg-ee-surface p-0 text-ee-text backdrop:bg-ee-bg/85 ${className}`}
    >
      {open ? <div className="p-5">{children}</div> : null}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Upload (sync) status
// ---------------------------------------------------------------------------

/** Live sync summary for the signed-in user. `ready` is false until the first real reading. */
export function useSyncSummary(): { summary: OfflineSyncSummary; ready: boolean } {
  const [state, setState] = useState<{ summary: OfflineSyncSummary; ready: boolean }>({
    summary: EMPTY_SYNC_SUMMARY,
    ready: false
  });
  useEffect(() => {
    if (!syncEngine) return;
    return syncEngine.subscribe((summary) => setState({ summary, ready: true }));
  }, []);
  return state;
}

export type Tone = 'success' | 'warning' | 'danger' | 'muted';

const toneText: Record<Tone, string> = {
  success: 'text-ee-success border-ee-success/60 bg-ee-success/10',
  warning: 'text-ee-warning border-ee-warning/60 bg-ee-warning/10',
  danger: 'text-ee-danger-text border-ee-danger/70 bg-ee-danger/15',
  muted: 'text-ee-muted border-ee-border bg-ee-surface'
};

export const toneForeground: Record<Tone, string> = {
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger-text',
  muted: 'text-ee-muted'
};

interface SyncStatusView {
  tone: Tone;
  short: string;
  Icon: LucideIcon;
  spinning: boolean;
}

export function describeSyncStatus(
  summary: OfflineSyncSummary,
  ready: boolean,
  t: (key: TranslationKey, ...args: (string | number)[]) => string
): SyncStatusView {
  if (!ready) return { tone: 'muted', short: t('authSyncPillChecking'), Icon: RefreshCw, spinning: false };
  const waiting = summary.pendingCount + summary.syncingCount;
  if (summary.failedCount > 0) {
    return { tone: 'danger', short: t('authSyncPillFailed', summary.failedCount), Icon: AlertTriangle, spinning: false };
  }
  if (!summary.isOnline) {
    return {
      tone: 'warning',
      short: waiting > 0 ? t('authSyncPillOfflineCount', waiting) : t('authSyncPillOffline'),
      Icon: WifiOff,
      spinning: false
    };
  }
  if (waiting > 0 && (summary.isSyncing || summary.syncingCount > 0)) {
    return { tone: 'warning', short: t('authSyncPillUploading', waiting), Icon: RefreshCw, spinning: true };
  }
  if (waiting > 0) {
    return { tone: 'warning', short: t('authSyncPillWaiting', waiting), Icon: CloudUpload, spinning: false };
  }
  return { tone: 'success', short: t('authSyncPillUpToDate'), Icon: CheckCircle2, spinning: false };
}

function syncRunMessage(
  report: SyncRunReport,
  t: (key: TranslationKey, ...args: (string | number)[]) => string
): { tone: Tone; text: string } {
  switch (report.status) {
    case 'completed':
      return report.synced > 0
        ? { tone: 'success', text: t('authSyncRunUploaded', report.synced) }
        : { tone: 'muted', text: t('authSyncRunNothing') };
    case 'stopped_on_failure':
      return { tone: 'danger', text: t('authSyncRunFailed', report.error ?? '') };
    case 'waiting_backoff':
      return { tone: 'warning', text: t('authSyncRunBackoff') };
    case 'offline':
      return { tone: 'warning', text: t('authSyncRunOffline') };
    case 'no_session':
      return { tone: 'danger', text: t('authSyncRunNoSession') };
    case 'busy_elsewhere':
      return { tone: 'muted', text: t('authSyncRunBusy') };
  }
}

/** This user's dead-lettered queue items (live). */
function useFailedItems(userId: string | null, enabled: boolean): OfflineQueueItem[] {
  const [items, setItems] = useState<OfflineQueueItem[]>([]);
  useEffect(() => {
    const db = offlineDB;
    if (!db || !userId || !enabled) return;
    const subscription = liveQuery(() =>
      db.syncQueue.where('[userId+syncState]').equals([userId, 'failed']).toArray()
    ).subscribe({
      next: (rows) => setItems([...rows].sort((a, b) => a.sequenceNumber - b.sequenceNumber)),
      error: () => setItems([])
    });
    return () => subscription.unsubscribe();
  }, [userId, enabled]);
  return enabled ? items : [];
}

export interface SyncDetailsProps {
  summary: OfflineSyncSummary;
  ready: boolean;
}

/** Everything the phone knows about uploads, with "Upload now" and "Retry failed uploads". */
export function SyncDetails({ summary, ready }: SyncDetailsProps) {
  const { t } = useTranslation();
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const failedItems = useFailedItems(userId, summary.failedCount > 0);
  const [busy, setBusy] = useState<'sync' | 'retry' | null>(null);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const waiting = summary.pendingCount + summary.syncingCount;

  const uploadNow = async () => {
    if (!syncEngine || busy) return;
    setBusy('sync');
    setMessage(null);
    try {
      const report = await syncEngine.triggerSync({ force: true });
      setMessage(syncRunMessage(report, t));
    } catch (error) {
      setMessage({ tone: 'danger', text: t('authSyncRunFailed', errorText(error)) });
    } finally {
      setBusy(null);
    }
  };

  const retryFailed = async () => {
    if (!syncEngine || busy || !userId) return;
    setBusy('retry');
    setMessage(null);
    try {
      const count = await syncEngine.retryFailed(userId);
      setMessage({ tone: 'muted', text: t('authSyncRetryQueued', count) });
    } catch (error) {
      setMessage({ tone: 'danger', text: t('authSyncRunFailed', errorText(error)) });
    } finally {
      setBusy(null);
    }
  };

  if (!syncEngine) {
    return <p className="text-sm text-ee-danger-text">{t('authSyncUnavailable')}</p>;
  }

  const rowClass = 'flex items-start justify-between gap-3 py-3';
  const labelClass = 'text-sm text-ee-muted';
  const valueClass = 'text-right font-display text-xl font-semibold leading-tight';

  return (
    <div className="space-y-4" data-testid="chrome-sync-details">
      <dl className="divide-y divide-ee-border border-y border-ee-border">
        <div className={rowClass}>
          <dt className={labelClass}>{t('authSyncConnection')}</dt>
          <dd
            className={`${valueClass} ${summary.isOnline ? 'text-ee-success' : 'text-ee-warning'}`}
            data-testid="chrome-sync-connection"
          >
            {!ready ? '…' : summary.isOnline ? t('authSyncOnline') : t('authSyncOffline')}
          </dd>
        </div>
        <div className={rowClass}>
          <dt className={labelClass}>
            {t('authSyncWaiting')}
            <span className="block text-xs">{t('authSyncWaitingHint')}</span>
          </dt>
          <dd className={`${valueClass} ${waiting > 0 ? 'text-ee-warning' : 'text-ee-text'}`} data-testid="chrome-sync-pending-count">
            {ready ? waiting : '…'}
          </dd>
        </div>
        <div className={rowClass}>
          <dt className={labelClass}>
            {t('authSyncFailed')}
            <span className="block text-xs">{t('authSyncFailedHint')}</span>
          </dt>
          <dd
            className={`${valueClass} ${summary.failedCount > 0 ? 'text-ee-danger-text' : 'text-ee-text'}`}
            data-testid="chrome-sync-failed-count"
          >
            {ready ? summary.failedCount : '…'}
          </dd>
        </div>
        <div className={rowClass}>
          <dt className={labelClass}>{t('authSyncLastUpload')}</dt>
          <dd className="text-right text-sm font-semibold" data-testid="chrome-sync-last-sync">
            {summary.lastSyncTimestamp ? formatSastDateTime(summary.lastSyncTimestamp) : t('authSyncNeverUploaded')}
          </dd>
        </div>
        {summary.otherUserCount > 0 && (
          <div className={rowClass}>
            <dt className={labelClass}>
              {t('authSyncOtherUsers')}
              <span className="block text-xs">{t('authSyncOtherUsersHint')}</span>
            </dt>
            <dd className={`${valueClass} text-ee-warning`} data-testid="chrome-sync-other-count">
              {summary.otherUserCount}
            </dd>
          </div>
        )}
      </dl>

      {auth.isOfflineSession && (
        <p className="rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-warning" data-testid="chrome-sync-offline-session">
          {t('authSyncOfflineSession')}
        </p>
      )}
      {summary.lastError && waiting + summary.failedCount > 0 && (
        <p className="break-words text-sm text-ee-muted" data-testid="chrome-sync-last-error">
          {t('authSyncLastProblem', readableSyncError(summary.lastError))}
        </p>
      )}
      {summary.storage?.persisted === false && (
        <p className="rounded-xl border border-ee-warning/60 bg-ee-warning/10 p-3 text-sm text-ee-warning">
          {t('authSyncStorageNotPersisted')}
        </p>
      )}
      {summary.storage?.nearlyFull && (
        <p className="rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm text-ee-danger-text">
          {t('authSyncStorageNearlyFull')}
        </p>
      )}

      {failedItems.length > 0 && (
        <div>
          <h3 className="font-display text-lg font-semibold text-ee-danger-text">{t('authSyncFailedListTitle')}</h3>
          <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="chrome-sync-failed-list">
            {failedItems.map((item) => (
              <li key={item.id} className="py-2 text-sm">
                <span className="font-semibold">{t(EVENT_TYPE_LABEL_KEYS[item.eventType])}</span>
                <span className="text-ee-muted"> · {formatSastDateTime(item.createdAt)}</span>
                {item.lastError && (
                  <span className="block break-words text-ee-danger-text">{readableSyncError(item.lastError)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-2">
        <button
          type="button"
          onClick={() => void uploadNow()}
          disabled={busy !== null}
          className={chromeButton.secondary}
          data-testid="chrome-sync-now"
        >
          <RefreshCw className={`h-5 w-5 ${busy === 'sync' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          <span>{busy === 'sync' ? t('authSyncUploading') : t('authSyncUploadNow')}</span>
        </button>
        {summary.failedCount > 0 && (
          <button
            type="button"
            onClick={() => void retryFailed()}
            disabled={busy !== null}
            className={chromeButton.danger}
            data-testid="chrome-sync-retry-failed"
          >
            <RotateCcw className="h-5 w-5" aria-hidden="true" />
            <span>{t('authSyncRetryFailed')}</span>
          </button>
        )}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`min-h-5 text-sm ${message ? toneForeground[message.tone] : ''}`}
        data-testid="chrome-sync-action-status"
      >
        {message?.text ?? ''}
      </p>
    </div>
  );
}

export interface SyncStatusButtonProps {
  /** Hide the button when there is nothing to report (manager header). */
  hideWhenIdle?: boolean;
  className?: string;
}

/** Status pill that opens the upload details dialog. */
export function SyncStatusButton({ hideWhenIdle = false, className = '' }: SyncStatusButtonProps) {
  const { t } = useTranslation();
  const { summary, ready } = useSyncSummary();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const view = describeSyncStatus(summary, ready, t);
  const idle =
    ready &&
    summary.isOnline &&
    summary.pendingCount + summary.syncingCount + summary.failedCount + summary.otherUserCount === 0;

  if (!syncEngine || (hideWhenIdle && (idle || !ready))) return null;
  const { Icon } = view;
  const spoken =
    ready && summary.otherUserCount > 0 ? `${view.short}. ${t('authSyncPillOtherUsers', summary.otherUserCount)}` : view.short;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('authSyncButtonLabel', spoken)}
        aria-haspopup="dialog"
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold ${toneText[view.tone]} ${className}`}
        data-testid="chrome-sync-pill"
        data-sync-tone={view.tone}
      >
        <Icon className={`h-4 w-4 flex-none ${view.spinning ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
        <span className="whitespace-nowrap">{view.short}</span>
        {summary.otherUserCount > 0 && <Users className="h-4 w-4 flex-none text-ee-warning" aria-hidden="true" />}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {ready ? spoken : ''}
      </span>
      <ModalDialog open={open} onClose={() => setOpen(false)} labelledBy={titleId} testId="chrome-sync-dialog">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-display text-2xl font-semibold">
            {t('authSyncTitle')}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="min-h-11 rounded-xl border border-ee-border px-4 text-sm font-semibold hover:bg-ee-surface-raised"
            data-testid="chrome-sync-dialog-close"
          >
            {t('authClose')}
          </button>
        </div>
        <SyncDetails summary={summary} ready={ready} />
      </ModalDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sign-out (refuses to hide unsynced records unless the user insists)
// ---------------------------------------------------------------------------

export function useSignOutFlow() {
  const auth = useAuth();
  const router = useRouter();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(
    (localOnly: boolean) => {
      try {
        window.sessionStorage.setItem(SIGN_OUT_NOTICE_KEY, localOnly ? 'local' : 'server');
      } catch {
        // The login page then simply shows no notice.
      }
      router.replace('/login');
    },
    [router]
  );

  const run = useCallback(
    async (force: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await auth.signOut(force ? { force: true } : undefined);
        if (result.ok) {
          setPendingCount(null);
          finish(result.localOnly);
        } else {
          setPendingCount(result.pendingCount);
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [auth, busy, finish]
  );

  return {
    busy,
    error,
    pendingCount,
    start: () => void run(false),
    signOutAnyway: () => void run(true),
    cancel: () => setPendingCount(null)
  };
}

export interface SignOutControlProps {
  variant?: 'header' | 'full';
  testId?: string;
}

/** Sign-out button + the "records not uploaded yet" dialog. */
export function SignOutControl({ variant = 'header', testId = 'chrome-signout' }: SignOutControlProps) {
  const { t } = useTranslation();
  const flow = useSignOutFlow();
  const titleId = useId();
  const bodyId = useId();

  return (
    <>
      <button
        type="button"
        onClick={flow.start}
        disabled={flow.busy}
        className={
          variant === 'full'
            ? `${chromeButton.danger} w-full min-h-14 text-base`
            : 'inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-ee-border bg-ee-surface px-3 text-sm font-semibold text-ee-danger-text hover:bg-ee-surface-raised disabled:opacity-50'
        }
        data-testid={testId}
      >
        <LogOut className="h-5 w-5" aria-hidden="true" />
        <span>{flow.busy ? t('authSigningOut') : t('authSignOut')}</span>
      </button>
      {flow.error && (
        <p role="alert" className="mt-2 text-sm text-ee-danger-text">
          {t('authSignOutFailed', flow.error)}
        </p>
      )}
      <ModalDialog
        open={flow.pendingCount !== null}
        onClose={flow.cancel}
        labelledBy={titleId}
        describedBy={bodyId}
        testId="chrome-signout-dialog"
      >
        <h2 id={titleId} className="font-display text-2xl font-semibold text-ee-warning">
          {t('authSignOutPendingTitle')}
        </h2>
        <div id={bodyId} className="mt-2 space-y-2 text-base">
          <p data-testid="chrome-signout-pending-count">{t('authSignOutPendingBody', flow.pendingCount ?? 0)}</p>
          <p className="text-sm text-ee-muted">{t('authSignOutPendingAdvice')}</p>
        </div>
        <div className="mt-5 grid gap-2">
          <button
            type="button"
            onClick={flow.cancel}
            className={`${chromeButton.primary} min-h-14 text-base`}
            data-autofocus
            data-testid="chrome-signout-cancel"
          >
            {t('authSignOutStay')}
          </button>
          <button
            type="button"
            onClick={flow.signOutAnyway}
            disabled={flow.busy}
            className={`${chromeButton.danger} min-h-14 text-left text-base`}
            data-testid="chrome-signout-force"
          >
            {t('authSignOutAnyway')}
          </button>
        </div>
      </ModalDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Manager header (admin / supervisor / viewer portals)
// ---------------------------------------------------------------------------

const ROLE_LABEL_KEYS: Array<[UserRole, TranslationKey]> = [
  ['super_admin', 'authRoleSuperAdmin'],
  ['admin', 'authRoleAdmin'],
  ['supervisor', 'authRoleSupervisor'],
  ['guard', 'authRoleGuard'],
  ['client_viewer', 'authRoleViewer']
];

interface HeaderNavProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  backHref?: string;
  rightAction?: React.ReactNode;
}

export function HeaderNav({ title, subtitle, showBack = false, backHref, rightAction }: HeaderNavProps) {
  const { t } = useTranslation();
  const { profile, roles, status } = useAuth();
  const home = homeForRoles(roles);
  const roleKey = ROLE_LABEL_KEYS.find(([role]) => roles.includes(role))?.[1];
  const displayName = profile ? `${profile.firstName} ${profile.lastName}`.trim() : '';

  return (
    <header className="sticky top-0 z-40 border-b border-ee-border bg-ee-bg pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {showBack && backHref && (
            <Link
              href={backHref}
              aria-label={t('authBack')}
              className="inline-flex min-h-11 min-w-11 flex-none items-center justify-center rounded-xl border border-ee-border text-ee-text hover:bg-ee-surface-raised"
              data-testid="chrome-header-back"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </Link>
          )}
          <Link
            href={home}
            className="flex flex-none items-center gap-2.5 text-ee-text no-underline"
            aria-label={t('authHomeLinkLabel')}
            data-testid="chrome-header-home"
          >
            <Image
              src="/eagle_eye_enhanced_emblem.jpg"
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 flex-none rounded-lg border border-ee-primary/70 object-cover"
              loading="eager"
            />
            <span className="hidden sm:block">
              <span className="block font-display text-lg font-bold uppercase leading-none tracking-wide">
                {t('authBrandName')}
              </span>
              <span className="mt-0.5 block text-xs font-semibold uppercase tracking-wider text-ee-primary">
                {t('authBrandOrg')}
              </span>
            </span>
          </Link>
          {(title || subtitle) && (
            <div className="min-w-0 border-l border-ee-border pl-3">
              {title && <h1 className="truncate font-display text-lg font-semibold leading-tight">{title}</h1>}
              {subtitle && <p className="truncate text-xs text-ee-muted">{subtitle}</p>}
            </div>
          )}
        </div>

        <div className="flex flex-none items-center gap-2">
          {rightAction}
          <SyncStatusButton hideWhenIdle />
          {status === 'signed_in' && displayName && (
            <div
              className="hidden items-center gap-2 rounded-lg border border-ee-border bg-ee-surface px-2.5 py-1.5 text-sm md:flex"
              data-testid="chrome-header-user"
            >
              <span className="max-w-40 truncate font-medium">{displayName}</span>
              {roleKey && (
                <span className="rounded border border-ee-primary/40 px-1.5 py-0.5 text-xs font-bold uppercase text-ee-primary">
                  {t(roleKey)}
                </span>
              )}
            </div>
          )}
          {status === 'signed_in' && <SignOutControl variant="header" testId="chrome-header-signout" />}
        </div>
      </div>
    </header>
  );
}
