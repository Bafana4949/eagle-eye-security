import { describe, it } from 'node:test';
import assert from 'node:assert';
import { keepScreenAwake, type KeepAwakeDocumentLike, type WakeLockApiLike, type WakeLockSentinelLike } from './wakeLock';

/** Fake sentinel that can be released by the "browser" (page hidden) or by the app. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: Array<() => void> = [];
  addEventListener(_type: 'release', listener: () => void) {
    this.listeners.push(listener);
  }
  async release() {
    this.browserRelease();
  }
  /** What the browser does when the document becomes hidden. */
  browserRelease() {
    if (this.released) return;
    this.released = true;
    for (const l of this.listeners) l();
  }
}

/** Fake navigator.wakeLock: rejects while the fake document is hidden, like Chrome. */
function fakeWakeLock(doc: FakeDocument) {
  const sentinels: FakeSentinel[] = [];
  const api: WakeLockApiLike = {
    request: async () => {
      if (doc.visibilityState !== 'visible') {
        const e = new Error('The requesting page is not visible');
        e.name = 'NotAllowedError';
        throw e;
      }
      const s = new FakeSentinel();
      sentinels.push(s);
      return s;
    }
  };
  return { api, sentinels };
}

class FakeDocument implements KeepAwakeDocumentLike {
  visibilityState = 'visible';
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  count() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('keepScreenAwake', () => {
  it('re-acquires the lock when the guard returns from WhatsApp (browser released it on hide)', async () => {
    const doc = new FakeDocument();
    const wl = fakeWakeLock(doc);
    const changes: boolean[] = [];
    const keep = keepScreenAwake({ wakeLock: wl.api, document: doc, onChange: (h) => changes.push(h) });
    await flush();
    assert.strictEqual(keep.isHeld(), true);
    assert.strictEqual(wl.sentinels.length, 1);

    // Guard opens WhatsApp: page hidden, the browser releases the lock.
    doc.visibilityState = 'hidden';
    wl.sentinels[0].browserRelease();
    doc.fire('visibilitychange');
    await flush();
    assert.strictEqual(keep.isHeld(), false);

    // Back in the app.
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await flush();
    assert.strictEqual(keep.isHeld(), true);
    assert.strictEqual(wl.sentinels.length, 2, 'a new lock was requested');
    assert.deepStrictEqual(changes, [true, false, true]);
    keep.stop();
  });

  it('retries on the next tap when a request was refused (e.g. battery saver)', async () => {
    const doc = new FakeDocument();
    let refuse = true;
    const sentinels: FakeSentinel[] = [];
    const api: WakeLockApiLike = {
      request: async () => {
        if (refuse) throw Object.assign(new Error('refused'), { name: 'NotAllowedError' });
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
      }
    };
    const keep = keepScreenAwake({ wakeLock: api, document: doc });
    await flush();
    assert.strictEqual(keep.isHeld(), false);
    refuse = false;
    doc.fire('pointerdown');
    await flush();
    assert.strictEqual(keep.isHeld(), true);
    doc.fire('pointerdown'); // already held: no extra request
    await flush();
    assert.strictEqual(sentinels.length, 1);
    keep.stop();
  });

  it('does not request while hidden, and concurrent triggers share one request', async () => {
    const doc = new FakeDocument();
    doc.visibilityState = 'hidden';
    let requests = 0;
    const api: WakeLockApiLike = {
      request: async () => {
        requests++;
        return new FakeSentinel();
      }
    };
    const keep = keepScreenAwake({ wakeLock: api, document: doc });
    await flush();
    assert.strictEqual(requests, 0);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    doc.fire('pointerdown');
    await keep.refresh();
    assert.strictEqual(requests, 1);
    keep.stop();
  });

  it('stop() releases the lock, removes its listeners and never re-acquires', async () => {
    const doc = new FakeDocument();
    const wl = fakeWakeLock(doc);
    const keep = keepScreenAwake({ wakeLock: wl.api, document: doc });
    await flush();
    keep.stop();
    keep.stop();
    assert.strictEqual(wl.sentinels[0].released, true);
    assert.strictEqual(doc.count(), 0);
    doc.fire('visibilitychange');
    assert.strictEqual(await keep.refresh(), false);
    assert.strictEqual(wl.sentinels.length, 1);
  });

  it('a lock granted after stop() is released immediately', async () => {
    const doc = new FakeDocument();
    let resolveRequest: (s: FakeSentinel) => void = () => undefined;
    const api: WakeLockApiLike = { request: () => new Promise<WakeLockSentinelLike>((r) => (resolveRequest = r)) };
    const keep = keepScreenAwake({ wakeLock: api, document: doc });
    keep.stop();
    const late = new FakeSentinel();
    resolveRequest(late);
    await flush();
    assert.strictEqual(late.released, true);
    assert.strictEqual(keep.isHeld(), false);
  });

  it('reports not held when the Wake Lock API is unavailable', async () => {
    const keep = keepScreenAwake({ wakeLock: null, document: new FakeDocument() });
    assert.strictEqual(await keep.refresh(), false);
    assert.strictEqual(keep.isHeld(), false);
    keep.stop();
  });
});
