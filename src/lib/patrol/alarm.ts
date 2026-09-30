/**
 * Web Audio Alarm & Screen Wake Lock Service
 * Provides audible alert beeps, tactile vibration, and screen keep-awake
 * during guard night/day patrol duties.
 */

export interface PatrolAlarmState {
  type: 'late' | 'soon';
  remainingMs?: number;
  sinceMs?: number;
  openCheckpoints?: string[];
  roundKey?: number;
}

let audioCtx: AudioContext | null = null;
let activeWakeLock: WakeLockSentinel | null = null;
// Separate throttles so a 'late' beep never suppresses a 'soon' beep (and vice versa).
const lastBeepTimestamp: Record<PatrolAlarmState['type'], number> = { late: 0, soon: 0 };

/** Minimum time between repeated beeps of the same alarm type (reference app values). */
export const BEEP_REPEAT_MS: Readonly<Record<PatrolAlarmState['type'], number>> = { late: 120000, soon: 600000 };
/** How often the guard UI should re-evaluate the alarm (reference: every 20 s). */
export const ALARM_CHECK_INTERVAL_MS = 20000;
/** 'late' alarm fires when no scan for one round interval plus this grace. */
export const LATE_GRACE_MS = 10 * 60000;
/** 'soon' alarm fires when this much (or less) of the current round remains with open points. */
export const SOON_WINDOW_MS = 10 * 60000;
/** Acknowledging a 'late' alarm silences it for this long. */
export const LATE_ACK_SNOOZE_MS = 5 * 60000;

/**
 * Unlocks the Web Audio API on user interaction (tap/click/key)
 */
export function unlockAudioContext(): void {
  if (typeof window === 'undefined') return;

  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!audioCtx && AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
  } catch {
    // AudioContext not supported
  }
}

/**
 * Triggers an 880Hz pulsed square-wave alert beep and vibration pattern.
 * Repeats of the same type are throttled (120 s late / 600 s soon) to save battery;
 * pass force=true for a manual test tone (device-test page).
 * Returns false when the beep was throttled.
 */
export function triggerAlarmBeep(isLate = false, force = false): boolean {
  const now = Date.now();
  const type: PatrolAlarmState['type'] = isLate ? 'late' : 'soon';
  if (!force && now - lastBeepTimestamp[type] < BEEP_REPEAT_MS[type]) {
    return false;
  }
  if (!force) lastBeepTimestamp[type] = now;

  // 1. Tactile vibration
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try {
      navigator.vibrate([400, 200, 400, 200, 400]);
    } catch {
      // Ignored
    }
  }

  // 2. Audible Synthesizer Beep (needs a prior user gesture to unlock audio on mobile)
  unlockAudioContext();
  const ctx = audioCtx;
  if (!ctx) return true;
  if (ctx.state === 'running') {
    playAlertTone(ctx);
  } else {
    // resume() is asynchronous: a context suspended while the page was in the background
    // (or 'interrupted' on iOS) would otherwise skip this beep and the throttle would hide the
    // next one for minutes. Play once it is running; without a prior gesture it stays silent.
    ctx
      .resume()
      .then(() => {
        if (ctx.state === 'running') playAlertTone(ctx);
      })
      .catch(() => undefined);
  }
  return true;
}

function playAlertTone(ctx: AudioContext): void {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.value = 880; // 880 Hz standard alert tone
    osc.connect(gain);
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);

    // 3 short burst pulses: 0s, 0.4s, 0.8s
    [0, 0.4, 0.8].forEach((d) => {
      gain.gain.setValueAtTime(0.35, t0 + d);
      gain.gain.setValueAtTime(0, t0 + d + 0.22);
    });

    osc.start(t0);
    osc.stop(t0 + 1.2);
  } catch {
    // Synthesizer failed
  }
}

/**
 * Screen Wake Lock: one-off request (device-test page). The browser drops the lock whenever the
 * page is hidden; for a shift use keepScreenAwake() / useKeepScreenAwake(), which re-acquire it.
 */
export async function requestScreenWakeLock(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    return false;
  }

  if (activeWakeLock) return true;

  try {
    const sentinel = await navigator.wakeLock.request('screen');
    activeWakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      activeWakeLock = null;
    });
    return true;
  } catch {
    return false;
  }
}

export function releaseScreenWakeLock(): void {
  if (activeWakeLock) {
    void activeWakeLock.release();
    activeWakeLock = null;
  }
}

/**
 * Determines whether a round is overdue or about to expire with unvisited checkpoints.
 * Rounds are aligned to shiftStartMs (the active shift's SCHEDULED start) and use the site's
 * round interval; pass only the active site checkpoints and this shift's scans.
 * Throws RangeError for a non-positive interval (a misconfigured site must not silently
 * disable the alarm).
 */
export function evaluatePatrolAlarm(
  nowMs: number,
  shiftStartMs: number,
  shiftEndMs: number,
  intervalMinutes: number,
  checkpointIds: string[],
  scanLog: Array<{ checkpointId: string; timestampMs: number }>
): PatrolAlarmState | null {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError(`Invalid round interval: ${intervalMinutes} minutes`);
  }
  if (nowMs < shiftStartMs || nowMs >= shiftEndMs || checkpointIds.length === 0) {
    return null;
  }

  const ivMs = intervalMinutes * 60000;
  const roundIndex = Math.floor((nowMs - shiftStartMs) / ivMs);
  const roundStartMs = shiftStartMs + roundIndex * ivMs;
  const roundEndMs = Math.min(roundStartMs + ivMs, shiftEndMs);

  const scansInShift = scanLog.filter((s) => s.timestampMs >= shiftStartMs && s.timestampMs <= nowMs);
  const lastScanMs = scansInShift.length > 0 ? Math.max(...scansInShift.map((s) => s.timestampMs)) : shiftStartMs;

  // 1. OVERDUE ALERT: No scan for interval + 10 minutes grace period
  if (nowMs - lastScanMs > ivMs + LATE_GRACE_MS) {
    return {
      type: 'late',
      sinceMs: nowMs - lastScanMs,
      roundKey: roundStartMs
    };
  }

  // 2. EXPIRING SOON ALERT: <= 10 minutes remaining in current round with unvisited checkpoints
  const remainingMs = roundEndMs - nowMs;
  if (remainingMs > 0 && remainingMs <= SOON_WINDOW_MS) {
    const visitedInRound = new Set(
      scanLog
        .filter((s) => s.timestampMs >= roundStartMs && s.timestampMs < roundEndMs)
        .map((s) => s.checkpointId)
    );

    const openCheckpoints = checkpointIds.filter((id) => !visitedInRound.has(id));
    if (openCheckpoints.length > 0) {
      return {
        type: 'soon',
        remainingMs,
        openCheckpoints,
        roundKey: roundStartMs
      };
    }
  }

  return null;
}

export interface AlarmAckState {
  /** roundKey of the 'soon' alarm the guard acknowledged. */
  soonAckRoundKey?: number | null;
  /** 'late' alarm silenced until this epoch ms. */
  lateSnoozedUntilMs?: number | null;
}

/** Whether an evaluated alarm should be shown, given the guard's acknowledgements (reference rules). */
export function isAlarmVisible(alarm: PatrolAlarmState | null, ack: AlarmAckState, nowMs: number): boolean {
  if (!alarm) return false;
  if (alarm.type === 'soon') return alarm.roundKey === undefined || alarm.roundKey !== ack.soonAckRoundKey;
  return !(ack.lateSnoozedUntilMs != null && nowMs < ack.lateSnoozedUntilMs);
}

/** New acknowledgement state after the guard taps "acknowledge". */
export function acknowledgeAlarm(alarm: PatrolAlarmState, ack: AlarmAckState, nowMs: number): AlarmAckState {
  if (alarm.type === 'soon') return { ...ack, soonAckRoundKey: alarm.roundKey ?? null };
  return { ...ack, lateSnoozedUntilMs: nowMs + LATE_ACK_SNOOZE_MS };
}
