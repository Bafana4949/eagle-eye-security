'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALARM_CHECK_INTERVAL_MS,
  acknowledgeAlarm,
  evaluatePatrolAlarm,
  isAlarmVisible,
  triggerAlarmBeep,
  type AlarmAckState,
  type PatrolAlarmState
} from './alarm';
import { useKeepScreenAwake } from './useKeepScreenAwake';

export interface UsePatrolAlarmInput {
  /** false when there is no active shift or the site disabled the alarm. */
  enabled: boolean;
  /**
   * Keep the screen awake (re-acquired every time the guard returns to the app). Defaults to
   * `enabled`; pass the "has an open shift" flag when the alarm itself is switched off.
   */
  keepScreenAwake?: boolean;
  /** Active shift's SCHEDULED window (epoch ms); rounds are aligned to its start. */
  scheduledStartMs: number | null;
  scheduledEndMs: number | null;
  /** sites.round_interval_minutes */
  roundIntervalMinutes: number;
  /** Active checkpoint ids of the site. */
  checkpointIds: string[];
  /** This shift's local scans. */
  scans: Array<{ checkpointId: string; timestampMs: number }>;
}

export interface UsePatrolAlarmResult {
  /** The alarm to display (null when none or acknowledged). */
  alarm: PatrolAlarmState | null;
  acknowledge: () => void;
  /** Set when the configuration is invalid (e.g. round interval 0) – show it, do not hide it. */
  configError: string | null;
  /** Whether a screen wake lock is currently held (false: the screen may sleep – say so). */
  screenAwake: boolean;
}

/**
 * Evaluates the patrol round alarm every 20 s (and when the page becomes visible), beeps and
 * vibrates through triggerAlarmBeep (throttled per alarm type), and lets the guard acknowledge
 * it: a 'soon' alarm stays hidden for that round, a 'late' alarm is snoozed for 5 minutes.
 * While enabled it also keeps the screen awake, re-acquiring the wake lock after the guard
 * returns from WhatsApp / the camera (the browser drops it whenever the page is hidden).
 */
export function usePatrolAlarm(input: UsePatrolAlarmInput): UsePatrolAlarmResult {
  const screenAwake = useKeepScreenAwake(input.keepScreenAwake ?? input.enabled);
  const inputRef = useRef(input);
  const ackRef = useRef<AlarmAckState>({});
  const alarmRef = useRef<PatrolAlarmState | null>(null);
  const [alarm, setAlarmState] = useState<PatrolAlarmState | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const setAlarm = useCallback((next: PatrolAlarmState | null) => {
    alarmRef.current = next;
    setAlarmState(next);
  }, []);

  // Keep the latest inputs for the interval callback without restarting the timer.
  useEffect(() => {
    inputRef.current = input;
  });

  const evaluate = useCallback(() => {
    const cur = inputRef.current;
    if (!cur.enabled || cur.scheduledStartMs === null || cur.scheduledEndMs === null) {
      setAlarm(null);
      setConfigError(null);
      return;
    }
    const now = Date.now();
    let next: PatrolAlarmState | null;
    try {
      next = evaluatePatrolAlarm(
        now,
        cur.scheduledStartMs,
        cur.scheduledEndMs,
        cur.roundIntervalMinutes,
        cur.checkpointIds,
        cur.scans
      );
      setConfigError(null);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
      setAlarm(null);
      return;
    }
    if (next && isAlarmVisible(next, ackRef.current, now)) {
      setAlarm(next);
      triggerAlarmBeep(next.type === 'late');
    } else {
      setAlarm(null);
    }
  }, [setAlarm]);

  useEffect(() => {
    // Evaluate from timer callbacks (never synchronously inside the effect body).
    const kick = setTimeout(evaluate, 0);
    const timer = setInterval(evaluate, ALARM_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') evaluate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [evaluate]);

  // Re-evaluate immediately when a scan is recorded or the shift changes.
  const scanCount = input.scans.length;
  useEffect(() => {
    const kick = setTimeout(evaluate, 0);
    return () => clearTimeout(kick);
  }, [evaluate, scanCount, input.enabled, input.scheduledStartMs, input.scheduledEndMs, input.roundIntervalMinutes]);

  const acknowledge = useCallback(() => {
    const current = alarmRef.current;
    if (current) ackRef.current = acknowledgeAlarm(current, ackRef.current, Date.now());
    setAlarm(null);
  }, [setAlarm]);

  return { alarm, acknowledge, configError, screenAwake };
}
