'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { liveQuery } from 'dexie';
import { ArrowLeft, Camera } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import { offlineDB } from '@/lib/offline/db';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import {
  HISTORY_LIMIT,
  describeGuardEvent,
  gpsSummary,
  loadGuardEvents,
  loadGuardShifts,
  readableSyncError,
  shiftOptionLabel,
  syncStateView,
  type GuardEventRow,
  type HistoryFilter,
  type ShiftOption,
  type Tone
} from './guardEvents';

const toneText: Record<Tone, string> = {
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger-text',
  muted: 'text-ee-muted'
};

const toneBadge: Record<Tone, string> = {
  success: 'border-ee-success/60 bg-ee-success/10 text-ee-success',
  warning: 'border-ee-warning/60 bg-ee-warning/10 text-ee-warning',
  danger: 'border-ee-danger/70 bg-ee-danger/15 text-ee-danger-text',
  muted: 'border-ee-border bg-ee-surface text-ee-muted'
};

type LoadState<T> = { key: string; status: 'loading' } | { key: string; status: 'ready'; data: T } | { key: string; status: 'error'; message: string };

/**
 * Subscribes to a Dexie live query (re-runs when the tables it read change). `key` identifies
 * the query: a new key starts a new subscription.
 */
function useLiveData<T>(key: string | null, query: (() => Promise<T>) | null): LoadState<T> | null {
  const queryRef = useRef(query);
  const [state, setState] = useState<LoadState<T> | null>(null);
  useEffect(() => {
    queryRef.current = query;
  });
  useEffect(() => {
    if (!key) return;
    const subscription = liveQuery(() => {
      const run = queryRef.current;
      return run ? run() : Promise.reject(new Error('No query'));
    }).subscribe({
      next: (data) => setState({ key, status: 'ready', data }),
      error: (error: unknown) =>
        setState({ key, status: 'error', message: error instanceof Error ? error.message : String(error) })
    });
    return () => subscription.unsubscribe();
  }, [key]);
  if (!key || !query) return null;
  return state && state.key === key ? state : { key, status: 'loading' };
}

function HistoryRow({ row }: { row: GuardEventRow }) {
  const { t } = useTranslation();
  const { event } = row;
  const description = describeGuardEvent(event, t);
  const gps = gpsSummary(event, t);
  const upload = syncStateView(row.syncState, t);
  const isAlert = event.type === 'panic' || event.type === 'incident';

  return (
    <li className="flex gap-3 py-3" data-testid="history-row" data-event-type={event.type} data-sync-state={row.syncState}>
      <div className="w-14 flex-none">
        <span className="block font-display text-xl font-semibold leading-tight tabular-nums">{sastTimeHM(event.createdAt)}</span>
        <span className="block text-xs text-ee-muted">{sastDateString(event.createdAt).slice(5)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className={`break-words text-base font-semibold ${isAlert ? 'text-ee-danger-text' : 'text-ee-text'}`}>{description.title}</p>
        {description.details.map((detail, index) => (
          <p key={index} className="break-words text-sm text-ee-muted">
            {index === description.details.length - 1 && event.mediaFields.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Camera className="h-4 w-4" aria-hidden="true" />
                {detail}
              </span>
            ) : (
              detail
            )}
          </p>
        ))}
        {gps && <p className={`text-sm ${toneText[gps.tone]}`}>{gps.text}</p>}
        {row.syncState === 'failed' && row.lastError && (
          <p className="break-words text-sm text-ee-danger-text" data-testid="history-row-error">
            {readableSyncError(row.lastError)}
          </p>
        )}
      </div>
      <div className="flex-none">
        <span
          className={`inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${toneBadge[upload.tone]}`}
          data-testid="history-row-sync"
        >
          {upload.text}
        </span>
      </div>
    </li>
  );
}

export default function GuardHistoryPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const db = offlineDB;
  const selectId = useId();
  // null = not chosen yet: show the newest shift (or everything when there is none).
  const [choice, setChoice] = useState<string | null>(null);

  const shifts = useLiveData<ShiftOption[]>(
    db && userId ? `shifts:${userId}` : null,
    db && userId ? () => loadGuardShifts(db, userId) : null
  );
  const shiftOptions = shifts?.status === 'ready' ? shifts.data : [];
  const shiftsLoaded = shifts?.status === 'ready' || shifts?.status === 'error';
  const selected = choice ?? (shiftsLoaded ? shiftOptions[0]?.shiftId ?? 'all' : null);
  const filter: HistoryFilter | null = selected === null ? null : selected === 'all' ? { kind: 'all' } : { kind: 'shift', shiftId: selected };

  const events = useLiveData<GuardEventRow[]>(
    db && userId && filter ? `events:${userId}:${selected}` : null,
    db && userId && filter ? () => loadGuardEvents(db, userId, filter) : null
  );

  const rows = events?.status === 'ready' ? events.data : [];

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <Link
          href="/guard/more"
          aria-label={t('authBackToMore')}
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised"
          data-testid="history-back"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Link>
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold leading-tight">{t('history')}</h1>
          <p className="text-sm text-ee-muted">{t('authHistSubtitle')}</p>
        </div>
      </div>

      {!db ? (
        <p className="text-base text-ee-danger-text" role="alert">
          {t('authHistNoStorage')}
        </p>
      ) : (
        <>
          <div>
            <label htmlFor={selectId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
              {t('authHistFilterLabel')}
            </label>
            <select
              id={selectId}
              value={selected ?? 'all'}
              onChange={(event) => setChoice(event.target.value)}
              disabled={!shiftsLoaded}
              className="min-h-12 w-full rounded-xl border border-ee-border bg-ee-surface px-3 text-base text-ee-text focus:border-ee-primary focus:outline-none"
              data-testid="history-shift-filter"
            >
              <option value="all">{t('authHistAllRecords')}</option>
              {shiftOptions.map((option) => (
                <option key={option.shiftId} value={option.shiftId}>
                  {shiftOptionLabel(option, t)}
                </option>
              ))}
            </select>
          </div>

          <div aria-live="polite" data-testid="history-list-region">
            {(events === null || events.status === 'loading') && (
              <p role="status" className="py-6 text-center text-base text-ee-muted">
                {t('authLoading')}
              </p>
            )}
            {events?.status === 'error' && (
              <p role="alert" className="py-6 text-base text-ee-danger-text" data-testid="history-error">
                {t('authHistLoadFailed', events.message)}
              </p>
            )}
            {events?.status === 'ready' && rows.length === 0 && (
              <p className="py-8 text-center text-base text-ee-muted" data-testid="history-empty">
                {selected === 'all' ? t('authHistEmpty') : t('authHistEmptyShift')}
              </p>
            )}
            {rows.length > 0 && (
              <>
                <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="history-list">
                  {rows.map((row) => (
                    <HistoryRow key={row.event.id} row={row} />
                  ))}
                </ul>
                {rows.length >= HISTORY_LIMIT && (
                  <p className="pt-3 text-sm text-ee-muted">{t('authHistLimited', HISTORY_LIMIT)}</p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
