import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { isNetworkFailure } from '@/lib/auth/authErrors';
import {
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  UPLOAD_BASE_TIMEOUT_MS,
  UPLOAD_MAX_TIMEOUT_MS,
  bodySize,
  createTimeoutFetch,
  raceWithTimeout,
  requestTimeoutFor,
  uploadTimeoutMs
} from './timeouts';

/** A fetch that never answers (a black-holed connection) but honours its abort signal, like a browser fetch. */
function blackHoleFetch(seen: RequestInit[] = []): typeof fetch {
  return (_input, init) => {
    seen.push(init ?? {});
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

describe('time limits', () => {
  it('scale upload limits with size (slow EDGE uploads still finish) and cap them', () => {
    assert.equal(uploadTimeoutMs(0), UPLOAD_BASE_TIMEOUT_MS);
    assert.equal(uploadTimeoutMs(900_000), UPLOAD_BASE_TIMEOUT_MS + 150_000);
    assert.equal(uploadTimeoutMs(50 * 1024 * 1024), UPLOAD_MAX_TIMEOUT_MS);
  });

  it('pick the upload limit only for Storage object uploads', () => {
    const photo = new FormData();
    photo.append('cacheControl', '3600');
    photo.append('', new Blob([new Uint8Array(600_000)], { type: 'image/jpeg' }));
    const size = bodySize(photo) as number;
    assert.ok(size >= 600_000 && size < 600_010);
    assert.equal(
      requestTimeoutFor('https://x.supabase.co/storage/v1/object/evidence-media/a/b.jpg', { method: 'POST', body: photo }),
      uploadTimeoutMs(size)
    );
    assert.equal(requestTimeoutFor('https://x.supabase.co/rest/v1/incidents', { method: 'POST', body: '{}' }), REQUEST_TIMEOUT_MS);
    assert.equal(requestTimeoutFor('https://x.supabase.co/storage/v1/object/sign/evidence-media/a.jpg'), REQUEST_TIMEOUT_MS);
    assert.equal(bodySize(new ReadableStream()), null);
  });

  it('abort a request that never answers with a timeout error classified as a network failure', async () => {
    const timed = createTimeoutFetch(blackHoleFetch(), () => 25);
    const started = Date.now();
    const error = await timed('https://example.invalid/rest/v1/x').then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(error instanceof RequestTimeoutError);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(isNetworkFailure(undefined, error), true);
  });

  it('still honour the caller’s own abort signal', async () => {
    const controller = new AbortController();
    const timed = createTimeoutFetch(blackHoleFetch(), () => 60_000);
    const pending = timed('https://example.invalid/rest/v1/x', { signal: controller.signal });
    controller.abort(new Error('user cancelled'));
    await assert.rejects(pending, /user cancelled/);
  });

  it('reach supabase-js: a black-holed PostgREST call and upload end with errors the sync engine retries', async () => {
    const supabase = createClient('https://example.invalid', 'anon-key', {
      global: { fetch: createTimeoutFetch(blackHoleFetch(), () => 25) },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const read = await supabase.from('incidents').select('id');
    assert.equal(read.status, 0);
    assert.match(read.error?.message ?? '', /timed out/);
    assert.equal(isNetworkFailure(read.status, read.error), true);

    const upload = await supabase.storage.from('evidence-media').upload('a/b.jpg', new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
    assert.ok(upload.error, 'upload reports an error instead of hanging');
    assert.equal(typeof (upload.error as { status?: unknown }).status, 'undefined', 'no HTTP status: treated as not reaching the server');
  });

  it('raceWithTimeout returns the value, or a timeout while the work continues', async () => {
    assert.deepEqual(await raceWithTimeout(Promise.resolve(7), 1_000), { timedOut: false, value: 7 });
    assert.deepEqual(await raceWithTimeout(new Promise(() => undefined), 10), { timedOut: true });
    await assert.rejects(raceWithTimeout(Promise.reject(new Error('boom')), 1_000), /boom/);
  });
});
