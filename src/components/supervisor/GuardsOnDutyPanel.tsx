'use client';

import React from 'react';
import { PhoneCall } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { sastTimeHM } from '@/lib/config/siteTime';
import { formatSpan, formatWhen, personName, toMs, type ActivityItem, type ShiftReport } from './data/derive';
import type { PersonInfo } from './data/types';
import { EvidencePhoto } from './ui/EvidencePhoto';
import { activityText } from './ActivityFeed';
import { shiftTypeLabel, telHref } from './ui/labels';
import { Chip, DividedList, EmptyLine } from './ui/Primitives';

function PatrolStateChip({ report, now }: { report: ShiftReport; now: number }) {
  const { t } = useTranslation();
  if (report.problem) return <Chip tone="danger">{t('supScheduleInvalid')}</Chip>;
  if (report.clockOutOverdue) return <Chip tone="warning">{t('supClockOutMissing')}</Chip>;
  const alarm = report.alarm;
  if (alarm?.type === 'late') {
    return (
      <Chip tone="danger" data-testid="supervisor-guard-overdue">
        {t('supRoundOverdue', formatSpan(alarm.sinceMs ?? 0))}
      </Chip>
    );
  }
  if (alarm?.type === 'soon') {
    return (
      <Chip tone="warning">
        {t('supRoundClosing', Math.max(1, Math.ceil((alarm.remainingMs ?? 0) / 60000)), alarm.openCheckpoints?.length ?? 0)}
      </Chip>
    );
  }
  const start = toMs(report.shift.scheduled_start);
  if (start !== null && now < start) return <Chip tone="muted">{t('supBeforeSchedule')}</Chip>;
  return <Chip tone="success">{t('supOnDuty')}</Chip>;
}

/**
 * Guards with an open shift (clock-in received, no clock-out yet), with their patrol progress
 * for the current shift window and their last activity that reached the server.
 */
export function GuardsOnDutyPanel({
  reports,
  lastActivity,
  people,
  showSite,
  now
}: {
  reports: readonly ShiftReport[];
  lastActivity: ReadonlyMap<string, ActivityItem>;
  people: Readonly<Record<string, PersonInfo>>;
  showSite: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  if (reports.length === 0) return <EmptyLine testId="supervisor-guards-empty">{t('supNoGuardsOnDuty')}</EmptyLine>;

  return (
    <DividedList testId="supervisor-guards">
      {reports.map((report) => {
        const { shift, site, stats } = report;
        const person = people[shift.guard_id];
        const clockIn = toMs(shift.actual_start);
        const last = lastActivity.get(shift.guard_id);
        const scheduledStart = toMs(shift.scheduled_start);
        const scheduledEnd = toMs(shift.scheduled_end);
        return (
          <li key={shift.id} className="space-y-1.5 px-3 py-3" data-testid="supervisor-guard-row" data-shift-id={shift.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-display text-xl font-semibold text-ee-text">
                {personName(people, shift.guard_id) ?? t('supUnknownPerson')}
              </span>
              <PatrolStateChip report={report} now={now} />
            </div>
            <p className="text-sm text-ee-muted">
              {showSite && site ? `${site.name} · ` : ''}
              {shiftTypeLabel(t, shift.shift_type)}
              {scheduledStart !== null && scheduledEnd !== null ? ` ${sastTimeHM(scheduledStart)}–${sastTimeHM(scheduledEnd)}` : ''}
            </p>
            <p className="text-sm text-ee-text">
              {clockIn !== null ? t('supClockedInAt', formatWhen(clockIn, now)) : t('supNotClockedIn')}
              {shift.start_accuracy_meters != null ? ` (±${Math.round(shift.start_accuracy_meters)} m)` : ''}
            </p>
            <p className="text-sm text-ee-text" data-testid="supervisor-guard-last-seen">
              {last
                ? t('supLastActivity', formatWhen(last.at, now), formatSpan(now - last.at), activityText(t, last))
                : t('supNoActivityYet')}
            </p>
            {stats && (
              <p className="text-sm text-ee-muted" data-testid="supervisor-guard-progress">
                {t('supRoundsDone', stats.roundsCompleted, stats.roundsDue, stats.roundsScheduled)}
                {stats.roundInProgress
                  ? ` · ${t(
                      'supRoundInProgress',
                      stats.roundInProgress.visitedCount,
                      stats.roundInProgress.visitedCount + stats.roundInProgress.openCheckpoints.length,
                      sastTimeHM(stats.roundInProgress.windowEnd)
                    )}`
                  : ''}
              </p>
            )}
            {report.alarm?.type === 'soon' && report.alarm.openCheckpoints && report.alarm.openCheckpoints.length > 0 && (
              <p className="text-xs text-ee-warning">
                {t(
                  'supOpenPoints',
                  report.expected
                    .filter((cp) => report.alarm?.openCheckpoints?.includes(cp.id))
                    .map((cp) => cp.name)
                    .join(', ')
                )}
              </p>
            )}
            <div className="flex flex-wrap items-start gap-2 pt-1">
              {person?.phone && (
                <a
                  href={telHref(person.phone)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-text! no-underline hover:bg-ee-surface-raised"
                  data-testid="supervisor-guard-call"
                >
                  <PhoneCall className="h-4 w-4" aria-hidden="true" />
                  {t('supCallGuard', person.phone)}
                </a>
              )}
              {shift.start_selfie_url ? (
                <EvidencePhoto path={shift.start_selfie_url} label={t('supClockInSelfie')} testId="supervisor-guard-selfie" />
              ) : (
                <span className="inline-flex min-h-11 items-center text-xs text-ee-muted">{t('supNoSelfie')}</span>
              )}
            </div>
          </li>
        );
      })}
    </DividedList>
  );
}
