'use client';

import React from 'react';
import { useTranslation } from '@/lib/i18n/context';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import { confidenceTone, syncTone, toneTextClass, type ShiftScan } from './patrolLogic';
import { methodText, shortConfidenceText, shortSyncText } from './patrolText';

interface RecentScansListProps {
  scans: ReadonlyArray<ShiftScan>;
  /** Checkpoint names by id (the name stored with the scan is used when the id is unknown). */
  checkpointNames: ReadonlyMap<string, string>;
  loaded: boolean;
  error: string | null;
  limit?: number;
}

/** The latest scans of this shift with the phone's GPS estimate and the real upload state. */
export function RecentScansList({ scans, checkpointNames, loaded, error, limit = 8 }: RecentScansListProps) {
  const { t } = useTranslation();
  const recent = scans.slice(-limit).reverse();

  return (
    <section className="rounded-xl border border-ee-border bg-ee-surface" aria-labelledby="patrol-recent-heading">
      <h2 id="patrol-recent-heading" className="border-b border-ee-border px-4 py-3 font-display text-lg font-semibold text-ee-text">
        {t('patrolRecentHeading')}
      </h2>
      {error && <p className="px-4 pt-3 text-sm text-ee-danger">{error}</p>}
      {loaded && recent.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ee-muted" data-testid="patrol-recent-empty">
          {t('patrolRecentEmpty')}
        </p>
      ) : (
        <ul className="divide-y divide-ee-border" data-testid="patrol-recent-list">
          {recent.map((scan) => (
            <li
              key={scan.id}
              className="px-4 py-3"
              data-testid="patrol-recent-item"
              data-event-id={scan.id}
              data-sync={scan.syncState}
              data-confidence={scan.gpsConfidence ?? 'no_fix'}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words font-semibold text-ee-text">
                  {checkpointNames.get(scan.checkpointId) ?? scan.checkpointName ?? '—'}
                </span>
                <span className="shrink-0 font-display text-lg text-ee-text">{formatTimeHM(scan.atMs)}</span>
              </div>
              <p className="mt-1 text-sm">
                <span className="text-ee-muted">{methodText(t, scan.method, scan.payloadType)}</span>
                <span className="text-ee-muted"> · </span>
                <span className={toneTextClass(confidenceTone(scan.gpsConfidence ?? 'no_fix'))}>
                  {shortConfidenceText(t, scan.gpsConfidence)}
                </span>
                <span className="text-ee-muted"> · </span>
                <span className={toneTextClass(syncTone(scan.syncState))}>{shortSyncText(t, scan.syncState)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
