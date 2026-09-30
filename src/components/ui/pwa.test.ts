/**
 * PWA + shared UI tests (area "pwa").
 *
 * - public/sw.js is executed in a simulated service-worker scope (node:vm) with a fake Cache Storage,
 *   fake network and a controllable clock, and its install / activate / fetch / message handlers are
 *   driven directly.
 * - public/manifest.json, the icon files, public/offline.html and next.config.ts are checked as files.
 * - The shared UI components and PwaRegistrar are rendered with react-dom/server to check their
 *   accessibility attributes and that they only use theme tokens.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import nextConfig from '../../../next.config';
import { Button, buttonClassName } from './button';
import { Badge } from './badge';
import { Card, CardHeader, CardTitle } from './card';
import { EmptyState } from './EmptyState';
import { MetricCard } from './MetricCard';
import { StatusBadge } from './StatusBadge';
import { Notice } from './Notice';
import { Dialog } from './Dialog';
import { PwaRegistrar, serviceWorkerUrl, versionOfWorker } from '../shared/PwaRegistrar';
import { translations } from '../../lib/i18n/translations';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const ORIGIN = 'https://ee.test';

// ---------------------------------------------------------------------------------------------
// Fake service-worker environment
// ---------------------------------------------------------------------------------------------

type Meta = { type?: string; redirected?: boolean; url?: string; status?: number; ok?: boolean };

/** A Response whose read-only fields (type, redirected, …) look like a browser network response. */
function patch(res: Response, meta: Meta): Response {
  const define = (key: string, value: unknown) => Object.defineProperty(res, key, { value, configurable: true });
  define('type', meta.type ?? 'basic');
  define('redirected', meta.redirected ?? false);
  if (meta.url !== undefined) define('url', meta.url);
  if (meta.status !== undefined) define('status', meta.status);
  if (meta.ok !== undefined) define('ok', meta.ok);
  const originalClone = Response.prototype.clone.bind(res);
  define('clone', () => patch(originalClone(), meta));
  return res;
}

function html(body: string, meta: Meta = {}, status = 200): Response {
  return patch(new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }), meta);
}

function asset(body: string, contentType = 'application/javascript'): Response {
  return patch(new Response(body, { status: 200, headers: { 'Content-Type': contentType } }), {});
}

function keyOf(input: unknown): string {
  if (typeof input === 'string') return new URL(input, ORIGIN).href;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return new URL(String((input as { url: string }).url), ORIGIN).href;
  throw new Error('bad cache key');
}

class FakeCache {
  readonly store = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>();
  async match(input: unknown) {
    const hit = this.store.get(keyOf(input));
    if (!hit) return undefined;
    return patch(new Response(hit.body.slice(0), { status: hit.status, headers: hit.headers }), {});
  }
  async put(input: unknown, response: Response) {
    const body = await response.arrayBuffer();
    this.store.set(keyOf(input), { body, status: response.status, headers: Array.from(response.headers.entries()) });
  }
  async delete(input: unknown) {
    return this.store.delete(keyOf(input));
  }
  async keys() {
    return Array.from(this.store.keys()).map((u) => new Request(u));
  }
  paths() {
    return Array.from(this.store.keys()).map((u) => new URL(u).pathname + new URL(u).search);
  }
}

class FakeCacheStorage {
  readonly map = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.map.get(name);
    if (!c) {
      c = new FakeCache();
      this.map.set(name, c);
    }
    return c;
  }
  async keys() {
    return Array.from(this.map.keys());
  }
  async delete(name: string) {
    return this.map.delete(name);
  }
  async has(name: string) {
    return this.map.has(name);
  }
  async match(input: unknown) {
    for (const c of this.map.values()) {
      const hit = await c.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
  get(name: string) {
    return this.map.get(name);
  }
}

class FakeClock {
  private now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms = 0) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  async advance(ms: number) {
    this.now += ms;
    const due = Array.from(this.timers.entries())
      .filter(([, t]) => t.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      this.timers.delete(id);
      t.fn();
    }
    await flush();
  }
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Lets background work finish: the guard warm-up waits 5 s on the (fake) clock before it runs. */
async function settle(clock: FakeClock, waits: Promise<unknown>[]) {
  await flush();
  await clock.advance(5000);
  await Promise.all(waits);
}

type NetRequest = { url: string; path: string; method: string; headers: Headers };
type NetHandler = (req: NetRequest) => Response | Promise<Response>;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  redirect: string;
  headers: Headers;
}

function fakeRequest(pathOrUrl: string, init: { mode?: string; method?: string; headers?: Record<string, string> } = {}): FakeRequest {
  const mode = init.mode ?? 'cors';
  return {
    url: new URL(pathOrUrl, ORIGIN).href,
    method: init.method ?? 'GET',
    mode,
    redirect: mode === 'navigate' ? 'manual' : 'follow',
    headers: new Headers(init.headers ?? {}),
  };
}

function loadWorker(options: { version?: string; network: NetHandler }) {
  const source = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const cacheStorage = new FakeCacheStorage();
  const clock = new FakeClock();
  const netLog: NetRequest[] = [];
  const calls = { skipWaiting: 0, claim: 0, preloadEnabled: 0 };

  class SwRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
    }
  }

  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    let url: string;
    let method = 'GET';
    let headers = new Headers();
    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(String(input), ORIGIN).href;
      method = init?.method ?? 'GET';
      headers = new Headers(init?.headers ?? {});
    } else {
      const r = input as FakeRequest | Request;
      url = new URL(r.url, ORIGIN).href;
      method = r.method;
      headers = new Headers(r.headers);
    }
    const req: NetRequest = { url, path: new URL(url).pathname, method, headers };
    netLog.push(req);
    return options.network(req);
  };

  const self = {
    location: new URL(`${ORIGIN}/sw.js${options.version === undefined ? '?v=build-1' : options.version}`),
    addEventListener(type: string, fn: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    skipWaiting: async () => {
      calls.skipWaiting++;
    },
    clients: {
      claim: async () => {
        calls.claim++;
      },
    },
    registration: {
      navigationPreload: {
        enable: async () => {
          calls.preloadEnabled++;
        },
      },
    },
  };

  const context = vm.createContext({
    self,
    caches: cacheStorage,
    fetch: fetchImpl,
    Request: SwRequest,
    Response,
    Headers,
    URL,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console,
  });
  vm.runInContext(source, context, { filename: 'sw.js' });

  const dispatch = (type: string, event: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };

  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = [];
    dispatch(type, { waitUntil: (p: Promise<unknown>) => waits.push(Promise.resolve(p)) });
    await Promise.all(waits);
  };

  const fetchEvent = (request: FakeRequest) => {
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    dispatch('fetch', {
      request,
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p: Response | Promise<Response>) => {
        responded = Promise.resolve(p);
      },
      waitUntil: (p: Promise<unknown>) => waits.push(Promise.resolve(p)),
    });
    return { responded, waits };
  };

  const message = (data: unknown, port?: { postMessage: (m: unknown) => void }) =>
    dispatch('message', { data, ports: port ? [port] : [] });

  return { cacheStorage, clock, netLog, calls, lifecycle, fetchEvent, message };
}

const offline = (): never => {
  throw new TypeError('Failed to fetch');
};

const GUARD_HTML =
  '<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/css/app-abc.css"/>' +
  '<script src="/_next/static/chunks/webpack-111.js" async></script></head><body>guard home' +
  '<script>self.__next_f.push([1,"2:I[\\"123\\",[\\"/_next/static/chunks/app/guard/page-222.js\\",\\"static/chunks/333.js\\"],\\"default\\"]"])</script>' +
  '</body></html>';
const CSS = '@font-face{font-family:Barlow;src:url(../media/barlow-444.woff2) format("woff2")}body{color:red}';

const ROUTES = ['/login', '/guard', '/guard/patrol', '/guard/gate', '/guard/incident', '/guard/history', '/guard/more'];

/** Everything online; the guard routes need a session (signedIn=false → redirect to /login). */
function onlineNetwork(opts: { signedIn?: boolean } = {}): NetHandler {
  const signedIn = opts.signedIn ?? true;
  return (req) => {
    const p = req.path;
    if (p === '/offline.html') return html('<p>offline page</p>');
    if (p.startsWith('/_next/static/css/')) return asset(CSS, 'text/css');
    if (p.startsWith('/_next/static/')) return asset(`/* ${p} */`);
    if (p === '/manifest.json') return asset('{}', 'application/manifest+json');
    if (/\.(png|jpg)$/.test(p)) return asset('img', 'image/png');
    if (p === '/login') return html('<p>login page</p><script src="/_next/static/chunks/login-555.js"></script>');
    if (p.startsWith('/guard')) {
      if (!signedIn) return html('<p>login page</p>', { redirected: true, url: `${ORIGIN}/login?next=${p}` });
      return html(p === '/guard' ? GUARD_HTML : `<p>page ${p}</p>`);
    }
    return html(`<p>network ${p}</p>`);
  };
}

async function text(res: Response | undefined): Promise<string> {
  assert.ok(res, 'expected a response');
  return res.text();
}

// ---------------------------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------------------------

describe('service worker: versioned caches and install', () => {
  it('derives every cache name from ?v= and falls back to "unversioned" for invalid values', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    await sw.lifecycle('install');
    assert.deepEqual((await sw.cacheStorage.keys()).sort(), ['ee-assets-build-1', 'ee-pages-build-1', 'ee-static-build-1']);

    const bad = loadWorker({ version: '?v=../../evil%20name', network: onlineNetwork() });
    await bad.lifecycle('install');
    assert.ok((await bad.cacheStorage.keys()).every((k) => k.endsWith('-unversioned')));
  });

  it('precaches the offline page, icons, the guard routes and the /_next/static files their HTML references', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    await sw.lifecycle('install');
    const pages = sw.cacheStorage.get('ee-pages-build-1')!;
    for (const route of ['/offline.html', ...ROUTES]) assert.ok(pages.paths().includes(route), `page ${route} saved`);

    const statics = sw.cacheStorage.get('ee-static-build-1')!.paths();
    for (const file of [
      '/_next/static/css/app-abc.css',
      '/_next/static/chunks/webpack-111.js',
      '/_next/static/chunks/app/guard/page-222.js', // escaped string inside the RSC payload
      '/_next/static/chunks/333.js', // chunk path written without the /_next prefix
      '/_next/static/media/barlow-444.woff2', // font referenced by the CSS file
      '/_next/static/chunks/login-555.js',
    ]) {
      assert.ok(statics.includes(file), `static ${file} saved (have: ${statics.join(', ')})`);
    }
    const assets = sw.cacheStorage.get('ee-assets-build-1')!.paths();
    for (const file of ['/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/Eagle_Eye_Logo.jpg']) {
      assert.ok(assets.includes(file), `asset ${file} saved`);
    }
    assert.equal(sw.calls.skipWaiting, 0, 'install must not call skipWaiting()');
  });

  it('never saves a redirected guard page (signed out during install) but still installs', async () => {
    const sw = loadWorker({ network: onlineNetwork({ signedIn: false }) });
    await sw.lifecycle('install');
    const pages = sw.cacheStorage.get('ee-pages-build-1')!.paths();
    assert.ok(pages.includes('/login'));
    assert.ok(pages.includes('/offline.html'));
    assert.ok(!pages.some((p) => p.startsWith('/guard')), `no guard page saved: ${pages.join(', ')}`);
  });

  it('fails the install when the offline page cannot be downloaded', async () => {
    const sw = loadWorker({ network: offline });
    await assert.rejects(sw.lifecycle('install'));
  });

  it('copies unchanged hashed files from an older version instead of downloading them again', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    const old = await sw.cacheStorage.open('ee-static-build-0');
    await old.put('/_next/static/chunks/webpack-111.js', asset('/* from old cache */'));
    await sw.lifecycle('install');
    assert.ok(!sw.netLog.some((r) => r.path === '/_next/static/chunks/webpack-111.js'), 'not downloaded again');
    const copy = await sw.cacheStorage.get('ee-static-build-1')!.match('/_next/static/chunks/webpack-111.js');
    assert.equal(await text(copy), '/* from old cache */');
  });
});

describe('service worker: activation and updates', () => {
  it('deletes caches of older versions and legacy names, keeps foreign caches, enables preload and claims clients', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    for (const name of ['ee-pages-old', 'ee-static-old', 'ee-assets-old', 'eagle-eye-cache-v1', 'someone-else']) {
      await sw.cacheStorage.open(name);
    }
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    assert.deepEqual((await sw.cacheStorage.keys()).sort(), [
      'ee-assets-build-1',
      'ee-pages-build-1',
      'ee-static-build-1',
      'someone-else',
    ]);
    assert.equal(sw.calls.claim, 1);
    assert.equal(sw.calls.preloadEnabled, 1);
  });

  it('only activates when the page posts SKIP_WAITING', () => {
    const sw = loadWorker({ network: onlineNetwork() });
    sw.message(null);
    sw.message('SKIP_WAITING');
    sw.message({ type: 'SOMETHING_ELSE' });
    assert.equal(sw.calls.skipWaiting, 0);
    sw.message({ type: 'SKIP_WAITING' });
    assert.equal(sw.calls.skipWaiting, 1);
  });

  it('reports its version on request', () => {
    const sw = loadWorker({ network: onlineNetwork() });
    const received: unknown[] = [];
    sw.message({ type: 'GET_VERSION' }, { postMessage: (m) => received.push(m) });
    // Objects created inside the worker's realm: compare by value.
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ type: 'VERSION', version: 'build-1' }]);
  });
});

describe('service worker: requests that are never cached', () => {
  const cases: [string, FakeRequest][] = [
    ['Supabase REST (cross-origin)', fakeRequest('https://abc.supabase.co/rest/v1/shifts?select=id')],
    [
      'signed evidence photo (cross-origin .jpg)',
      fakeRequest('https://abc.supabase.co/storage/v1/object/sign/evidence-media/o/s/incident/u/e-photo.jpg?token=t'),
    ],
    ['API route', fakeRequest('/api/admin/users')],
    ['API route that looks like an image', fakeRequest('/api/evidence/photo.jpg')],
    ['auth route that looks like an image', fakeRequest('/auth/avatar.png')],
    ['non-GET', fakeRequest('/guard', { method: 'POST' })],
    ['RSC request', fakeRequest('/guard/patrol', { headers: { RSC: '1' } })],
    ['RSC query', fakeRequest('/guard/patrol?_rsc=abc')],
    ['range request', fakeRequest('/Eagle_Eye_Logo.jpg', { headers: { Range: 'bytes=0-10' } })],
    ['auth callback', fakeRequest('/auth/callback?code=x')],
  ];
  for (const [name, request] of cases) {
    it(`does not intercept: ${name}`, () => {
      const sw = loadWorker({ network: onlineNetwork() });
      const { responded } = sw.fetchEvent(request);
      assert.equal(responded, undefined);
    });
  }

  it('answers auth-callback and API navigations from the network without saving them', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    await sw.lifecycle('install');
    const before = sw.cacheStorage.get('ee-pages-build-1')!.paths().length;
    for (const p of ['/auth/callback?code=abc', '/api/export']) {
      const { responded, waits } = sw.fetchEvent(fakeRequest(p, { mode: 'navigate' }));
      assert.match(await text(await responded), /network/);
      await Promise.all(waits);
    }
    assert.equal(sw.cacheStorage.get('ee-pages-build-1')!.paths().length, before);
  });
});

describe('service worker: page navigations', () => {
  async function installed(network: NetHandler) {
    const state = { handler: onlineNetwork() as NetHandler };
    const sw = loadWorker({ network: (req) => state.handler(req) });
    await sw.lifecycle('install');
    state.handler = network;
    return sw;
  }

  it('online: returns the network page and refreshes the saved copy of guard routes only', async () => {
    const sw = await installed((req) => html(`<p>fresh ${req.path}</p>`));
    let ev = sw.fetchEvent(fakeRequest('/guard/patrol', { mode: 'navigate' }));
    assert.equal(await text(await ev.responded), '<p>fresh /guard/patrol</p>');
    await settle(sw.clock, ev.waits);
    assert.equal(await text(await sw.cacheStorage.get('ee-pages-build-1')!.match('/guard/patrol')), '<p>fresh /guard/patrol</p>');

    ev = sw.fetchEvent(fakeRequest('/admin', { mode: 'navigate' }));
    assert.equal(await text(await ev.responded), '<p>fresh /admin</p>');
    await settle(sw.clock, ev.waits);
    assert.ok(!sw.cacheStorage.get('ee-pages-build-1')!.paths().includes('/admin'), 'admin pages are never saved');
  });

  it('offline: saved page → saved guard home for other /guard routes → offline page', async () => {
    const sw = await installed(offline);
    await sw.cacheStorage.get('ee-pages-build-1')!.delete('/guard/history');

    let res = await sw.fetchEvent(fakeRequest('/guard/patrol?x=1', { mode: 'navigate' })).responded;
    assert.equal(await text(res), '<p>page /guard/patrol</p>');

    res = await sw.fetchEvent(fakeRequest('/guard/history', { mode: 'navigate' })).responded;
    assert.match(await text(res), /guard home/);

    res = await sw.fetchEvent(fakeRequest('/admin', { mode: 'navigate' })).responded;
    assert.equal(await text(res), '<p>offline page</p>');
  });

  it('offline with nothing saved: a minimal 503 page, never a fake success', async () => {
    const sw = loadWorker({ network: offline });
    const res = await sw.fetchEvent(fakeRequest('/guard', { mode: 'navigate' })).responded;
    assert.equal(res?.status, 503);
    assert.match(await text(res), /Offline/);
  });

  it('slow network (> 4 s): shows the saved copy, then refreshes the cache when the network answers', async () => {
    let release: (r: Response) => void = () => {};
    const sw = await installed(() => new Promise<Response>((resolve) => (release = resolve)));
    const ev = sw.fetchEvent(fakeRequest('/guard/gate', { mode: 'navigate' }));
    let settled = false;
    void ev.responded!.then(() => (settled = true));
    await flush(); // let the worker reach its 4 s timer
    await sw.clock.advance(3900);
    assert.equal(settled, false, 'still waiting for the network before the timeout');
    await sw.clock.advance(200);
    assert.equal(await text(await ev.responded), '<p>page /guard/gate</p>');

    release(html('<p>late fresh gate</p>'));
    await settle(sw.clock, ev.waits);
    assert.equal(await text(await sw.cacheStorage.get('ee-pages-build-1')!.match('/guard/gate')), '<p>late fresh gate</p>');
  });

  it('slow network with no saved copy: keeps waiting instead of showing the offline page', async () => {
    let release: (r: Response) => void = () => {};
    const sw = await installed(() => new Promise<Response>((resolve) => (release = resolve)));
    const ev = sw.fetchEvent(fakeRequest('/supervisor', { mode: 'navigate' }));
    let settled = false;
    void ev.responded!.then(() => (settled = true));
    await flush();
    await sw.clock.advance(30_000);
    assert.equal(settled, false);
    release(html('<p>supervisor</p>'));
    assert.equal(await text(await ev.responded), '<p>supervisor</p>');
  });

  it('server error (5xx) on a guard route: the saved app is shown', async () => {
    const sw = await installed(() => html('bad gateway', {}, 502));
    let res = await sw.fetchEvent(fakeRequest('/guard/more', { mode: 'navigate' })).responded;
    assert.equal(await text(res), '<p>page /guard/more</p>');
    await sw.cacheStorage.get('ee-pages-build-1')!.delete('/guard/history');
    res = await sw.fetchEvent(fakeRequest('/guard/history', { mode: 'navigate' })).responded;
    assert.match(await text(res), /guard home/);
  });

  it('never saves a redirect answer (e.g. session expired → /login)', async () => {
    const sw = await installed(() => patch(new Response(null, { status: 200 }), { type: 'opaqueredirect', status: 0, ok: false }));
    const ev = sw.fetchEvent(fakeRequest('/guard/incident', { mode: 'navigate' }));
    const res = await ev.responded;
    assert.equal(res?.type, 'opaqueredirect');
    await settle(sw.clock, ev.waits);
    assert.equal(await text(await sw.cacheStorage.get('ee-pages-build-1')!.match('/guard/incident')), '<p>page /guard/incident</p>');
  });

  it('after a signed-in online visit, saves the guard screens that were skipped at install', async () => {
    const state = { handler: onlineNetwork({ signedIn: false }) };
    const sw = loadWorker({ network: (req) => state.handler(req) });
    await sw.lifecycle('install');
    assert.ok(!sw.cacheStorage.get('ee-pages-build-1')!.paths().includes('/guard/patrol'));

    state.handler = onlineNetwork({ signedIn: true });
    const ev = sw.fetchEvent(fakeRequest('/guard', { mode: 'navigate' }));
    assert.match(await text(await ev.responded), /guard home/);
    await settle(sw.clock, ev.waits);
    const saved = sw.cacheStorage.get('ee-pages-build-1')!.paths();
    for (const route of ROUTES) assert.ok(saved.includes(route), `${route} saved after warm-up`);
  });
});

describe('service worker: static files and icons', () => {
  it('serves /_next/static cache-first, including files saved by another version', async () => {
    const sw = loadWorker({ network: onlineNetwork() });
    let res = await sw.fetchEvent(fakeRequest('/_next/static/chunks/new-1.js')).responded;
    assert.equal(await text(res), '/* /_next/static/chunks/new-1.js */');
    const count = sw.netLog.length;
    res = await sw.fetchEvent(fakeRequest('/_next/static/chunks/new-1.js')).responded;
    assert.equal(await text(res), '/* /_next/static/chunks/new-1.js */');
    assert.equal(sw.netLog.length, count, 'second request served from the cache');

    await (await sw.cacheStorage.open('ee-static-other')).put('/_next/static/chunks/shared-9.js', asset('shared'));
    res = await sw.fetchEvent(fakeRequest('/_next/static/chunks/shared-9.js')).responded;
    assert.equal(await text(res), 'shared');
  });

  it('serves icons stale-while-revalidate and refreshes them in the background', async () => {
    let version = 'v1';
    const sw = loadWorker({ network: () => asset(`icon ${version}`, 'image/png') });
    let ev = sw.fetchEvent(fakeRequest('/icon-192.png'));
    assert.equal(await text(await ev.responded), 'icon v1');
    await Promise.all(ev.waits);
    version = 'v2';
    ev = sw.fetchEvent(fakeRequest('/icon-192.png'));
    assert.equal(await text(await ev.responded), 'icon v1', 'cached copy first');
    await Promise.all(ev.waits);
    assert.equal(await text(await sw.cacheStorage.get('ee-assets-build-1')!.match('/icon-192.png')), 'icon v2');
  });
});

// ---------------------------------------------------------------------------------------------
// Manifest, icons, offline page, next.config
// ---------------------------------------------------------------------------------------------

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function eeBgToken(): string {
  const css = readFileSync(path.join(ROOT, 'src', 'app', 'globals.css'), 'utf8');
  const m = css.match(/--color-ee-bg:\s*(#[0-9A-Fa-f]{6})/);
  assert.ok(m, 'globals.css defines --color-ee-bg');
  return m[1].toUpperCase();
}

describe('web app manifest and icons', () => {
  const manifest = JSON.parse(readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8'));

  it('opens the guard app standalone in portrait with the ee-bg colours', () => {
    assert.ok(typeof manifest.id === 'string' && manifest.id.length > 0);
    assert.equal(manifest.start_url, '/guard');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.orientation, 'portrait');
    assert.equal(String(manifest.theme_color).toUpperCase(), eeBgToken());
    assert.equal(String(manifest.background_color).toUpperCase(), eeBgToken());
  });

  it('lists 192/512 "any" icons and a 512 maskable icon, all existing with the declared size', () => {
    const icons: { src: string; sizes: string; purpose: string; type: string }[] = manifest.icons;
    const has = (size: string, purpose: string) => icons.some((i) => i.sizes === size && i.purpose === purpose);
    assert.ok(has('192x192', 'any'));
    assert.ok(has('512x512', 'any'));
    assert.ok(has('512x512', 'maskable'));
    for (const icon of icons) {
      const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
      assert.ok(existsSync(file), `${icon.src} exists`);
      assert.equal(icon.type, 'image/png');
      const { width, height } = pngSize(file);
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is really ${icon.sizes}`);
    }
    assert.deepEqual(pngSize(path.join(PUBLIC, 'apple-touch-icon.png')), { width: 180, height: 180 });
  });

  it('every file the service worker precaches exists in public/', () => {
    const sw = readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
    const block = sw.match(/const PRECACHE_ASSETS = \[([\s\S]*?)\];/);
    assert.ok(block);
    const files = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    assert.ok(files.length >= 5);
    for (const f of [...files, '/offline.html']) assert.ok(existsSync(path.join(PUBLIC, f.slice(1))), `${f} exists`);
  });
});

describe('offline.html', () => {
  const page = readFileSync(path.join(PUBLIC, 'offline.html'), 'utf8');

  it('has the same honest messages in en, af and zu', () => {
    const literal = page.match(/var TEXT = (\{[\s\S]*?\n {6}\});/);
    assert.ok(literal, 'TEXT dictionary found');
    const dict = vm.runInNewContext(`(${literal[1]})`) as Record<string, Record<string, string>>;
    const enKeys = Object.keys(dict.en).sort();
    for (const lang of ['af', 'zu']) {
      assert.deepEqual(Object.keys(dict[lang]).sort(), enKeys, `${lang} has every key`);
      for (const k of enKeys) assert.ok(dict[lang][k].trim().length > 0, `${lang}.${k} is not empty`);
    }
    // Sync only happens while the app is open; the page must not claim automatic background upload.
    assert.doesNotMatch(page, /automatic/i);
    assert.doesNotMatch(page, /securely stored/i);
  });

  it('uses the app palette, a real retry check and large touch targets', () => {
    assert.ok(page.toUpperCase().includes(eeBgToken()));
    assert.match(page, /data-testid="pwa-offline-retry"/);
    assert.match(page, /method: 'HEAD'/);
    assert.match(page, /min-height: 56px/);
    assert.doesNotMatch(page, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji');
  });
});

describe('next.config.ts', () => {
  it('uses one build version for the build id, the client bundle and the X-App-Version header', async () => {
    const buildId = await nextConfig.generateBuildId!();
    assert.ok(typeof buildId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(buildId));
    assert.equal(nextConfig.env?.NEXT_PUBLIC_APP_VERSION, buildId);
    assert.equal(process.env.NEXT_PUBLIC_APP_VERSION, buildId);
    const rules = await nextConfig.headers!();
    const global = rules.find((r) => r.source === '/:path*');
    assert.ok(global);
    assert.equal(global.headers.find((h) => h.key === 'X-App-Version')?.value, buildId);
  });

  it('serves /sw.js uncached with Service-Worker-Allowed and sends conservative security headers', async () => {
    const rules = await nextConfig.headers!();
    const sw = rules.find((r) => r.source === '/sw.js');
    assert.ok(sw);
    const cc = sw.headers.find((h) => h.key === 'Cache-Control')?.value ?? '';
    assert.match(cc, /no-cache/);
    assert.match(cc, /no-store/);
    assert.equal(sw.headers.find((h) => h.key === 'Service-Worker-Allowed')?.value, '/');

    const global = rules.find((r) => r.source === '/:path*')!;
    const header = (k: string) => global.headers.find((h) => h.key === k)?.value ?? '';
    assert.equal(header('X-Content-Type-Options'), 'nosniff');
    assert.equal(header('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.match(header('Permissions-Policy'), /camera=\(self\)/);
    assert.match(header('Permissions-Policy'), /geolocation=\(self\)/);
    assert.match(header('Content-Security-Policy'), /frame-ancestors 'none'/);
  });
});

// ---------------------------------------------------------------------------------------------
// Shared UI components and the update banner
// ---------------------------------------------------------------------------------------------

const h = React.createElement;

describe('shared UI components', () => {
  it('Button: 48 px default, 56 px touch, focus ring, loading state is busy and disabled', () => {
    assert.match(buttonClassName(), /min-h-12/);
    assert.match(buttonClassName({ size: 'touch' }), /min-h-14/);
    assert.match(buttonClassName({ size: 'icon' }), /size-12/);
    assert.match(buttonClassName({ variant: 'sos' }), /bg-ee-sos\b/);
    assert.match(buttonClassName(), /focus-visible:outline-ee-primary/);
    const markup = renderToStaticMarkup(h(Button, { isLoading: true, id: 'save' }, 'Save'));
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, />Save<\/button>/, 'label stays visible while loading');
    assert.doesNotMatch(markup, /Processing/);
  });

  it('StatusBadge and Badge always carry a visible text label; the dot is decorative', () => {
    const markup = renderToStaticMarkup(h(StatusBadge, { status: 'queued', label: 'Saved on this phone' }));
    assert.match(markup, /Saved on this phone/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /data-status="queued"/);
    assert.match(renderToStaticMarkup(h(Badge, { variant: 'danger' }, 'Missed')), /text-ee-danger-text/);
  });

  it('Notice uses role=status by default, role=alert when assertive, and stays mounted when empty', () => {
    assert.match(renderToStaticMarkup(h(Notice, { tone: 'success', title: 'Received by server' })), /role="status"/);
    assert.match(renderToStaticMarkup(h(Notice, { tone: 'danger', live: 'assertive' }, 'Upload failed')), /role="alert"/);
    const empty = renderToStaticMarkup(h(Notice, { id: 'sync-notice' }));
    assert.match(empty, /class="sr-only"/);
    assert.match(empty, /aria-live="polite"/);
  });

  it('Card, EmptyState and MetricCard render with theme tokens only', () => {
    const markup = renderToStaticMarkup(
      h(
        'div',
        null,
        h(Card, null, h(CardHeader, null, h(CardTitle, null, 'Rounds'))),
        h(EmptyState, { title: 'No scans yet', titleAs: 'p' }),
        h(MetricCard, { label: 'Missed', value: 2, variant: 'danger' })
      )
    );
    assert.match(markup, /bg-ee-surface/);
    assert.match(markup, /No scans yet/);
    assert.doesNotMatch(markup, /#[0-9A-Fa-f]{3,8}\b/);
    assert.doesNotMatch(markup, /shadow-|backdrop-blur|gradient/);
  });

  it('Dialog renders nothing on the server or when closed', () => {
    const noop = () => {};
    assert.equal(renderToStaticMarkup(h(Dialog, { open: false, onClose: noop, title: 'x' })), '');
    assert.equal(renderToStaticMarkup(h(Dialog, { open: true, onClose: noop, title: 'x' })), '');
  });

  it('owned .tsx files use theme tokens only (no hex colours or Tailwind palettes)', () => {
    const files = [
      ...readdirSync(HERE)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => path.join(HERE, f)),
      path.join(ROOT, 'src', 'components', 'shared', 'PwaRegistrar.tsx'),
    ];
    const forbidden =
      /#[0-9A-Fa-f]{3,8}\b|(slate|gray|zinc|blue|indigo|violet|purple|emerald|green|rose|red|amber|yellow|orange|sky|cyan|teal)-[0-9]{2,3}/;
    for (const file of files) {
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => forbidden.test(line));
      assert.deepEqual(offending, [], `${path.basename(file)} uses non-token colours`);
    }
  });
});

describe('PwaRegistrar', () => {
  it('registers /sw.js with the build version and reads a worker version back', () => {
    assert.equal(serviceWorkerUrl('abc123-20261001t0600'), '/sw.js?v=abc123-20261001t0600');
    assert.equal(serviceWorkerUrl('bad value/..'), '/sw.js?v=unversioned');
    assert.equal(versionOfWorker({ scriptURL: `${ORIGIN}/sw.js?v=b2` } as ServiceWorker), 'b2');
    assert.equal(versionOfWorker(null), null);
  });

  it('server-renders only an empty live region (no banner until an update is really waiting)', () => {
    const markup = renderToStaticMarkup(h(PwaRegistrar));
    assert.match(markup, /role="status"/);
    assert.match(markup, /data-testid="pwa-update-status"/);
    assert.doesNotMatch(markup, /pwa-update-banner/);
  });

  it('has update-banner texts in en, af and zu', () => {
    for (const key of ['pwaUpdateAvailable', 'pwaUpdateReload', 'pwaUpdateLater', 'pwaUpdateHint'] as const) {
      for (const lang of ['en', 'af', 'zu'] as const) {
        assert.ok(translations[lang][key].length > 0, `${lang}.${key}`);
      }
    }
  });
});
