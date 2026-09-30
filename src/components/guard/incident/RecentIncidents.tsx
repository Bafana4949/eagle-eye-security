'use client';

import React, { useEffect, useState } from 'react';
import Dexie from 'dexie';
import { useTranslation } from '@/lib/i18n/context';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { sastTimeHM, sastDateString } from '@/lib/config/siteTime';
import type { IncidentPayload, SyncState } from '@/types/offline';
import type { IncidentSeverity } from '@/types/models';
import { RecordStatusIcon, TONE_TEXT } from './RecordSyncStatus';
import {
  RECORD_STATUS_SHORT_KEYS,
  deriveRecordStatus,
  incidentTypeLabel,
  recordStatusTone,
  severityLabel,
  shortEventId
} from './incidentLogic';

interface RecentIncident {
  id: string;
  createdAt: string;
  incidentType: string;
  severity: IncidentSeverity;
  syncState: SyncState | undefined;
  lastError: string | undefined;
}

const RECENT_LIMIT = 5;
const POLL_MS = 5000;

/** This user's latest incident reports stored on this phone, with their real upload state. */
function useRecentIncidents(userId: string | null) {
  const [items, setItems] = useState<RecentIncident[] | null>(null);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const db = offlineDB;
    if (!userId || !db) return;
    let cancelled = false;

    const read = async () => {
      try {
        const events = await db.localEvents
          .where('[userId+type+sequenceNumber]')
          .between([userId, 'incident', Dexie.minKey], [userId, 'incident', Dexie.maxKey])
          .reverse()
          .limit(RECENT_LIMIT)
          .toArray();
        const queued = await db.syncQueue.bulkGet(events.map((event) => event.id));
        if (cancelled) return;
        setItems(
          events.map((event, index) => {
            const payload = event.payload as IncidentPayload;
            return {
              id: event.id,
              createdAt: event.createdAt,
              incidentType: payload.incidentType,
              severity: payload.severity,
              syncState: queued[index]?.syncState,
              lastError: queued[index]?.lastError
            };
          })
        );
      } catch {
        if (!cancelled) setItems((prev) => prev ?? []);
      }
    };

    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    const unsubscribe = syncEngine?.subscribe((summary) => {
      setIsOnline(summary.isOnline);
      void read();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [userId]);

  return { items: userId ? items : null, isOnline };
}

export function RecentIncidents({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { items, isOnline } = useRecentIncidents(userId);

  return (
    <section aria-labelledby="incident-recent-title" className="rounded-2xl border border-ee-border bg-ee-surface">
      <h2 id="incident-recent-title" className="px-4 pt-4 font-display text-xl font-bold text-ee-text">
        {t('incident.recent.title')}
      </h2>
      {items === null ? (
        <p className="px-4 py-4 text-base text-ee-muted">{t('incident.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-4 text-base text-ee-muted" data-testid="incident-recent-empty">
          {t('incident.recent.empty')}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-ee-border" data-testid="incident-recent-list">
          {items.map((item) => {
            const status = deriveRecordStatus({
              loaded: true,
              syncState: item.syncState,
              lastError: item.lastError,
              isOnline
            });
            return (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 px-4 py-3"
                data-testid="incident-recent-item"
                data-status={status}
              >
                <div className="min-w-0">
                  <p className="break-words text-base font-semibold text-ee-text">
                    {incidentTypeLabel(item.incidentType, t)}
                  </p>
                  <p className="text-sm text-ee-muted">
                    {sastDateString(item.createdAt)} {sastTimeHM(item.createdAt)} · {severityLabel(item.severity, t)} ·{' '}
                    {shortEventId(item.id)}
                  </p>
                </div>
                <span className={`flex shrink-0 items-center gap-1 text-sm font-semibold ${TONE_TEXT[recordStatusTone(status)]}`}>
                  <RecordStatusIcon status={status} className="h-4 w-4" />
                  {t(RECORD_STATUS_SHORT_KEYS[status])}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
