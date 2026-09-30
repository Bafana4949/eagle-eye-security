'use client';

import React from 'react';
import { AlarmClock, AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { PatrolAlarmState } from '@/lib/patrol/alarm';
import { durationText } from './patrolText';

interface PatrolAlarmBannerProps {
  alarm: PatrolAlarmState | null;
  onAcknowledge: () => void;
  /** Set when the round alarm cannot run (e.g. a round interval of 0) – shown, never hidden. */
  configError: string | null;
  checkpointNames: ReadonlyMap<string, string>;
}

/**
 * Round alarm from usePatrolAlarm (reference rules): 'late' = no scan for one round interval
 * plus 10 minutes; 'soon' = at most 10 minutes of the round left with open checkpoints.
 * Vibration and the beep come from the hook; this is the visible part.
 */
export function PatrolAlarmBanner({ alarm, onAcknowledge, configError, checkpointNames }: PatrolAlarmBannerProps) {
  const { t } = useTranslation();

  if (configError) {
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-xl border border-ee-warning/50 bg-ee-warning/10 p-3 text-sm text-ee-warning"
        data-testid="patrol-alarm-config-error"
      >
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{t('patrolAlarmConfig', configError)}</span>
      </p>
    );
  }
  if (!alarm) return null;

  const late = alarm.type === 'late';
  const open = (alarm.openCheckpoints ?? []).map((id) => checkpointNames.get(id) ?? '?');
  const minutesLeft = Math.max(1, Math.ceil((alarm.remainingMs ?? 0) / 60000));

  return (
    <div
      role="alert"
      data-testid="patrol-alarm"
      data-alarm-type={alarm.type}
      className={`rounded-xl p-4 ${
        late ? 'bg-ee-danger text-ee-bg' : 'bg-ee-primary text-ee-on-primary'
      }`}
    >
      <p className="flex items-center gap-2 font-display text-xl font-bold leading-tight">
        <AlarmClock className="h-6 w-6 shrink-0" aria-hidden="true" />
        <span>{late ? t('patrolAlarmLateTitle') : t('patrolAlarmSoonTitle', minutesLeft)}</span>
      </p>
      <p className="mt-1 font-medium">
        {late
          ? t('patrolAlarmLateBody', durationText(t, alarm.sinceMs ?? 0))
          : t('patrolAlarmSoonBody', open.length, open.join(', '))}
      </p>
      <button
        type="button"
        onClick={onAcknowledge}
        data-testid="patrol-alarm-ack"
        className="mt-3 min-h-12 w-full rounded-lg border border-ee-bg/30 bg-ee-bg/15 px-4 font-semibold hover:bg-ee-bg/25"
      >
        {t('patrolAlarmAck')}
      </button>
    </div>
  );
}
