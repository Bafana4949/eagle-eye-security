'use client';

import { useCallback, useEffect, useState } from 'react';
import { triggerAlarmBeep, unlockAudioContext } from '@/lib/patrol/alarm';

/** While an SOS is unacknowledged and not silenced, the alarm repeats this often. */
export const SOS_REPEAT_MS = 20_000;

export interface PanicAlarm {
  /** An active SOS is not silenced on this screen: sound + vibration are repeating. */
  sounding: boolean;
  /** Browsers only allow sound after the user has touched the page once. */
  soundBlocked: boolean;
  /** Silences the current alerts on this screen only; a NEW alert sounds again. */
  silence: () => void;
}

/**
 * Sound and vibration for active SOS alerts on the supervisor screen. It repeats until the alert
 * is acknowledged in the database (it then leaves `activeIds`) or the supervisor silences this
 * screen. It also sets the tab title, with the number of active alerts when there are any.
 */
export function usePanicAlarm(
  activeIds: readonly string[],
  titles: { base: string; withAlerts: (count: number) => string }
): PanicAlarm {
  const [interacted, setInteracted] = useState(false);
  const [silenced, setSilenced] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (interacted) return;
    const onGesture = () => {
      unlockAudioContext();
      setInteracted(true);
    };
    window.addEventListener('pointerdown', onGesture, { once: true });
    window.addEventListener('keydown', onGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, [interacted]);

  const loudIds = activeIds.filter((id) => !silenced.has(id));
  const loudKey = [...loudIds].sort().join(',');

  useEffect(() => {
    if (loudKey === '') return;
    triggerAlarmBeep(true, true);
    const id = window.setInterval(() => triggerAlarmBeep(true, true), SOS_REPEAT_MS);
    return () => window.clearInterval(id);
  }, [loudKey, interacted]);

  const count = activeIds.length;
  const title = count > 0 ? titles.withAlerts(count) : titles.base;
  useEffect(() => {
    const original = document.title;
    document.title = title;
    return () => {
      document.title = original;
    };
  }, [title]);

  const idsKey = [...activeIds].sort().join(',');
  const silence = useCallback(() => {
    setSilenced(new Set(idsKey ? idsKey.split(',') : []));
  }, [idsKey]);

  return { sounding: loudKey !== '', soundBlocked: !interacted, silence };
}
