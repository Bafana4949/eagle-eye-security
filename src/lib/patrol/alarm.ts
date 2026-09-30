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
let lastBeepTimestamp = 0;

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
 * Triggers an 880Hz pulsed square-wave alert beep and vibration pattern
 */
export function triggerAlarmBeep(isLate = false): void {
  const now = Date.now();
  // Minimum 120s between 'late' beeps, 600s between 'soon' beeps to avoid battery drain
  const minInterval = isLate ? 120000 : 600000;
  if (now - lastBeepTimestamp < minInterval) {
    return;
  }
  lastBeepTimestamp = now;

  // 1. Tactile vibration
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try {
      navigator.vibrate([400, 200, 400, 200, 400]);
    } catch {
      // Ignored
    }
  }

  // 2. Audible Synthesizer Beep
  unlockAudioContext();
  if (!audioCtx || audioCtx.state !== 'running') return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square';
    osc.frequency.value = 880; // 880 Hz standard alert tone
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const t0 = audioCtx.currentTime;
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
 * Screen Wake Lock: Keeps the guard phone screen awake while on duty
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
 * Determines whether a round is overdue or about to expire with unvisited checkpoints
 */
export function evaluatePatrolAlarm(
  nowMs: number,
  shiftStartMs: number,
  shiftEndMs: number,
  intervalMinutes: number,
  checkpointIds: string[],
  scanLog: Array<{ checkpointId: string; timestampMs: number }>
): PatrolAlarmState | null {
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
  if (nowMs - lastScanMs > ivMs + 10 * 60000) {
    return {
      type: 'late',
      sinceMs: nowMs - lastScanMs,
      roundKey: roundStartMs
    };
  }

  // 2. EXPIRING SOON ALERT: <= 10 minutes remaining in current round with unvisited checkpoints
  const remainingMs = roundEndMs - nowMs;
  if (remainingMs > 0 && remainingMs <= 10 * 60000) {
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
