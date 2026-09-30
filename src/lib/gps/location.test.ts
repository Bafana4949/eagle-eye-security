import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  COARSE_RETRY_TIMEOUT_MS,
  STALE_FIX_MS,
  getLocationFix,
  isFixStale,
  mapGeolocationErrorCode,
  startLocationWatch,
  type PermissionStatusLike,
  type PermissionsLike
} from './location';

type Success = (p: GeolocationPosition) => void;
type Failure = (e: GeolocationPositionError) => void;

/** Fake navigator.geolocation that answers asynchronously like a browser. */
function fakeGeo(answer: (ok: Success, fail: Failure, opts: PositionOptions | undefined, call: number) => void) {
  const calls: Array<PositionOptions | undefined> = [];
  return {
    calls,
    geolocation: {
      getCurrentPosition(ok: Success, fail?: Failure | null, opts?: PositionOptions) {
        calls.push(opts);
        const call = calls.length;
        setTimeout(() => answer(ok, fail ?? (() => undefined), opts, call), 0);
      }
    }
  };
}

/** Fake watchPosition/clearWatch; the test pushes fixes and errors into the active watch. */
function fakeWatchGeo() {
  const state = {
    ok: null as Success | null,
    fail: null as Failure | null,
    options: undefined as PositionOptions | undefined,
    cleared: [] as number[],
    currentCalls: [] as Array<PositionOptions | undefined>,
    currentAnswer: null as ((ok: Success, fail: Failure) => void) | null
  };
  const geolocation = {
    watchPosition(ok: Success, fail?: Failure | null, opts?: PositionOptions) {
      state.ok = ok;
      state.fail = fail ?? null;
      state.options = opts;
      return 7;
    },
    clearWatch(id: number) {
      state.cleared.push(id);
    },
    getCurrentPosition(ok: Success, fail?: Failure | null, opts?: PositionOptions) {
      state.currentCalls.push(opts);
      state.currentAnswer?.(ok, fail ?? (() => undefined));
    }
  };
  return { state, geolocation };
}

const position = (lat: number, lon: number, accuracy: number, timestamp: number) =>
  ({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp }) as unknown as GeolocationPosition;

const positionError = (code: number, message: string) => ({ code, message }) as unknown as GeolocationPositionError;

const GRANTED: PermissionsLike = { query: async () => ({ state: 'granted' }) };

const NOW = 1_790_000_000_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('getLocationFix', () => {
  it('returns an ok fix with its age and passes the options to the browser', async () => {
    const g = fakeGeo((ok) => ok(position(-25.68412, 27.81452, 6, NOW - 4000)));
    const r = await getLocationFix({
      geolocation: g.geolocation,
      permissions: GRANTED,
      isSecureContext: true,
      now: () => NOW,
      maxAgeMs: 30000,
      timeoutMs: 8000
    });
    assert.deepStrictEqual(r, {
      status: 'ok',
      latitude: -25.68412,
      longitude: 27.81452,
      accuracy: 6,
      timestamp: NOW - 4000,
      ageMs: 4000,
      receivedAt: NOW,
      clockSkewMs: null,
      source: 'current'
    });
    assert.deepStrictEqual(g.calls[0], { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });

  it('a fresh fix is NOT discarded when the phone clock is minutes off (review reproduction)', async () => {
    // Delivered instantly, but position.timestamp is 3 min behind the device clock. The browser
    // guarantees maximumAge (30 s), so this is clock skew, not a stale position.
    const g = fakeGeo((ok) => ok(position(-25.68, 27.81, 6, NOW - 180000)));
    const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW });
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.status === 'ok' && r.clockSkewMs === 180000 && r.latitude === -25.68);
    assert.ok(r.status === 'ok' && r.ageMs === 30000, 'age is bounded by the maximumAge the browser honoured');
    // A clock running ahead of the fix time is skew as well.
    const ahead = fakeGeo((ok) => ok(position(-25.68, 27.81, 6, NOW + 240000)));
    const r2 = await getLocationFix({ geolocation: ahead.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW });
    assert.ok(r2.status === 'ok' && r2.clockSkewMs === -240000);
  });

  it('a genuinely old cached position (caller allowed a long maximumAge) is stale, coordinates kept', async () => {
    const g = fakeGeo((ok) => ok(position(-25.7, 27.8, 12, NOW - STALE_FIX_MS - 1)));
    const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW, maxAgeMs: 300000 });
    assert.strictEqual(r.status, 'stale');
    assert.ok(r.status === 'stale' && r.ageMs === STALE_FIX_MS + 1 && r.latitude === -25.7 && r.clockSkewMs === null);
  });

  it('a fix exactly 120 s old is still ok', async () => {
    const g = fakeGeo((ok) => ok(position(-25.7, 27.8, 12, NOW - STALE_FIX_MS)));
    const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW, maxAgeMs: STALE_FIX_MS });
    assert.strictEqual(r.status, 'ok');
  });

  for (const [code, status] of [
    [1, 'permission_denied'],
    [2, 'unavailable'],
    [3, 'timeout']
  ] as const) {
    it(`maps PositionError code ${code} → ${status}`, async () => {
      const g = fakeGeo((_ok, fail) => fail(positionError(code, `code ${code}`)));
      const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW });
      assert.deepStrictEqual(r, { status, message: `code ${code}` });
      // Only a timeout is retried (once, with low accuracy).
      assert.strictEqual(g.calls.length, code === 3 ? 2 : 1);
    });
  }

  it('after a high-accuracy timeout, retries once with low accuracy and reports its real accuracy', async () => {
    const g = fakeGeo((ok, fail, opts) => {
      if (opts?.enableHighAccuracy) fail(positionError(3, 'Timeout expired'));
      else ok(position(-25.681, 27.812, 850, NOW - 20000));
    });
    const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW });
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.status === 'ok' && r.source === 'coarse_retry' && r.accuracy === 850 && r.ageMs === 20000);
    assert.deepStrictEqual(g.calls, [
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      { enableHighAccuracy: false, timeout: COARSE_RETRY_TIMEOUT_MS, maximumAge: STALE_FIX_MS }
    ]);
  });

  it('does not retry when low accuracy was requested or the retry is disabled', async () => {
    const g = fakeGeo((_ok, fail) => fail(positionError(3, 't')));
    await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, highAccuracy: false });
    assert.strictEqual(g.calls.length, 1);
    const g2 = fakeGeo((_ok, fail) => fail(positionError(3, 't')));
    await getLocationFix({ geolocation: g2.geolocation, permissions: GRANTED, isSecureContext: true, coarseRetry: false });
    assert.strictEqual(g2.calls.length, 1);
  });

  it('reports insecure contexts without asking the browser', async () => {
    const g = fakeGeo((ok) => ok(position(0, 0, 1, NOW)));
    const r = await getLocationFix({ geolocation: g.geolocation, isSecureContext: false });
    assert.strictEqual(r.status, 'insecure');
    assert.strictEqual(g.calls.length, 0);
  });

  it('reports unsupported when there is no geolocation API', async () => {
    const r = await getLocationFix({ geolocation: null, isSecureContext: true });
    assert.strictEqual(r.status, 'unsupported');
  });

  it('times out when the browser never answers (location services off on some phones)', async () => {
    const silent = { getCurrentPosition() {} };
    const started = Date.now();
    const r = await getLocationFix({ geolocation: silent, permissions: GRANTED, isSecureContext: true, timeoutMs: 10, coarseRetry: false });
    assert.strictEqual(r.status, 'timeout');
    assert.ok(Date.now() - started >= 10);
  });

  it('does not time out while the permission prompt is open; restarts the allowance after "Allow"', async () => {
    let onChange: (() => void) | null = null;
    const status: PermissionStatusLike = {
      state: 'prompt',
      addEventListener: (_type, listener) => {
        onChange = listener;
      },
      removeEventListener: () => {
        onChange = null;
      }
    };
    let answer: Success | null = null;
    const geolocation = {
      getCurrentPosition(ok: Success) {
        answer = ok;
      }
    };
    let settled = false;
    const pending = getLocationFix({
      geolocation,
      permissions: { query: async () => status },
      isSecureContext: true,
      timeoutMs: 10,
      coarseRetry: false,
      now: () => NOW
    }).then((r) => {
      settled = true;
      return r;
    });
    // timeoutMs + grace (2.01 s) passes while the guard reads the prompt: still waiting.
    await sleep(2300);
    assert.strictEqual(settled, false, 'watchdog must not fire while the prompt is open');
    // Guard taps "Allow"; the browser then delivers a fix.
    status.state = 'granted';
    assert.ok(onChange, 'listens for the permission change');
    (onChange as unknown as () => void)();
    (answer as unknown as Success)(position(-25.68, 27.81, 9, NOW - 1000));
    const r = await pending;
    assert.strictEqual(r.status, 'ok');
  });

  it('rejects impossible coordinates as unavailable', async () => {
    const g = fakeGeo((ok) => ok(position(123, 27.8, 5, NOW)));
    const r = await getLocationFix({ geolocation: g.geolocation, permissions: GRANTED, isSecureContext: true, now: () => NOW });
    assert.strictEqual(r.status, 'unavailable');
  });

  it('a throwing geolocation implementation resolves as unavailable', async () => {
    const throwing = {
      getCurrentPosition() {
        throw new Error('boom');
      }
    };
    const r = await getLocationFix({ geolocation: throwing, permissions: GRANTED, isSecureContext: true });
    assert.deepStrictEqual(r, { status: 'unavailable', message: 'boom' });
  });
});

describe('startLocationWatch (warm GPS during a shift)', () => {
  it('watches with the reference options and answers getLocationFix instantly from the latest fix', async () => {
    const clock = { t: NOW };
    const w = fakeWatchGeo();
    const fixes: unknown[] = [];
    const handle = startLocationWatch({ geolocation: w.geolocation, isSecureContext: true, now: () => clock.t, onFix: (f) => fixes.push(f) });
    assert.deepStrictEqual(w.state.options, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
    assert.strictEqual(handle.peek(), null, 'no fix yet');

    w.state.ok!(position(-25.6841, 27.8145, 7, clock.t - 2000));
    assert.strictEqual(fixes.length, 1);
    clock.t += 5000;

    const g = fakeGeo((ok) => ok(position(0, 0, 1, clock.t)));
    const r = await getLocationFix({ geolocation: g.geolocation, watch: handle, isSecureContext: true, now: () => clock.t });
    assert.strictEqual(g.calls.length, 0, 'no new GPS request needed');
    assert.ok(r.status === 'ok' && r.source === 'watch' && r.latitude === -25.6841 && r.ageMs === 7000);

    // Older than maxAgeMs by receipt time → ask the browser again.
    clock.t += 30000;
    const r2 = await getLocationFix({ geolocation: g.geolocation, watch: handle, permissions: GRANTED, isSecureContext: true, now: () => clock.t });
    assert.strictEqual(g.calls.length, 1);
    assert.ok(r2.status === 'ok' && r2.source === 'current');
    handle.stop();
  });

  it('a watched fix is never used once it is stale by receipt time', () => {
    const clock = { t: NOW };
    const w = fakeWatchGeo();
    const handle = startLocationWatch({ geolocation: w.geolocation, isSecureContext: true, now: () => clock.t });
    w.state.ok!(position(-25.68, 27.81, 5, clock.t));
    clock.t += STALE_FIX_MS + 1;
    assert.strictEqual(handle.peek(STALE_FIX_MS * 10), null);
    handle.stop();
  });

  it('after a watch timeout asks once for a coarse position and keeps its real accuracy', () => {
    const clock = { t: NOW };
    const w = fakeWatchGeo();
    const errors: string[] = [];
    w.state.currentAnswer = (ok) => ok(position(-25.69, 27.82, 1200, clock.t - 10000));
    const handle = startLocationWatch({ geolocation: w.geolocation, isSecureContext: true, now: () => clock.t, onError: (s) => errors.push(s) });
    w.state.fail!(positionError(3, 'Timeout expired'));
    assert.deepStrictEqual(errors, ['timeout']);
    assert.deepStrictEqual(w.state.currentCalls, [{ enableHighAccuracy: false, timeout: COARSE_RETRY_TIMEOUT_MS, maximumAge: STALE_FIX_MS }]);
    const r = handle.peek();
    assert.ok(r && r.status === 'ok' && r.accuracy === 1200 && r.ageMs === 10000);
    assert.strictEqual(handle.lastError(), null, 'the coarse fix clears the error');
    handle.stop();
  });

  it('stop() clears the browser watch once, and later peeks return nothing', () => {
    const w = fakeWatchGeo();
    const handle = startLocationWatch({ geolocation: w.geolocation, isSecureContext: true, now: () => NOW });
    w.state.ok!(position(-25.68, 27.81, 5, NOW));
    handle.stop();
    handle.stop();
    assert.deepStrictEqual(w.state.cleared, [7]);
    assert.strictEqual(handle.peek(), null);
  });

  it('reports insecure contexts and missing APIs instead of pretending to watch', () => {
    const insecure = startLocationWatch({ geolocation: fakeWatchGeo().geolocation, isSecureContext: false });
    assert.strictEqual(insecure.lastError()?.status, 'insecure');
    assert.strictEqual(insecure.peek(), null);
    const missing = startLocationWatch({ geolocation: null, isSecureContext: true });
    assert.strictEqual(missing.lastError()?.status, 'unsupported');
  });
});

describe('location helpers', () => {
  it('maps error codes', () => {
    assert.strictEqual(mapGeolocationErrorCode(1), 'permission_denied');
    assert.strictEqual(mapGeolocationErrorCode(2), 'unavailable');
    assert.strictEqual(mapGeolocationErrorCode(3), 'timeout');
    assert.strictEqual(mapGeolocationErrorCode(99), 'unavailable');
  });
  it('isFixStale uses the 120 s window', () => {
    assert.strictEqual(isFixStale(NOW - STALE_FIX_MS, NOW), false);
    assert.strictEqual(isFixStale(NOW - STALE_FIX_MS - 1, NOW), true);
  });
});
