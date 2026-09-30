/**
 * E2E TEST SUPPORT ONLY: a local stand-in for a Supabase project, for browser tests.
 *
 * It is NOT a Supabase re-implementation. It runs the app's real migrations in PGlite
 * (tests/db/harness.ts: Supabase shim + every file in supabase/migrations), and answers the
 * HTTP subset supabase-js / @supabase/ssr use, executing every data request as the caller
 * (PostgREST semantics) so RLS, column privileges and triggers are genuinely enforced:
 *   /auth/v1/*     GoTrue subset (gotrue.ts)       — HS256 JWTs with a fixed TEST secret
 *   /rest/v1/*     PostgREST subset (postgrest.ts)
 *   /storage/v1/*  Storage subset (storage.ts)     — bytes kept in memory
 *   /realtime/v1   refused (WebSocket upgrades get 503) so the app must fall back to polling
 *   /__test/*      test control: reset + seed, fixture, superuser SQL, request log, faults
 * Start it with `npx tsx tests/e2e-support/fake-supabase/main.ts` (playwright.config.ts does).
 */
import { randomInt } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { FAKE_SUPABASE_PORT, TEST_CONTROL_HEADER, TEST_CONTROL_TOKEN } from '../constants';
import { handleAuth, recoveryLinks, resolveCaller } from './gotrue';
import { HttpError, corsHeaders, header, parseJsonBody, readBody, send, sleep } from './http';
import { PostgrestHandler } from './postgrest';
import { FakeSupabaseState, type Caller, type FaultRuleInput } from './state';
import { StorageHandler } from './storage';

export interface FakeSupabaseServer {
  url: string;
  port: number;
  state: FakeSupabaseState;
  server: Server;
  close(): Promise<void>;
}

interface RequestContext {
  caller: Caller | null;
  errorCode: string | null;
  fault: string | null;
}

function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const key of ['code', 'error_code', 'error', 'statusCode']) {
    if (typeof b[key] === 'string' && b[key]) return b[key] as string;
  }
  return null;
}

function callerRole(caller: Caller | null): { role: string; userId: string | null } {
  if (!caller) return { role: '-', userId: null };
  return { role: caller.role, userId: caller.role === 'authenticated' ? caller.userId : null };
}

/** Makes the response disappear: the request is processed, the client sees a dropped connection. */
function loseResponse(res: ServerResponse): void {
  const drop = (() => {
    res.socket?.destroy();
    return res;
  }) as unknown;
  res.writeHead = drop as ServerResponse['writeHead'];
  res.end = drop as ServerResponse['end'];
  res.write = (() => true) as ServerResponse['write'];
}

async function handleControl(
  state: FakeSupabaseState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  subpath: string,
  body: Buffer
): Promise<void> {
  const method = req.method ?? 'GET';
  if (subpath === 'health') {
    return send(req, res, state.ready ? 200 : 503, {
      ok: state.ready,
      service: 'eagle-eye-fake-supabase',
      migrations: state.migrations,
      seeded: state.fixture !== null,
      fixtureSeededAt: state.fixture?.seededAt ?? null,
      resets: state.resets
    });
  }
  if (header(req, TEST_CONTROL_HEADER) !== TEST_CONTROL_TOKEN) {
    throw new HttpError(403, { message: `Test control endpoints need the ${TEST_CONTROL_HEADER} header` });
  }
  const input = (parseJsonBody(body) ?? {}) as Record<string, unknown>;

  if (subpath === 'reset' && method === 'POST') {
    const fixture = await state.reset({ seed: input.seed !== false });
    return send(req, res, 200, { fixture });
  }
  if (subpath === 'fixture' && method === 'GET') {
    if (!state.fixture) throw new HttpError(404, { message: 'No fixture seeded (POST /__test/reset)' });
    return send(req, res, 200, state.fixture);
  }
  if (subpath === 'sql' && method === 'POST') {
    const sql = typeof input.sql === 'string' ? input.sql : '';
    const params = Array.isArray(input.params) ? input.params : [];
    if (!sql) throw new HttpError(400, { message: 'sql is required' });
    const as = input.as as { role?: unknown; userId?: unknown; email?: unknown } | undefined;
    try {
      if (as) {
        const role = as.role === 'anon' || as.role === 'service_role' ? as.role : 'authenticated';
        let caller: Caller;
        if (role === 'authenticated') {
          if (typeof as.userId !== 'string') throw new HttpError(400, { message: 'as.userId is required for authenticated' });
          const email = typeof as.email === 'string' ? as.email : state.users.get(as.userId)?.email ?? null;
          caller = { role: 'authenticated', userId: as.userId, email, sessionId: null, claims: { sub: as.userId, role: 'authenticated', email } };
        } else {
          caller = { role };
        }
        const result = await state.runAs(caller, { method: 'POST', path: '/__test/sql', headers: {} }, (tx) => tx.query(sql, params));
        return send(req, res, 200, { rows: result.rows, affectedRows: result.affectedRows ?? 0, fields: result.fields.map((f) => f.name) });
      }
      if (input.multi === true) {
        const results = await state.asSuperuser((db) => db.exec(sql));
        return send(req, res, 200, { results: results.map((r) => ({ rows: r.rows, affectedRows: r.affectedRows ?? 0 })) });
      }
      const result = await state.asSuperuser((db) => db.query(sql, params));
      return send(req, res, 200, { rows: result.rows, affectedRows: result.affectedRows ?? 0, fields: result.fields.map((f) => f.name) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const e = error as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
      throw new HttpError(400, {
        code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
        message: typeof e.message === 'string' ? e.message : String(error),
        details: typeof e.detail === 'string' ? e.detail : null,
        hint: typeof e.hint === 'string' ? e.hint : null
      });
    }
  }
  if (subpath === 'requests' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    return send(req, res, 200, { lastSeq: state.requestSeq, entries: state.requestLog.filter((entry) => entry.seq > since) });
  }
  if (subpath === 'faults') {
    if (method === 'GET') return send(req, res, 200, { faults: state.faults.map((f) => ({ ...f, path: f.path.source })) });
    if (method === 'DELETE') {
      state.faults = [];
      return send(req, res, 200, { faults: [] });
    }
    if (method === 'POST') {
      const rules = (Array.isArray(input.rules) ? input.rules : [input]) as FaultRuleInput[];
      const added = state.addFaults(rules);
      return send(req, res, 200, { added: added.map((f) => ({ ...f, path: f.path.source })) });
    }
  }
  if (subpath === 'outage' && method === 'POST') {
    state.faults = state.faults.filter((f) => f.tag !== 'outage');
    if (input.on === true) {
      state.addFaults([{ path: '^/(auth|rest|storage)/', action: 'network_error', times: Number.MAX_SAFE_INTEGER, tag: 'outage' }]);
    }
    return send(req, res, 200, { outage: input.on === true });
  }
  if (subpath === 'recoveries' && method === 'GET') return send(req, res, 200, { recoveries: recoveryLinks(state) });
  if (subpath === 'sessions' && method === 'GET') {
    return send(req, res, 200, {
      sessions: [...state.sessions.values()].map((s) => ({ id: s.id, userId: s.userId, revoked: s.revoked, createdAt: new Date(s.createdAt).toISOString(), amr: s.amr }))
    });
  }
  if (subpath === 'config' && method === 'POST') {
    if (input.jwtExpirySeconds !== undefined) {
      const seconds = Number(input.jwtExpirySeconds);
      if (!Number.isInteger(seconds) || seconds < 5) throw new HttpError(400, { message: 'jwtExpirySeconds must be an integer >= 5' });
      state.jwtExpirySeconds = seconds;
    }
    return send(req, res, 200, { jwtExpirySeconds: state.jwtExpirySeconds });
  }
  if (subpath === 'storage' && method === 'GET') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const objects = [...state.objects.values()]
      .filter((o) => `${o.bucket}/${o.name}`.startsWith(prefix))
      .map((o) => ({ bucket: o.bucket, name: o.name, size: o.bytes.length, contentType: o.contentType, createdAt: o.createdAt }));
    return send(req, res, 200, { objects });
  }
  if (subpath === 'storage/object' && method === 'GET') {
    const object = state.objects.get(`${url.searchParams.get('bucket') ?? ''}/${url.searchParams.get('name') ?? ''}`);
    if (!object) throw new HttpError(404, { message: 'Object not found' });
    return send(req, res, 200, object.bytes, { 'Content-Type': object.contentType });
  }
  throw new HttpError(404, { message: `No test control route for ${method} /__test/${subpath}` });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Does a request to the freshly bound port come back (any HTTP status)? */
function roundTrip(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: '/__test/health', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function listenOnReachablePort(server: Server, host: string): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 20_000 + randomInt(40_000);
    try {
      await listen(server, candidate, host);
    } catch (error) {
      lastError = error;
      continue; // EADDRINUSE / EACCES (excluded range): next candidate
    }
    if (await roundTrip(host, candidate, 2_000)) return candidate;
    lastError = new Error(`port ${candidate} was bound but did not answer`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`fake Supabase: no usable port found (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

export async function startFakeSupabase(options: { port?: number; host?: string; quiet?: boolean } = {}): Promise<FakeSupabaseServer> {
  const host = options.host ?? '127.0.0.1';
  let port = options.port ?? FAKE_SUPABASE_PORT;
  let url = `http://${host}:${port}`;
  const state = new FakeSupabaseState(url);
  const postgrest = new PostgrestHandler(state);
  const storage = new StorageHandler(state);

  const server = createServer((req, res) => {
    const started = Date.now();
    const ctx: RequestContext = { caller: null, errorCode: null, fault: null };
    const requestUrl = new URL(req.url ?? '/', url);
    const pathAndQuery = `${requestUrl.pathname}${requestUrl.search}`;
    const isControl = requestUrl.pathname.startsWith('/__test/');
    if (!isControl) {
      res.on('close', () => {
        const who = callerRole(ctx.caller);
        state.log({
          at: new Date(started).toISOString(),
          method: req.method ?? 'GET',
          path: pathAndQuery,
          status: res.headersSent ? res.statusCode : 0,
          role: who.role,
          userId: who.userId,
          durationMs: Date.now() - started,
          errorCode: ctx.errorCode,
          fault: ctx.fault
        });
      });
    }
    void (async () => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders(req));
          res.end();
          return;
        }
        if (!isControl) {
          if (!state.ready) throw new HttpError(503, { message: 'Fake Supabase is starting' });
          const fault = state.takeFault(req.method ?? 'GET', pathAndQuery);
          if (fault) {
            ctx.fault = fault.action;
            if (fault.action === 'network_error') {
              req.socket.destroy();
              return;
            }
            if (fault.action === 'status') {
              ctx.errorCode = errorCodeOf(fault.body);
              send(req, res, fault.status, fault.body);
              return;
            }
            if (fault.action === 'delay') await sleep(fault.delayMs);
            if (fault.action === 'lose_response') loseResponse(res);
          }
        }
        const body = await readBody(req);
        const match = /^\/(__test|auth\/v1|rest\/v1|storage\/v1|realtime\/v1)(?:\/(.*))?$/.exec(requestUrl.pathname);
        if (!match) throw new HttpError(404, { message: `Not found: ${requestUrl.pathname}` });
        const [, service, rest = ''] = match;
        if (service === '__test') return await handleControl(state, req, res, requestUrl, rest, body);
        if (service === 'auth/v1') return await handleAuth(state, req, res, requestUrl, rest, body);
        if (service === 'realtime/v1') {
          throw new HttpError(503, { message: 'Realtime is not available in the E2E fake server; the app must poll.' });
        }
        if (service === 'rest/v1') {
          ctx.caller = resolveCaller(state, req, 'rest');
          return await postgrest.handle(req, res, requestUrl, rest, ctx.caller, body);
        }
        return await storage.handle(
          req,
          res,
          requestUrl,
          rest,
          () => {
            ctx.caller = resolveCaller(state, req, 'storage');
            return ctx.caller;
          },
          body
        );
      } catch (error) {
        if (error instanceof HttpError) {
          ctx.errorCode = errorCodeOf(error.body);
          send(req, res, error.status, error.body, error.headers);
          return;
        }
        ctx.errorCode = 'internal';
        if (!options.quiet) console.error('[fake-supabase] internal error', req.method, pathAndQuery, error);
        send(req, res, 500, { code: 'XX000', message: error instanceof Error ? error.message : String(error), details: null, hint: null });
      }
    })();
  });

  // Realtime: refuse WebSocket upgrades cleanly (supabase-js reports CHANNEL_ERROR and retries).
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    state.realtimeUpgradesRefused += 1;
    const message = 'Realtime is not available in the E2E fake server\n';
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`
    );
  });

  await state.init();
  if (port === 0) {
    // "Any free port": a random HIGH port that answers a real round trip. The OS pick (listen(0))
    // is avoided because this machine's dynamic range starts at 1024, and parallel test files
    // saw connection timeouts on such low ports.
    port = await listenOnReachablePort(server, host);
  } else {
    await listen(server, port, host);
  }
  url = `http://${host}:${port}`;
  state.baseUrl = url;

  return {
    url,
    port,
    state,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await state.close();
    }
  };
}
