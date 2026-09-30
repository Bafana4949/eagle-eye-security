/**
 * Keeps the guard's screen awake for the whole shift.
 *
 * The Screen Wake Lock API releases a 'screen' lock automatically whenever the page is hidden
 * (the guard switches to WhatsApp, the camera or the phone app). A lock requested once at
 * clock-in is therefore lost the first time the guard leaves the app, the screen then sleeps,
 * and with it Web NFC readings (delivered to visible documents only), vibration and the round
 * alarm timers silently stop. Like the reference app, this controller re-requests the lock
 * whenever the page becomes visible again and on the next tap while no lock is held.
 *
 * Tested with a fake WakeLock/document; real wake-lock behaviour (battery saver, OEM power
 * management) must be checked on the guards' phones.
 */

/** Structural subset of WakeLockSentinel. */
export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** Structural subset of navigator.wakeLock. */
export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Structural subset of document used for re-acquisition. */
export interface KeepAwakeDocumentLike {
  visibilityState: string;
  addEventListener(type: 'visibilitychange' | 'pointerdown', listener: () => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: 'visibilitychange' | 'pointerdown', listener: () => void, options?: boolean | EventListenerOptions): void;
}

export interface KeepScreenAwakeOptions {
  /** Test injection; defaults to navigator.wakeLock (null: API unavailable). */
  wakeLock?: WakeLockApiLike | null;
  /** Test injection; defaults to the global document. */
  document?: KeepAwakeDocumentLike | null;
  /** Called whenever the lock is gained or lost. */
  onChange?: (held: boolean) => void;
}

export interface ScreenKeepAwake {
  /** true while a wake lock is held. */
  isHeld(): boolean;
  /** Requests the lock now if none is held (normally automatic). Resolves to isHeld(). */
  refresh(): Promise<boolean>;
  /** Stops re-acquiring and releases the lock. Idempotent. */
  stop(): void;
}

function defaultWakeLock(): WakeLockApiLike | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as { wakeLock?: WakeLockApiLike }).wakeLock;
  return api && typeof api.request === 'function' ? api : null;
}

/** Starts keeping the screen awake until stop() is called. Never throws. */
export function keepScreenAwake(options: KeepScreenAwakeOptions = {}): ScreenKeepAwake {
  const api = options.wakeLock !== undefined ? options.wakeLock : defaultWakeLock();
  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== 'undefined'
        ? (document as unknown as KeepAwakeDocumentLike)
        : null;
  let stopped = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending: Promise<boolean> | null = null;

  const notify = (held: boolean) => {
    try {
      options.onChange?.(held);
    } catch {
      // A throwing UI callback must not break re-acquisition.
    }
  };
  const isHeld = () => sentinel !== null && sentinel.released !== true;

  const acquire = (): Promise<boolean> => {
    if (stopped || !api) return Promise.resolve(false);
    if (isHeld()) return Promise.resolve(true);
    // Requests are rejected while the page is hidden; the visibilitychange handler retries.
    if (doc && doc.visibilityState !== 'visible') return Promise.resolve(false);
    if (pending) return pending;
    const attempt = (async () => {
      try {
        const lock = await api.request('screen');
        if (stopped) {
          void lock.release().catch(() => undefined);
          return false;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel !== lock) return;
          sentinel = null;
          notify(false);
        });
        notify(true);
        return true;
      } catch {
        // NotAllowedError (page hidden, battery saver): retried on the next visibility change or tap.
        return false;
      }
    })();
    pending = attempt;
    void attempt.finally(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };

  const onVisibilityChange = () => {
    if (doc?.visibilityState === 'visible') void acquire();
  };
  const onPointerDown = () => {
    if (!isHeld()) void acquire();
  };

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  doc?.addEventListener('pointerdown', onPointerDown, { passive: true });
  void acquire();

  return {
    isHeld,
    refresh: acquire,
    stop() {
      if (stopped) return;
      stopped = true;
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
      doc?.removeEventListener('pointerdown', onPointerDown);
      const lock = sentinel;
      sentinel = null;
      if (lock && lock.released !== true) void lock.release().catch(() => undefined);
    }
  };
}
