'use client';

import React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import type { RoundProgress } from './patrolLogic';

interface RoundProgressListProps {
  /** null while the clock, the site or the checkpoints are not known yet. */
  progress: RoundProgress | null;
}

/** Dawie-style list of the current round: every active checkpoint with ✓ time or "not yet". */
export function RoundProgressList({ progress }: RoundProgressListProps) {
  const { t } = useTranslation();
  if (!progress) return null;

  let heading: React.ReactNode = t('patrolRoundHeading');
  let summary: React.ReactNode = null;
  let content: React.ReactNode = null;

  if (progress.kind === 'config_error') {
    content = <p className="px-4 py-3 text-sm text-ee-warning">{t('patrolRoundConfigError', progress.message)}</p>;
  } else if (progress.kind === 'before_start') {
    content = <p className="px-4 py-3 text-sm text-ee-muted">{t('patrolRoundBeforeStart', formatTimeHM(progress.startMs))}</p>;
  } else if (progress.kind === 'after_end') {
    content = <p className="px-4 py-3 text-sm text-ee-warning">{t('patrolRoundAfterEnd', formatTimeHM(progress.endMs))}</p>;
  } else {
    const total = progress.items.length;
    const allDone = total > 0 && progress.doneCount === total;
    heading = t(
      'patrolRoundTitle',
      progress.roundNumber,
      progress.totalRounds,
      formatTimeHM(progress.windowStart),
      formatTimeHM(progress.windowEnd)
    );
    summary = (
      <p className={`text-sm ${allDone ? 'text-ee-success' : 'text-ee-muted'}`} data-testid="patrol-round-done">
        {allDone ? t('patrolRoundAllDone') : t('patrolRoundDone', progress.doneCount, total)}
      </p>
    );
    content =
      total === 0 ? (
        <p className="px-4 py-3 text-sm text-ee-muted">{t('patrolCpEmpty')}</p>
      ) : (
        <ul className="divide-y divide-ee-border" data-testid="patrol-round-list">
          {progress.items.map(({ checkpoint, scannedAtMs }) => (
            <li
              key={checkpoint.id}
              className="flex min-h-12 items-center justify-between gap-3 px-4 py-3"
              data-testid="patrol-round-item"
              data-checkpoint-id={checkpoint.id}
              data-state={scannedAtMs === null ? 'open' : 'done'}
            >
              <span className="min-w-0 break-words text-ee-text">{checkpoint.name}</span>
              {scannedAtMs === null ? (
                <span className="shrink-0 text-sm text-ee-muted">{t('patrolRoundNotYet')}</span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-ee-success">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {formatTimeHM(scannedAtMs)}
                </span>
              )}
            </li>
          ))}
        </ul>
      );
  }

  return (
    <section className="rounded-xl border border-ee-border bg-ee-surface" aria-labelledby="patrol-round-heading">
      <div className="border-b border-ee-border px-4 py-3">
        <h2 id="patrol-round-heading" className="font-display text-lg font-semibold text-ee-text" data-testid="patrol-round-title">
          {heading}
        </h2>
        {summary}
      </div>
      {content}
    </section>
  );
}
