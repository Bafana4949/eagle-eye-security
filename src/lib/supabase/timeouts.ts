/**
 * Time limits for calls to Supabase.
 *
 * On rural cellular links a request is often "black-holed": no response and no error, ever.
 * Without a limit one such request would freeze whatever awaits it — a sync pass (and the
 * cross-tab sync lock it holds), a sign-in check, an identity load. Every fetch made by the
 * browser client is therefore aborted after a deadline.
 *
 * Photo uploads legitimately take long on EDGE/2G, so their limit grows with the body size
 * (fetch exposes no upload progress, so a true "stalled for N seconds" limit is impossible).
 */

/** PostgREST, Auth and small Storage calls. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Fixed part of an upload's limit (connection set-up, server processing). */
export const UPLOAD_BASE_TIMEOUT_MS = 30_000;
/** Slowest upload throughput still waited for: about 48 kbit/s (weak EDGE). */
export const UPLOAD_MIN_BYTES_PER_SECOND = 6_000;
export const UPLOAD_MAX_TIMEOUT_MS = 5 * 60_000;

/** Limit for uploading `bytes` (30 s + time at 6 KB/s, at most 5 min). */
export function uploadTimeoutMs(bytes: number): number {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.min(UPLOAD_MAX_TIMEOUT_MS, UPLOAD_BASE_TIMEOUT_MS + Math.ceil((size / UPLOAD_MIN_BYTES_PER_SECOND) * 1000));
}

/** Thrown (as the abort reason) when a request exceeds its limit. The message matches isNetworkFailure(). */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Best-effort byte size of a fetch body; null when it cannot be known (streams). */
export function bodySize(body: unknown): number | null {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString().length;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let total = 0;
    body.forEach((value) => {
      total += typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.size;
    });
    return total;
  }
  return null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The limit for one fetch: size-based for Storage object uploads, REQUEST_TIMEOUT_MS otherwise. */
export function requestTimeoutFor(input: RequestInfo | URL, init?: RequestInit): number {
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  const isUpload = (method === 'POST' || method === 'PUT') && /\/storage\/v1\/object\//.test(requestUrl(input));
  if (!isUpload) return REQUEST_TIMEOUT_MS;
  const size = bodySize(init?.body);
  return size === null ? UPLOAD_MAX_TIMEOUT_MS : uploadTimeoutMs(size);
}

type TimerHandle = ReturnType<typeof setTimeout>;

function startTimer(callback: () => void, ms: number): TimerHandle {
  const handle = setTimeout(callback, ms);
  // Node (tests): a pending limit must not keep the process alive.
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/**
 * Wraps fetch so every request is aborted after its limit. A caller-supplied signal still
 * aborts the request too. The limit also covers reading the response body, so it is not
 * cleared when the headers arrive; aborting an already consumed response is a no-op.
 */
export function createTimeoutFetch(
  baseFetch: typeof fetch = (...args) => fetch(...args),
  timeoutFor: (input: RequestInfo | URL, init?: RequestInit) => number = requestTimeoutFor
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const ms = timeoutFor(input, init);
    const controller = new AbortController();
    const outer = init?.signal ?? undefined;
    if (outer?.aborted) {
      controller.abort(outer.reason);
    } else {
      outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    const timer = startTimer(() => controller.abort(new RequestTimeoutError(ms)), ms);
    return baseFetch(input, { ...init, signal: controller.signal }).catch((error: unknown) => {
      clearTimeout(timer);
      // Surface our own timeout (not a bare AbortError) so callers classify it as a network failure.
      if (controller.signal.aborted && controller.signal.reason instanceof RequestTimeoutError) {
        throw controller.signal.reason;
      }
      throw error;
    });
  };
}

export type RaceResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Waits for `promise` at most `ms`. The promise keeps running after a timeout (its result is
 * simply not awaited); a rejection is re-thrown only when it happens before the deadline.
 */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceResult<T>> {
  return new Promise<RaceResult<T>>((resolve, reject) => {
    let settled = false;
    const timer = startTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
