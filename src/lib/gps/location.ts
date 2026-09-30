/**
 * Location fixes for events (checkpoint scan, clock-in/out, incident, gate entry).
 *
 * Every outcome is explicit: the caller records the failure kind (patrol_scans.gps_error)
 * instead of silently saving a scan without coordinates.
 *
 * How a fix is obtained (reference app behaviour):
 * 1. While a shift is active the page keeps a warm watch (startLocationWatch). GNSS then stays
 *    locked between checkpoints, and getLocationFix answers instantly with the latest watched
 *    fix when the app received it no longer than maxAgeMs ago.
 * 2. Otherwise one high-accuracy getCurrentPosition request.
 * 3. If that times out, one low-accuracy retry (network/cell position). Its real accuracy is
 *    reported, so the server's confidence rules downgrade it (low_confidence / outside)
 *    instead of the event losing all location evidence.
 *
 * Freshness is judged by RECEIPT time on the device clock, not by comparing
 * position.timestamp with Date.now(): on Android the fix time comes from the location
 * provider and a phone clock a few minutes off would otherwise discard every fresh fix as
 * stale. The browser guarantees that a delivered position is no older than the requested
 * maximumAge; a larger difference is reported as clockSkewMs (diagnostic only).
 * A watched fix older than STALE_FIX_MS is returned as 'stale' (with its coordinates) and
 * must not be treated as the guard's current position.
 *
 * Browser behaviour (permission prompts, GPS cold start, indoor accuracy) has not been
 * field-tested by these unit tests; they drive a fake Geolocation object.
 */

/** A fix older than this is stale (same 120 s window as the reference app). */
export const STALE_FIX_MS = 120000;

/** Extra grace on top of timeoutMs in case the browser never calls either callback. */
const WATCHDOG_GRACE_MS = 2000;
/**
 * While the location permission prompt is open the browser's own timeout does not run
 * (Geolocation spec). Give the guard this long to answer before the watchdog gives up.
 */
export const PERMISSION_PROMPT_WATCHDOG_MS = 60000;
/** Differences between the device clock and the fix time within this margin are not skew. */
const CLOCK_SKEW_TOLERANCE_MS = 5000;
/** Low-accuracy retry after a high-accuracy timeout. */
export const COARSE_RETRY_TIMEOUT_MS = 8000;
/** Warm watch options (reference app: high accuracy, 30 s maximumAge, 30 s timeout). */
const WATCH_MAX_AGE_MS = 30000;
const WATCH_TIMEOUT_MS = 30000;

type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>;
type WatchGeolocationLike = Pick<Geolocation, 'watchPosition' | 'clearWatch'> & Partial<GeolocationLike>;

/** Structural subset of PermissionStatus. */
export interface PermissionStatusLike {
  state: string;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

/** Structural subset of navigator.permissions. */
export interface PermissionsLike {
  query(descriptor: { name: 'geolocation' }): Promise<PermissionStatusLike>;
}

export interface LocationFixOptions {
  /** Maximum age of a cached position (Geolocation maximumAge, and for the warm watch). */
  maxAgeMs?: number;
  timeoutMs?: number;
  highAccuracy?: boolean;
  /** Retry once with low accuracy after a high-accuracy timeout (default true). */
  coarseRetry?: boolean;
  coarseRetryTimeoutMs?: number;
  /**
   * Warm watch to answer from. Defaults to the shared watch started with startLocationWatch()
   * when the real navigator.geolocation is used; pass null to always ask the browser.
   */
  watch?: Pick<LocationWatchHandle, 'peek'> | null;
  /** Test injection; defaults to navigator.geolocation. */
  geolocation?: GeolocationLike | null;
  /** Test injection; defaults to navigator.permissions (null: unknown permission state). */
  permissions?: PermissionsLike | null;
  /** Test injection; defaults to window.isSecureContext. */
  isSecureContext?: boolean;
  now?: () => number;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  /** Metres (95% radius as reported by the browser). */
  accuracy: number;
  /** Epoch ms of the fix as reported by the device's location provider (position.timestamp). */
  timestamp: number;
  /**
   * Age of the fix: time since the app received it (device clock) plus the age the browser
   * reported at receipt, bounded by the requested maximumAge.
   */
  ageMs: number;
  /** Device-clock epoch ms when the app received the fix. */
  receivedAt?: number;
  /**
   * receivedAt − timestamp when that difference cannot be explained by the fix's age, i.e. the
   * phone clock and the location clock disagree. null when consistent. Diagnostic only.
   */
  clockSkewMs?: number | null;
  /** current: getCurrentPosition; watch: warm watch; coarse_retry: low-accuracy retry. */
  source?: 'current' | 'watch' | 'coarse_retry';
}

export type LocationFixResult =
  | ({ status: 'ok' } & LocationFix)
  | ({ status: 'stale' } & LocationFix)
  | { status: 'permission_denied' | 'timeout' | 'unavailable' | 'unsupported' | 'insecure'; message: string };

export type LocationFailureStatus = Exclude<LocationFixResult['status'], 'ok' | 'stale'>;
type FailureResult = Extract<LocationFixResult, { message: string }>;

/** Maps GeolocationPositionError.code (1/2/3) to a failure status. */
export function mapGeolocationErrorCode(code: number): 'permission_denied' | 'unavailable' | 'timeout' {
  if (code === 1) return 'permission_denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}

export function isFixStale(timestamp: number, now: number = Date.now()): boolean {
  return now - timestamp > STALE_FIX_MS;
}

function validCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

interface ReceivedFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  receivedAt: number;
  /** Age at receipt, bounded by the maximumAge the browser was asked for. */
  ageAtReceiptMs: number;
  clockSkewMs: number | null;
}

/** Converts a browser position into a received fix, or null when the coordinates are impossible. */
function receivePosition(position: GeolocationPosition, receivedAt: number, maxAgeMs: number): ReceivedFix | null {
  const { latitude, longitude, accuracy } = position.coords;
  if (!validCoordinates(latitude, longitude)) return null;
  const timestamp = Number.isFinite(position.timestamp) ? position.timestamp : receivedAt;
  const reportedAge = receivedAt - timestamp;
  // The browser promised a position no older than maxAgeMs. A bigger (or negative) difference
  // means the phone clock and the location provider's clock disagree: the true age is then
  // unknown but bounded by maxAgeMs, so that bound is used (conservative for staleness).
  const skewed = reportedAge > maxAgeMs + CLOCK_SKEW_TOLERANCE_MS || reportedAge < -CLOCK_SKEW_TOLERANCE_MS;
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : Number.POSITIVE_INFINITY,
    timestamp,
    receivedAt,
    ageAtReceiptMs: skewed ? maxAgeMs : Math.min(Math.max(0, reportedAge), maxAgeMs),
    clockSkewMs: skewed ? reportedAge : null
  };
}

function toResult(fix: ReceivedFix, now: number, source: NonNullable<LocationFix['source']>): LocationFixResult {
  const ageMs = fix.ageAtReceiptMs + Math.max(0, now - fix.receivedAt);
  const out: LocationFix = {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy: fix.accuracy,
    timestamp: fix.timestamp,
    ageMs,
    receivedAt: fix.receivedAt,
    clockSkewMs: fix.clockSkewMs,
    source
  };
  return ageMs > STALE_FIX_MS ? { status: 'stale', ...out } : { status: 'ok', ...out };
}

function defaultSecureContext(): boolean {
  return typeof window !== 'undefined' ? window.isSecureContext === true : true;
}

function defaultGeolocation(): Geolocation | null {
  return typeof navigator !== 'undefined' && navigator.geolocation ? navigator.geolocation : null;
}

function defaultPermissions(): PermissionsLike | null {
  if (typeof navigator === 'undefined') return null;
  const permissions = (navigator as { permissions?: PermissionsLike }).permissions;
  return permissions && typeof permissions.query === 'function' ? permissions : null;
}

const INSECURE: FailureResult = {
  status: 'insecure',
  message: 'Location needs a secure (https) connection. Open the app from its https link.'
};
const UNSUPPORTED: FailureResult = { status: 'unsupported', message: 'This device or browser does not provide location.' };

interface SingleRequest {
  geolocation: GeolocationLike;
  permissions: PermissionsLike | null;
  /** false when the permission is known to be answered already (retry after a browser timeout). */
  promptPossible: boolean;
  highAccuracy: boolean;
  timeoutMs: number;
  maxAgeMs: number;
  now: () => number;
}

/**
 * One getCurrentPosition request with a watchdog. The watchdog only counts time the browser's
 * own timeout counts: while the permission state is 'prompt' (or unknown) it allows
 * PERMISSION_PROMPT_WATCHDOG_MS for the guard to answer, and restarts the normal allowance
 * once the permission is granted.
 */
function requestPosition(req: SingleRequest): Promise<ReceivedFix | FailureResult> {
  return new Promise((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let permissionStatus: PermissionStatusLike | null = null;
    const normalAllowance = req.timeoutMs + WATCHDOG_GRACE_MS;

    const onPermissionChange = () => {
      if (permissionStatus && permissionStatus.state !== 'prompt') arm(normalAllowance);
    };
    const finish = (result: ReceivedFix | FailureResult) => {
      if (settled) return;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      permissionStatus?.removeEventListener?.('change', onPermissionChange);
      resolve(result);
    };
    function arm(ms: number) {
      if (settled) return;
      if (watchdog !== undefined) clearTimeout(watchdog);
      // Some Android browsers never invoke either callback when location services are off.
      watchdog = setTimeout(() => finish({ status: 'timeout', message: 'No location response from the device.' }), ms);
    }

    // Until the permission state is known (or when it cannot be queried), assume a prompt may
    // be showing.
    arm(req.promptPossible ? PERMISSION_PROMPT_WATCHDOG_MS + normalAllowance : normalAllowance);
    if (req.promptPossible && req.permissions) {
      req.permissions
        .query({ name: 'geolocation' })
        .then((status) => {
          if (settled) return;
          permissionStatus = status;
          if (status.state === 'prompt') {
            status.addEventListener?.('change', onPermissionChange);
          } else {
            arm(normalAllowance);
          }
        })
        .catch(() => {
          // Permission state unknown: keep the long allowance.
        });
    }

    try {
      req.geolocation.getCurrentPosition(
        (position) => {
          const fix = receivePosition(position, req.now(), req.maxAgeMs);
          finish(fix ?? { status: 'unavailable', message: 'The device returned invalid coordinates.' });
        },
        (error) => {
          const status = mapGeolocationErrorCode(error?.code);
          finish({ status, message: error?.message || status });
        },
        { enableHighAccuracy: req.highAccuracy, timeout: req.timeoutMs, maximumAge: req.maxAgeMs }
      );
    } catch (error) {
      finish({ status: 'unavailable', message: error instanceof Error ? error.message : String(error) });
    }
  });
}

function isFailure(value: ReceivedFix | FailureResult): value is FailureResult {
  return 'status' in value;
}

/** Requests a location fix for an event. Never rejects. */
export async function getLocationFix(options: LocationFixOptions = {}): Promise<LocationFixResult> {
  const {
    maxAgeMs = 30000,
    timeoutMs = 10000,
    highAccuracy = true,
    coarseRetry = true,
    coarseRetryTimeoutMs = COARSE_RETRY_TIMEOUT_MS
  } = options;
  const now = options.now ?? (() => Date.now());

  const secure = options.isSecureContext ?? defaultSecureContext();
  if (!secure) return INSECURE;

  const usingRealGeolocation = options.geolocation === undefined;
  const geolocation = usingRealGeolocation ? defaultGeolocation() : options.geolocation;
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') return UNSUPPORTED;

  // 1. Warm watch.
  const watch = options.watch !== undefined ? options.watch : usingRealGeolocation ? sharedWatch?.handle ?? null : null;
  const watched = watch?.peek(maxAgeMs) ?? null;
  if (watched) return watched;

  const permissions = options.permissions !== undefined ? options.permissions : defaultPermissions();

  // 2. One request as asked.
  const first = await requestPosition({ geolocation, permissions, promptPossible: true, highAccuracy, timeoutMs, maxAgeMs, now });
  if (!isFailure(first)) return toResult(first, now(), 'current');
  if (first.status !== 'timeout' || !highAccuracy || !coarseRetry) return first;

  // 3. High accuracy timed out (tree cover, cold GNSS): one low-accuracy retry. maximumAge is
  //    capped at the stale limit so the browser never hands back an older cached position.
  const retry = await requestPosition({
    geolocation,
    permissions: null,
    promptPossible: false,
    highAccuracy: false,
    timeoutMs: coarseRetryTimeoutMs,
    maxAgeMs: STALE_FIX_MS,
    now
  });
  if (!isFailure(retry)) return toResult(retry, now(), 'coarse_retry');
  return retry.status === 'timeout' ? first : retry;
}

// ---------------------------------------------------------------------------
// Warm watch (kept running while a shift is active)
// ---------------------------------------------------------------------------

export interface LocationWatchOptions {
  /** Test injection; defaults to navigator.geolocation (then the watch is shared, see below). */
  geolocation?: WatchGeolocationLike | null;
  /** Test injection; defaults to window.isSecureContext. */
  isSecureContext?: boolean;
  now?: () => number;
  /** Called with every received fix (e.g. to show "GPS ±8 m" in the UI). */
  onFix?: (fix: LocationFixResult) => void;
  /** Called on watch errors (the watch keeps running; the browser retries). */
  onError?: (status: LocationFailureStatus, message: string) => void;
}

export interface LocationWatchHandle {
  /**
   * The latest watched fix when its age (see LocationFix.ageMs) is at most maxAgeMs, else null.
   */
  peek(maxAgeMs?: number): LocationFixResult | null;
  /** The last watch error, cleared by the next fix. null while healthy or not started. */
  lastError(): FailureResult | null;
  /** Stops this handle's use of the watch (the browser watch ends when no handle remains). Idempotent. */
  stop(): void;
}

interface WatchState {
  geolocation: WatchGeolocationLike;
  id: number | null;
  latest: ReceivedFix | null;
  lastError: FailureResult | null;
  refs: number;
  now: () => number;
  listeners: Set<Pick<LocationWatchOptions, 'onFix' | 'onError'>>;
  handle: LocationWatchHandle;
}

/** The watch on the real navigator.geolocation, shared by every page that starts one. */
let sharedWatch: WatchState | null = null;

function failedHandle(error: FailureResult): LocationWatchHandle {
  return { peek: () => null, lastError: () => error, stop: () => undefined };
}

/**
 * Starts (or joins) a continuous high-accuracy location watch. Keep it running while a shift
 * is active so GNSS stays locked between checkpoints; stop it at clock-out / unmount.
 * Watches on the real navigator.geolocation are reference-counted and shared, and
 * getLocationFix uses them automatically.
 */
export function startLocationWatch(options: LocationWatchOptions = {}): LocationWatchHandle {
  const secure = options.isSecureContext ?? defaultSecureContext();
  if (!secure) {
    options.onError?.(INSECURE.status, INSECURE.message);
    return failedHandle(INSECURE);
  }
  const shared = options.geolocation === undefined;
  const geolocation = shared ? defaultGeolocation() : options.geolocation;
  if (!geolocation || typeof geolocation.watchPosition !== 'function') {
    options.onError?.(UNSUPPORTED.status, UNSUPPORTED.message);
    return failedHandle(UNSUPPORTED);
  }

  const listener = { onFix: options.onFix, onError: options.onError };
  if (shared && sharedWatch && sharedWatch.geolocation === geolocation && sharedWatch.id !== null) {
    sharedWatch.refs++;
    sharedWatch.listeners.add(listener);
    return joinHandle(sharedWatch, listener);
  }

  const state: WatchState = {
    geolocation,
    id: null,
    latest: null,
    lastError: null,
    refs: 1,
    now: options.now ?? (() => Date.now()),
    listeners: new Set([listener]),
    handle: null as unknown as LocationWatchHandle
  };
  state.handle = {
    peek: (maxAgeMs = WATCH_MAX_AGE_MS) => {
      if (!state.latest) return null;
      const result = toResult(state.latest, state.now(), 'watch');
      return result.status === 'ok' && result.ageMs <= maxAgeMs ? result : null;
    },
    lastError: () => state.lastError,
    stop: () => undefined
  };

  const emitError = (error: FailureResult) => {
    state.lastError = error;
    for (const l of state.listeners) {
      try {
        l.onError?.(error.status, error.message);
      } catch {
        // A throwing UI callback must not stop the watch.
      }
    }
  };
  const accept = (fix: ReceivedFix) => {
    state.latest = fix;
    state.lastError = null;
    const result = toResult(fix, state.now(), 'watch');
    for (const l of state.listeners) {
      try {
        l.onFix?.(result);
      } catch {
        // ignore UI callback failure
      }
    }
  };

  try {
    state.id = geolocation.watchPosition(
      (position) => {
        const fix = receivePosition(position, state.now(), WATCH_MAX_AGE_MS);
        if (fix) accept(fix);
        else emitError({ status: 'unavailable', message: 'The device returned invalid coordinates.' });
      },
      (error) => {
        const status = mapGeolocationErrorCode(error?.code);
        emitError({ status, message: error?.message || status });
        // Reference app: after a high-accuracy timeout ask once for a coarse position so the
        // latest fix does not go stale under tree cover. Its real accuracy is kept.
        if (status === 'timeout' && typeof geolocation.getCurrentPosition === 'function') {
          try {
            geolocation.getCurrentPosition(
              (position) => {
                const fix = receivePosition(position, state.now(), STALE_FIX_MS);
                if (fix && (!state.latest || fix.receivedAt > state.latest.receivedAt)) accept(fix);
              },
              () => undefined,
              { enableHighAccuracy: false, timeout: COARSE_RETRY_TIMEOUT_MS, maximumAge: STALE_FIX_MS }
            );
          } catch {
            // ignore: the watch keeps trying
          }
        }
      },
      { enableHighAccuracy: true, maximumAge: WATCH_MAX_AGE_MS, timeout: WATCH_TIMEOUT_MS }
    );
  } catch (error) {
    const failure: FailureResult = { status: 'unavailable', message: error instanceof Error ? error.message : String(error) };
    options.onError?.('unavailable', failure.message);
    return failedHandle(failure);
  }

  if (shared) sharedWatch = state;
  return joinHandle(state, listener);
}

function joinHandle(state: WatchState, listener: Pick<LocationWatchOptions, 'onFix' | 'onError'>): LocationWatchHandle {
  let stopped = false;
  return {
    peek: state.handle.peek,
    lastError: state.handle.lastError,
    stop: () => {
      if (stopped) return;
      stopped = true;
      state.listeners.delete(listener);
      state.refs--;
      if (state.refs > 0 || state.id === null) return;
      try {
        state.geolocation.clearWatch(state.id);
      } catch {
        // ignore
      }
      state.id = null;
      state.latest = null;
      if (sharedWatch === state) sharedWatch = null;
    }
  };
}
