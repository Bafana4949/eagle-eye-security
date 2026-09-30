'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import { sastTimeHM } from '@/lib/config/siteTime';
import {
  buildRoundGrid,
  complianceTone,
  formatSpan,
  formatWhen,
  personName,
  toMs,
  type ShiftReport,
  type UncoveredWindow
} from '../data/derive';
import type { PersonInfo } from '../data/types';
import { EvidencePhoto } from './EvidencePhoto';
import { shiftStatusLabel, shiftStatusTone, shiftTypeLabel, TFn, TONE_TEXT } from './labels';
import { Chip, EmptyLine } from './Primitives';

/** Dawie's report grid: checkpoints × rounds with the time of the first scan in each round. */
export function RoundGridTable({ report, now, testId }: { report: ShiftReport; now: number; testId: string }) {
  const { t } = useTranslation();
  const grid = buildRoundGrid(report, now);
  if (!grid) return <p className="text-sm text-ee-muted">{t('supGridUnavailable')}</p>;
  if (grid.rows.length === 0) return <p className="text-sm text-ee-muted">{t('supNoCheckpoints')}</p>;
  // `relative`: the sr-only cell labels are absolutely positioned; without a positioned scroller
  // they escape it and widen the whole page on a 320 px phone.
  return (
    <div className="relative overflow-x-auto rounded-lg border border-ee-border" data-testid={testId}>
      <table className="min-w-full border-collapse text-sm">
        <caption className="sr-only">{t('supGridCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 bg-ee-surface px-2 py-1.5 text-left font-semibold text-ee-muted">
              {t('supCheckpoint')}
            </th>
            {grid.rounds.map((round) => (
              <th
                key={round.roundNumber}
                scope="col"
                className={`whitespace-nowrap px-2 py-1.5 text-center font-semibold tabular-nums ${
                  round.state === 'current' ? 'text-ee-primary' : 'text-ee-muted'
                }`}
              >
                {sastTimeHM(round.windowStart)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.checkpointId} className="border-t border-ee-border">
              <th scope="row" className="sticky left-0 max-w-[9rem] truncate bg-ee-surface px-2 py-1.5 text-left font-semibold text-ee-text">
                {row.name}
              </th>
              {row.cells.map((cell, index) => {
                const state = grid.rounds[index].state;
                if (cell !== null) {
                  return (
                    <td key={index} className="whitespace-nowrap px-2 py-1.5 text-center tabular-nums text-ee-success">
                      {sastTimeHM(cell)}
                    </td>
                  );
                }
                if (state === 'past') {
                  return (
                    <td key={index} className="px-2 py-1.5 text-center font-bold text-ee-danger-text">
                      <span aria-hidden="true">✗</span>
                      <span className="sr-only">{t('supMissed')}</span>
                    </td>
                  );
                }
                return (
                  <td key={index} className="px-2 py-1.5 text-center text-ee-muted">
                    <span aria-hidden="true">{state === 'current' ? '…' : '·'}</span>
                    <span className="sr-only">{state === 'current' ? t('supRoundOpen') : t('supRoundLater')}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statsLines(t: TFn, report: ShiftReport): string[] {
  const stats = report.stats;
  if (!stats) return [];
  const lines: string[] = [];
  lines.push(t('supRoundsDone', stats.roundsCompleted, stats.roundsDue, stats.roundsScheduled));
  if (stats.roundInProgress) {
    lines.push(
      t(
        'supRoundInProgress',
        stats.roundInProgress.visitedCount,
        stats.roundInProgress.visitedCount + stats.roundInProgress.openCheckpoints.length,
        sastTimeHM(stats.roundInProgress.windowEnd)
      )
    );
  }
  lines.push(
    t(
      'supScansSummary',
      stats.totalScans,
      stats.scansVerified + stats.scansLikely,
      stats.scansLowConfidence + stats.scansNoGps,
      stats.scansOutsideRadius
    )
  );
  if (stats.missedByCheckpoint.length > 0) {
    lines.push(t('supMissedPoints', stats.missedByCheckpoint.map((m) => `${m.name} ×${m.missedCount}`).join(', ')));
  }
  if (stats.longestGapMs > 0) lines.push(t('supLongestGap', formatSpan(stats.longestGapMs)));
  if (stats.leftEarlyMs > 0) lines.push(t('supLeftEarly', formatSpan(stats.leftEarlyMs)));
  return lines;
}

function ReportRow({
  report,
  people,
  showSite,
  showSelfies,
  now,
  testId
}: {
  report: ShiftReport;
  people: Readonly<Record<string, PersonInfo>>;
  showSite: boolean;
  showSelfies: boolean;
  now: number;
  testId: string;
}) {
  const { t } = useTranslation();
  const { shift, site, stats } = report;
  const percent = stats?.completionPercent ?? null;
  const tone = complianceTone(percent);
  const start = toMs(shift.actual_start);
  const end = toMs(shift.actual_end);
  const lines = statsLines(t, report);
  return (
    <li data-testid={`${testId}-row`} data-shift-id={shift.id}>
      <details className="group">
        <summary className="flex min-h-12 cursor-pointer list-none gap-3 px-3 py-3 hover:bg-ee-surface-raised [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold text-ee-text">
                {shiftTypeLabel(t, shift.shift_type)} · {formatWhen(toMs(shift.scheduled_start), now)}
              </span>
              <Chip tone={shiftStatusTone(shift.status)}>{shiftStatusLabel(t, shift.status)}</Chip>
              {report.clockOutOverdue && <Chip tone="warning">{t('supClockOutMissing')}</Chip>}
            </div>
            <p className="text-sm text-ee-muted">
              {personName(people, shift.guard_id) ?? t('supUnknownPerson')}
              {showSite && site ? ` · ${site.name}` : ''}
            </p>
            <p className="text-xs text-ee-muted">
              {start === null
                ? t('supNotClockedIn')
                : end === null
                  ? t('supClockedInAt', formatWhen(start, now))
                  : t('supClockInOut', formatWhen(start, now), formatWhen(end, now))}
            </p>
            {report.problem && (
              <p className="text-xs font-semibold text-ee-danger-text">
                {report.problem === 'no_site' ? t('supSiteNotVisible') : t('supScheduleInvalid')}
              </p>
            )}
            {lines.length > 0 && <p className="text-xs text-ee-muted">{lines[0]}</p>}
          </div>
          <div className="flex flex-none flex-col items-end gap-1">
            <span
              className={`font-display text-3xl font-bold leading-none tabular-nums ${TONE_TEXT[tone]}`}
              data-testid={`${testId}-percent`}
            >
              {percent === null ? '–' : `${percent}%`}
            </span>
            <span className="text-xs text-ee-muted">
              {percent === null ? t('supNothingDue') : t('supVisitsOf', stats?.checkpointVisits ?? 0, stats?.expectedCheckpointVisits ?? 0)}
            </span>
            <ChevronDown
              className="h-5 w-5 text-ee-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </div>
        </summary>
        <div className="space-y-2 px-3 pb-3">
          {lines.slice(1).map((line) => (
            <p key={line} className="text-sm text-ee-text">
              {line}
            </p>
          ))}
          <RoundGridTable report={report} now={now} testId={`${testId}-grid`} />
          {showSelfies && (shift.start_selfie_url || shift.end_selfie_url) && (
            <div className="flex flex-wrap items-start gap-2 pt-1">
              {shift.start_selfie_url && (
                <EvidencePhoto path={shift.start_selfie_url} label={t('supClockInSelfie')} testId={`${testId}-selfie-in`} />
              )}
              {shift.end_selfie_url && (
                <EvidencePhoto path={shift.end_selfie_url} label={t('supClockOutSelfie')} testId={`${testId}-selfie-out`} />
              )}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * Patrol compliance per shift (from scans received by the server), plus the scheduled shifts
 * that nobody clocked in for. Newest first. `showSelfies` (supervisors only): clock-in / clock-out
 * selfies open through short-lived signed URLs; client viewers never get selfie paths.
 */
export function ShiftComplianceList({
  reports,
  uncovered,
  people,
  sites,
  showSite,
  showSelfies = false,
  now,
  testId
}: {
  reports: readonly ShiftReport[];
  uncovered: readonly UncoveredWindow[];
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  showSelfies?: boolean;
  now: number;
  testId: string;
}) {
  const { t } = useTranslation();
  type Item = { kind: 'report'; at: number; report: ShiftReport } | { kind: 'gap'; at: number; gap: UncoveredWindow };
  const items: Item[] = [
    ...reports.map((report) => ({ kind: 'report' as const, at: toMs(report.shift.scheduled_start) ?? 0, report })),
    ...uncovered.map((gap) => ({ kind: 'gap' as const, at: gap.start, gap }))
  ].sort((a, b) => b.at - a.at);

  if (items.length === 0) return <EmptyLine testId={`${testId}-empty`}>{t('supNoShifts')}</EmptyLine>;

  return (
    <ul className="divide-y divide-ee-border overflow-hidden rounded-lg border border-ee-border bg-ee-surface" data-testid={testId}>
      {items.map((item) =>
        item.kind === 'report' ? (
          <ReportRow
            key={item.report.shift.id}
            report={item.report}
            people={people}
            showSite={showSite}
            showSelfies={showSelfies}
            now={now}
            testId={testId}
          />
        ) : (
          <li key={`${item.gap.siteId}-${item.gap.start}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3" data-testid={`${testId}-gap`}>
            <div className="min-w-0">
              <p className="font-semibold text-ee-text">
                {shiftTypeLabel(t, item.gap.shiftType)} · {formatWhen(item.gap.start, now)}
              </p>
              {showSite && <p className="text-sm text-ee-muted">{sites.get(item.gap.siteId)?.name ?? ''}</p>}
            </div>
            <Chip tone="danger">{t('supNoGuardClockedIn')}</Chip>
          </li>
        )
      )}
    </ul>
  );
}
