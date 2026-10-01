/**
 * Patrol-phone guard sign-in, server side (src/lib/auth/deviceLogin.ts) with fake dependencies:
 * request validation, error mapping, the "e-mail never leaves the server" rule, the order
 * "database authorises → only then a magic link", and the absence of any fallback success.
 */
// Must stay the first import: lets node:test load the `server-only` module below.
import '../testing/allowServerOnly';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEVICE_LOGIN_ERROR_CODES,
  DEVICE_LOGIN_ERROR_STATUS,
  DEVICE_UPSTREAM_TIMEOUT_MS,
  MAX_DEVICE_REQUEST_BYTES,
  ServerNotConfiguredError,
  createDeviceLoginDeps,
  deviceLoginRequestSchema,
  deviceRosterRequestSchema,
  getDeviceRoster,
  handleDeviceLoginRequest,
  handleDeviceRosterRequest,
  isValidDeviceSecret,
  isValidGuardId,
  issueGuardDeviceSession,
  mapRpcError,
  readLimitedBodyText,
  redactForLog,
  type DeviceHttpRequest,
  type DeviceLoginDeps,
  type DeviceRpcName,
  type MagicLinkResult,
  type RpcResponse
} from './deviceLogin';
import { DEVICE_REQUEST_TIMEOUT_MS, PATROL_DEVICE_STORAGE_KEY, fetchDeviceRoster, savePatrolDevice, signInGuardOnDevice } from './patrolDevice';

const SECRET = `EED-${'0123456789abcdef'.repeat(4)}`;
const OTHER_SECRET = `EED-${'fedcba9876543210'.repeat(4)}`;
const GUARD = 'a1111111-2222-4333-8444-555555555555';
const OTHER_GUARD = 'b2222222-3333-4444-8555-666666666666';
const DEVICE = 'c3333333-4444-4555-8666-777777777777';
const SITE = 'd4444444-5555-4666-8777-888888888888';
const EMAIL = 'wag1@guards.eagleeye.local';
const TOKEN = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15';

const ROSTER_ROW = {
  device: { id: DEVICE, label: 'Gate phone 1' },
  site: { id: SITE, name: 'Boplaas' },
  guards: [
    { id: GUARD, first_name: 'Sipho', last_name: 'Dlamini' },
    { id: OTHER_GUARD, first_name: 'Johan', last_name: 'van Wyk' }
  ]
};

const LOGIN_ROW = { user_id: GUARD, email: EMAIL, device_id: DEVICE, site_id: SITE };

interface Calls {
  rpc: Array<{ fn: DeviceRpcName; args: Record<string, unknown> }>;
  link: string[];
  logs: string[];
}

interface FakeOptions {
  rpc?: (fn: DeviceRpcName, args: Record<string, unknown>) => Promise<RpcResponse>;
  link?: (email: string) => Promise<MagicLinkResult>;
  timeoutMs?: number;
}

function fakeDeps(options: FakeOptions = {}): { deps: DeviceLoginDeps; calls: Calls } {
  const calls: Calls = { rpc: [], link: [], logs: [] };
  const deps: DeviceLoginDeps = {
    rpc: async (fn, args) => {
      calls.rpc.push({ fn, args });
      if (options.rpc) return options.rpc(fn, args);
      return { data: fn === 'device_roster' ? ROSTER_ROW : LOGIN_ROW, error: null };
    },
    generateMagicLink: async (email) => {
      calls.link.push(email);
      return options.link ? options.link(email) : { hashedToken: TOKEN };
    },
    log: (message, detail) => {
      calls.logs.push(JSON.stringify({ message, detail }));
    },
    timeoutMs: options.timeoutMs ?? 2_000
  };
  return { deps, calls };
}

const rpcError = (message: string, code = '42501') => async (): Promise<RpcResponse> => ({ data: null, error: { message, code } });

function jsonRequest(body: unknown, headers: Record<string, string> = {}): DeviceHttpRequest {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request('http://localhost/api/auth/device-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: text
  });
  return {
    contentType: request.headers.get('content-type'),
    contentLength: request.headers.get('content-length'),
    body: request.body
  };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

/** Every string anywhere in a value (keys and values), for "never contains" checks. */
function serialised(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

// ---------------------------------------------------------------------------------------------

describe('request validation helpers', () => {
  it('accepts only EED- + 64 lower-case hex device secrets', () => {
    assert.equal(isValidDeviceSecret(SECRET), true);
    assert.equal(isValidDeviceSecret(OTHER_SECRET), true);
    for (const bad of [
      SECRET.toUpperCase(),
      `EED-${'0123456789ABCDEF'.repeat(4)}`,
      SECRET.slice(0, -1),
      `${SECRET}0`,
      ` ${SECRET}`,
      `${SECRET}\n`,
      `eed-${'0'.repeat(64)}`,
      `XYZ-${'0'.repeat(64)}`,
      `EED-${'g'.repeat(64)}`,
      '0'.repeat(68),
      '',
      null,
      undefined,
      42,
      { secret: SECRET }
    ]) {
      assert.equal(isValidDeviceSecret(bad), false, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it('accepts only uuid guard ids', () => {
    assert.equal(isValidGuardId(GUARD), true);
    assert.equal(isValidGuardId(GUARD.toUpperCase()), true);
    assert.equal(isValidGuardId('00000000-0000-0000-0000-000000000001'), true);
    for (const bad of [`${GUARD}0`, GUARD.slice(1), 'wag1', EMAIL, `${GUARD} `, '', null, undefined, 7]) {
      assert.equal(isValidGuardId(bad), false, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it('request schemas are strict: an e-mail or any other identity field is refused', () => {
    assert.equal(deviceRosterRequestSchema.safeParse({ deviceSecret: SECRET }).success, true);
    assert.equal(deviceRosterRequestSchema.safeParse({ deviceSecret: SECRET, email: EMAIL }).success, false);
    assert.equal(deviceRosterRequestSchema.safeParse({ deviceSecret: SECRET, siteId: SITE }).success, false);
    assert.equal(deviceRosterRequestSchema.safeParse({}).success, false);

    const ok = deviceLoginRequestSchema.safeParse({ deviceSecret: SECRET, guardId: GUARD.toUpperCase() });
    assert.equal(ok.success, true);
    assert.equal(ok.success && ok.data.guardId, GUARD, 'guard id is normalised to lower case');
    for (const extra of [{ email: EMAIL }, { userId: GUARD }, { password: 'x' }, { user_id: GUARD }, { redirectTo: 'https://evil.test' }]) {
      assert.equal(deviceLoginRequestSchema.safeParse({ deviceSecret: SECRET, guardId: GUARD, ...extra }).success, false);
    }
    assert.equal(deviceLoginRequestSchema.safeParse({ deviceSecret: SECRET, email: EMAIL }).success, false);
    assert.equal(deviceLoginRequestSchema.safeParse({ deviceSecret: SECRET, guardId: 'wag1' }).success, false);
  });

  it('error codes map to the agreed HTTP statuses', () => {
    assert.deepEqual([...DEVICE_LOGIN_ERROR_CODES].sort(), [
      'device_not_enrolled',
      'guard_not_allowed',
      'invalid_request',
      'server_not_configured',
      'session_failed'
    ]);
    assert.deepEqual(
      { ...DEVICE_LOGIN_ERROR_STATUS },
      { invalid_request: 400, device_not_enrolled: 401, guard_not_allowed: 403, server_not_configured: 503, session_failed: 502 }
    );
  });

  it('maps only the two deliberate database exceptions; everything else is session_failed', () => {
    assert.equal(mapRpcError({ message: 'device_not_enrolled', code: '42501' }), 'device_not_enrolled');
    assert.equal(mapRpcError({ message: 'guard_not_allowed', code: '42501' }), 'guard_not_allowed');
    assert.equal(mapRpcError({ message: ' device_not_enrolled ' }), 'device_not_enrolled');
    // A missing EXECUTE grant or function must not make the phone forget its enrolment.
    assert.equal(mapRpcError({ message: 'permission denied for function device_roster', code: '42501' }), 'session_failed');
    assert.equal(mapRpcError({ message: 'Could not find the function public.device_roster(p_secret)', code: 'PGRST202' }), 'session_failed');
    assert.equal(mapRpcError({ message: 'Invalid API key', code: '401' }), 'session_failed');
    assert.equal(mapRpcError({ message: 'error: device_not_enrolled because …' }), 'session_failed');
    assert.equal(mapRpcError({}), 'session_failed');
    assert.equal(mapRpcError(null), 'session_failed');
  });
});

describe('getDeviceRoster', () => {
  it('returns device, site and guard names only (unknown columns are dropped)', async () => {
    const { deps, calls } = fakeDeps({
      rpc: async () => ({
        data: {
          ...ROSTER_ROW,
          secret_sha256: 'deadbeef',
          guards: ROSTER_ROW.guards.map((guard) => ({ ...guard, email: EMAIL, phone_number: '0821234567', employee_number: 'E1' }))
        },
        error: null
      })
    });
    const result = await getDeviceRoster(deps, SECRET);
    assert.deepEqual(result, {
      ok: true,
      device: { id: DEVICE, label: 'Gate phone 1' },
      site: { id: SITE, name: 'Boplaas' },
      guards: [
        { id: GUARD, firstName: 'Sipho', lastName: 'Dlamini' },
        { id: OTHER_GUARD, firstName: 'Johan', lastName: 'van Wyk' }
      ]
    });
    assert.deepEqual(calls.rpc, [{ fn: 'device_roster', args: { p_secret: SECRET } }]);
    assert.equal(calls.link.length, 0);
    const text = serialised(result);
    for (const leaked of [EMAIL, '0821234567', 'employee_number', 'secret_sha256', 'deadbeef', SECRET]) {
      assert.equal(text.includes(leaked), false, `roster must not contain ${leaked}`);
    }
  });

  it('an enrolled phone with no guards gets an empty list', async () => {
    const { deps } = fakeDeps({ rpc: async () => ({ data: { ...ROSTER_ROW, guards: [] }, error: null }) });
    const result = await getDeviceRoster(deps, SECRET);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.guards, []);
  });

  it('refuses a malformed secret without calling the database', async () => {
    const { deps, calls } = fakeDeps();
    for (const bad of ['', SECRET.toUpperCase(), `${SECRET}0`, null, undefined, 1]) {
      assert.deepEqual(await getDeviceRoster(deps, bad), { ok: false, error: 'invalid_request' });
    }
    assert.equal(calls.rpc.length, 0);
  });

  it('unknown / revoked phone (NULL result) → device_not_enrolled', async () => {
    const { deps } = fakeDeps({ rpc: async () => ({ data: null, error: null }) });
    assert.deepEqual(await getDeviceRoster(deps, SECRET), { ok: false, error: 'device_not_enrolled' });
  });

  it('maps database errors', async () => {
    const cases: Array<[FakeOptions['rpc'], string]> = [
      [rpcError('device_not_enrolled'), 'device_not_enrolled'],
      [rpcError('guard_not_allowed'), 'guard_not_allowed'],
      [rpcError('permission denied for function device_roster'), 'session_failed'],
      [rpcError('Could not find the function', 'PGRST202'), 'session_failed'],
      [
        async () => {
          throw new TypeError('fetch failed');
        },
        'session_failed'
      ],
      [
        async () => {
          throw new ServerNotConfiguredError();
        },
        'server_not_configured'
      ],
      [async () => ({ data: { device: { id: 'not-a-uuid' } }, error: null }), 'session_failed'],
      [async () => ({ data: 'surprise', error: null }), 'session_failed']
    ];
    for (const [rpc, expected] of cases) {
      const { deps, calls } = fakeDeps({ rpc });
      assert.deepEqual(await getDeviceRoster(deps, SECRET), { ok: false, error: expected });
      assert.equal(calls.link.length, 0);
    }
  });

  it('a hung database call ends as session_failed', async () => {
    const { deps } = fakeDeps({ rpc: () => new Promise<RpcResponse>(() => undefined), timeoutMs: 20 });
    assert.deepEqual(await getDeviceRoster(deps, SECRET), { ok: false, error: 'session_failed' });
  });
});

describe('issueGuardDeviceSession', () => {
  it('asks the database first, then generates a link for the e-mail it returned; returns only the token hash', async () => {
    const { deps, calls } = fakeDeps();
    const result = await issueGuardDeviceSession(deps, SECRET, GUARD);
    assert.deepEqual(result, { ok: true, tokenHash: TOKEN });
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'tokenHash']);
    assert.deepEqual(calls.rpc, [{ fn: 'device_guard_login', args: { p_secret: SECRET, p_guard_id: GUARD } }]);
    assert.deepEqual(calls.link, [EMAIL]);
    assert.equal(serialised(result).includes(EMAIL), false);
    assert.equal(serialised(result).includes('@'), false);
  });

  it('passes the guard id to the database in lower case', async () => {
    const { deps, calls } = fakeDeps();
    const result = await issueGuardDeviceSession(deps, SECRET, GUARD.toUpperCase());
    assert.equal(result.ok, true);
    assert.equal(calls.rpc[0]?.args.p_guard_id, GUARD);
  });

  it('refuses malformed input without touching the database or Auth', async () => {
    const { deps, calls } = fakeDeps();
    const cases: Array<[unknown, unknown]> = [
      [SECRET, 'wag1'],
      [SECRET, EMAIL],
      [SECRET, ''],
      [SECRET, null],
      ['', GUARD],
      [SECRET.toUpperCase(), GUARD],
      [undefined, undefined]
    ];
    for (const [secret, guardId] of cases) {
      assert.deepEqual(await issueGuardDeviceSession(deps, secret, guardId), { ok: false, error: 'invalid_request' });
    }
    assert.equal(calls.rpc.length, 0);
    assert.equal(calls.link.length, 0);
  });

  it('maps every database refusal and never generates a link unless the database authorised the guard', async () => {
    const cases: Array<[FakeOptions['rpc'], string]> = [
      [rpcError('device_not_enrolled'), 'device_not_enrolled'],
      [rpcError('guard_not_allowed'), 'guard_not_allowed'],
      [rpcError('permission denied for function device_guard_login'), 'session_failed'],
      [rpcError('connection terminated', '08006'), 'session_failed'],
      [
        async () => {
          throw new TypeError('fetch failed');
        },
        'session_failed'
      ],
      [
        async () => {
          throw new ServerNotConfiguredError();
        },
        'server_not_configured'
      ],
      // Unexpected results are refused, never "repaired".
      [async () => ({ data: null, error: null }), 'session_failed'],
      [async () => ({ data: { ...LOGIN_ROW, email: null }, error: null }), 'session_failed'],
      [async () => ({ data: { ...LOGIN_ROW, email: '' }, error: null }), 'session_failed'],
      [async () => ({ data: { ...LOGIN_ROW, email: 'not an email' }, error: null }), 'session_failed'],
      [async () => ({ data: { ...LOGIN_ROW, user_id: OTHER_GUARD }, error: null }), 'session_failed'],
      [async () => ({ data: { email: EMAIL }, error: null }), 'session_failed'],
      [async () => ({ data: [LOGIN_ROW], error: null }), 'session_failed']
    ];
    for (const [rpc, expected] of cases) {
      const { deps, calls } = fakeDeps({ rpc });
      const result = await issueGuardDeviceSession(deps, SECRET, GUARD);
      assert.deepEqual(result, { ok: false, error: expected });
      assert.equal(calls.link.length, 0, `no magic link may be generated when the database says ${expected}`);
    }
  });

  it('Auth failures after authorisation are session_failed (or server_not_configured), never a success', async () => {
    const cases: Array<[FakeOptions['link'], string]> = [
      [async () => ({ error: 'user_not_found' }), 'session_failed'],
      [async () => ({ hashedToken: '' }), 'session_failed'],
      [async () => ({ hashedToken: 'has spaces in it and is long' }), 'session_failed'],
      [async () => ({}) as unknown as MagicLinkResult, 'session_failed'],
      [
        async () => {
          throw new Error('boom');
        },
        'session_failed'
      ],
      [
        async () => {
          throw new ServerNotConfiguredError();
        },
        'server_not_configured'
      ],
      [() => new Promise<MagicLinkResult>(() => undefined), 'session_failed']
    ];
    for (const [link, expected] of cases) {
      const { deps, calls } = fakeDeps({ link, timeoutMs: 50 });
      const result = await issueGuardDeviceSession(deps, SECRET, GUARD);
      assert.deepEqual(result, { ok: false, error: expected });
      assert.deepEqual(calls.link, [EMAIL]);
    }
  });

  it('server logs are redacted: no device secret and no e-mail address', async () => {
    const leaky = `invalid input "${SECRET}" for ${EMAIL}`;
    const { deps, calls } = fakeDeps({ rpc: rpcError(leaky, 'XX000') });
    assert.deepEqual(await issueGuardDeviceSession(deps, SECRET, GUARD), { ok: false, error: 'session_failed' });
    const thrower = fakeDeps({
      rpc: async () => {
        throw new Error(leaky);
      }
    });
    await getDeviceRoster(thrower.deps, SECRET);
    const logs = [...calls.logs, ...thrower.calls.logs].join('\n');
    assert.ok(logs.length > 0, 'failures are logged server-side');
    assert.equal(logs.includes(SECRET), false);
    assert.equal(logs.includes(EMAIL), false);
    assert.equal(redactForLog(`a ${SECRET} b ${EMAIL} c`), 'a [device-secret] b [email] c');
  });
});

describe('no fallback success', () => {
  it('every failure path yields ok:false and carries no token, session or e-mail', async () => {
    const scenarios: FakeOptions[] = [
      { rpc: rpcError('device_not_enrolled') },
      { rpc: rpcError('guard_not_allowed') },
      { rpc: rpcError('anything else') },
      { rpc: async () => ({ data: null, error: null }) },
      { link: async () => ({ error: 'x' }) },
      {
        rpc: async () => {
          throw new ServerNotConfiguredError();
        }
      },
      {
        link: async () => {
          throw new Error('x');
        }
      }
    ];
    for (const scenario of scenarios) {
      const { deps } = fakeDeps(scenario);
      const session = await issueGuardDeviceSession(deps, SECRET, GUARD);
      assert.equal(session.ok, false);
      assert.deepEqual(Object.keys(session).sort(), ['error', 'ok']);
      const text = serialised(session);
      for (const leaked of [TOKEN, EMAIL, 'fallback', 'tokenHash', 'access_token']) {
        assert.equal(text.includes(leaked), false, `failure result must not contain ${leaked}`);
      }
    }
  });

  it('the module and routes contain no fallback success, shared password or client-supplied e-mail login', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const files = [
      'src/lib/auth/deviceLogin.ts',
      'src/app/api/auth/device-roster/route.ts',
      'src/app/api/auth/device-login/route.ts'
    ].map((path) => ({ path, text: readFileSync(resolve(root, path), 'utf8') }));
    for (const { path, text } of files) {
      assert.doesNotMatch(text, /['"]?fallback['"]?\s*:\s*(true|1|['"`{[])/i, `${path}: no fallback flag`);
      assert.doesNotMatch(text, /ok\s*:\s*true\s*,\s*fallback/i, `${path}: no fallback success`);
      assert.doesNotMatch(text, /signInWithPassword|password\s*[:=]\s*['"`]/i, `${path}: no password sign-in or shared password`);
      assert.doesNotMatch(text, /(body|json|request)\??\.email\b/, `${path}: never reads an e-mail from the request`);
    }
    // The only request fields that exist are the device secret and the roster id.
    assert.deepEqual(Object.keys(deviceRosterRequestSchema.shape), ['deviceSecret']);
    assert.deepEqual(Object.keys(deviceLoginRequestSchema.shape).sort(), ['deviceSecret', 'guardId']);
    const [lib, rosterRoute, loginRoute] = files;
    // The library is server-only (a browser import fails the build) but takes the service-role
    // client factory as a parameter instead of importing the admin module itself…
    assert.match(lib.text, /^import 'server-only';$/m);
    assert.doesNotMatch(lib.text, /^import\s[^;]*['"](@\/lib\/supabase\/admin|\.\.\/supabase\/admin)['"]/m);
    // …and the routes (its only importers) are server-only too.
    for (const route of [rosterRoute, loginRoute]) {
      assert.match(route.text, /^import 'server-only';$/m);
      assert.match(route.text, /createServiceRoleClient/);
      assert.match(route.text, /'Cache-Control': 'no-store'/);
      assert.match(route.text, /export const runtime = 'nodejs'/);
      assert.match(route.text, /export const dynamic = 'force-dynamic'/);
      assert.doesNotMatch(route.text, /export async function GET/);
    }
    // The magic link is only ever generated for the e-mail returned by device_guard_login.
    assert.deepEqual(lib.text.match(/deps\.generateMagicLink\([^)]*\)/g), ['deps.generateMagicLink(parsed.data.email)']);
    assert.deepEqual(lib.text.match(/\(\)\.auth\.admin\.generateLink\(\{[^}]*\}\)/g), ["().auth.admin.generateLink({ type: 'magiclink', email })"]);
  });
});

describe('server-only boundary', () => {
  it('only the two route handlers (and tests) import values from deviceLogin; nothing imports the test stub', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(resolve(root, 'src'));
    const valueImporters: string[] = [];
    const stubImporters: string[] = [];
    for (const file of files) {
      const rel = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      const imports = text.match(/^import\s+(?!type\s)[^;]*?from\s+['"][^'"]*\/deviceLogin['"]/gm) ?? [];
      if (imports.length > 0 && !rel.endsWith('.test.ts')) valueImporters.push(rel);
      if (/['"][^'"]*testing\/allowServerOnly['"]/.test(text) && !rel.endsWith('.test.ts') && !rel.endsWith('allowServerOnly.ts')) {
        stubImporters.push(rel);
      }
    }
    assert.deepEqual(valueImporters.sort(), ['src/app/api/auth/device-login/route.ts', 'src/app/api/auth/device-roster/route.ts']);
    assert.deepEqual(stubImporters, []);
  });
});

describe('createDeviceLoginDeps', () => {
  it('a missing service-role key → server_not_configured (after input validation), client built lazily', async () => {
    let factoryCalls = 0;
    const logs: string[] = [];
    const deps = createDeviceLoginDeps(
      () => {
        factoryCalls += 1;
        throw new Error('Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set (server environment only).');
      },
      (message) => logs.push(message)
    );
    assert.equal(factoryCalls, 0, 'nothing is created until a valid request needs it');
    assert.deepEqual(await getDeviceRoster(deps, 'nope'), { ok: false, error: 'invalid_request' });
    assert.equal(factoryCalls, 0);
    assert.deepEqual(await getDeviceRoster(deps, SECRET), { ok: false, error: 'server_not_configured' });
    assert.deepEqual(await issueGuardDeviceSession(deps, SECRET, GUARD), { ok: false, error: 'server_not_configured' });
    const outcome = await handleDeviceLoginRequest(jsonRequest({ deviceSecret: SECRET, guardId: GUARD }), deps);
    assert.deepEqual(outcome, { status: 503, body: { ok: false, error: 'server_not_configured' } });
    assert.ok(logs.length > 0);
  });

  it('calls the database functions and auth.admin.generateLink({ type: magiclink }) on one cached client', async () => {
    let created = 0;
    const rpcCalls: Array<[string, unknown]> = [];
    const linkCalls: unknown[] = [];
    const fakeClient = {
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push([fn, args]);
        return { data: LOGIN_ROW, error: null };
      },
      auth: {
        admin: {
          generateLink: async (params: unknown) => {
            linkCalls.push(params);
            return {
              data: { properties: { hashed_token: TOKEN, action_link: `https://x/verify?token=${TOKEN}`, email_otp: '123456' }, user: {} },
              error: null
            };
          }
        }
      }
    };
    const deps = createDeviceLoginDeps(() => {
      created += 1;
      return fakeClient as unknown as SupabaseClient;
    });
    const result = await issueGuardDeviceSession(deps, SECRET, GUARD);
    assert.deepEqual(result, { ok: true, tokenHash: TOKEN });
    assert.deepEqual(rpcCalls, [['device_guard_login', { p_secret: SECRET, p_guard_id: GUARD }]]);
    assert.deepEqual(linkCalls, [{ type: 'magiclink', email: EMAIL }]);
    assert.equal(created, 1);
    assert.equal(serialised(result).includes('123456'), false, 'the e-mail OTP is not returned');
  });

  it('passes database errors through as { message, code } and Auth errors as a code only', async () => {
    const fakeClient = {
      rpc: async () => ({ data: null, error: { message: 'guard_not_allowed', code: '42501', details: null, hint: null } }),
      auth: {
        admin: {
          generateLink: async () => ({ data: { properties: null, user: null }, error: { code: 'user_not_found', status: 404, message: `User ${EMAIL} not found` } })
        }
      }
    };
    const deps = createDeviceLoginDeps(() => fakeClient as unknown as SupabaseClient, () => undefined);
    assert.deepEqual(await deps.rpc('device_guard_login', { p_secret: SECRET, p_guard_id: GUARD }), {
      data: null,
      error: { message: 'guard_not_allowed', code: '42501' }
    });
    assert.deepEqual(await issueGuardDeviceSession(deps, SECRET, GUARD), { ok: false, error: 'guard_not_allowed' });
    const link = await deps.generateMagicLink(EMAIL);
    assert.deepEqual(link, { error: 'user_not_found' });
    assert.equal(serialised(link).includes(EMAIL), false);
  });
});

describe('HTTP handling', () => {
  it('POST device-roster: 200 { ok: true, device, site, guards }', async () => {
    const { deps } = fakeDeps();
    const outcome = await handleDeviceRosterRequest(jsonRequest({ deviceSecret: SECRET }), deps);
    assert.equal(outcome.status, 200);
    assert.deepEqual(Object.keys(outcome.body).sort(), ['device', 'guards', 'ok', 'site']);
    assert.deepEqual(outcome.body, {
      ok: true,
      device: { id: DEVICE, label: 'Gate phone 1' },
      site: { id: SITE, name: 'Boplaas' },
      guards: [
        { id: GUARD, firstName: 'Sipho', lastName: 'Dlamini' },
        { id: OTHER_GUARD, firstName: 'Johan', lastName: 'van Wyk' }
      ]
    });
  });

  it('POST device-login: 200 { ok: true, tokenHash } and nothing else', async () => {
    const { deps } = fakeDeps();
    const outcome = await handleDeviceLoginRequest(jsonRequest({ deviceSecret: SECRET, guardId: GUARD }), deps);
    assert.deepEqual(outcome, { status: 200, body: { ok: true, tokenHash: TOKEN } });
  });

  it('maps every error code to its status with a generic { ok: false, error } body', async () => {
    const cases: Array<[FakeOptions, number, string]> = [
      [{ rpc: rpcError('device_not_enrolled') }, 401, 'device_not_enrolled'],
      [{ rpc: rpcError('guard_not_allowed') }, 403, 'guard_not_allowed'],
      [
        {
          rpc: async () => {
            throw new ServerNotConfiguredError();
          }
        },
        503,
        'server_not_configured'
      ],
      [{ rpc: rpcError('boom', 'XX000') }, 502, 'session_failed'],
      [{ link: async () => ({ error: 'x' }) }, 502, 'session_failed']
    ];
    for (const [options, status, error] of cases) {
      const { deps } = fakeDeps(options);
      assert.deepEqual(await handleDeviceLoginRequest(jsonRequest({ deviceSecret: SECRET, guardId: GUARD }), deps), {
        status,
        body: { ok: false, error }
      });
    }
    const revoked = fakeDeps({ rpc: async () => ({ data: null, error: null }) });
    assert.deepEqual(await handleDeviceRosterRequest(jsonRequest({ deviceSecret: SECRET }), revoked.deps), {
      status: 401,
      body: { ok: false, error: 'device_not_enrolled' }
    });
  });

  it('refuses bad requests with 400 before any database call', async () => {
    const { deps, calls } = fakeDeps();
    const bad: DeviceHttpRequest[] = [
      jsonRequest({ deviceSecret: SECRET, guardId: GUARD, email: EMAIL }),
      jsonRequest({ deviceSecret: SECRET, email: EMAIL }),
      jsonRequest({ email: EMAIL }),
      jsonRequest({ deviceSecret: SECRET, guardId: GUARD, userId: OTHER_GUARD }),
      jsonRequest({ deviceSecret: SECRET, guardId: 'wag1' }),
      jsonRequest({ deviceSecret: SECRET.toUpperCase(), guardId: GUARD }),
      jsonRequest({ deviceSecret: SECRET }),
      jsonRequest([SECRET, GUARD]),
      jsonRequest('null'),
      jsonRequest('{"deviceSecret":'),
      jsonRequest(''),
      jsonRequest({ deviceSecret: SECRET, guardId: GUARD }, { 'content-type': 'text/plain' }),
      jsonRequest({ deviceSecret: SECRET, guardId: GUARD }, { 'content-type': 'application/x-www-form-urlencoded' }),
      jsonRequest({ deviceSecret: SECRET, guardId: GUARD, padding: 'x'.repeat(MAX_DEVICE_REQUEST_BYTES) }),
      { contentType: 'application/json', contentLength: null, body: null },
      { contentType: null, contentLength: null, body: streamOf(new TextEncoder().encode(JSON.stringify({ deviceSecret: SECRET, guardId: GUARD }))) },
      // Declared too large: refused without reading.
      { contentType: 'application/json', contentLength: '999999', body: streamOf(new TextEncoder().encode('{}')) },
      { contentType: 'application/json', contentLength: 'abc', body: streamOf(new TextEncoder().encode('{}')) },
      // Streamed without a length and larger than the limit.
      {
        contentType: 'application/json; charset=utf-8',
        contentLength: null,
        body: streamOf(new TextEncoder().encode('{"deviceSecret":"'), new Uint8Array(MAX_DEVICE_REQUEST_BYTES).fill(0x61))
      },
      // Not UTF-8.
      { contentType: 'application/json', contentLength: null, body: streamOf(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])) }
    ];
    for (const request of bad) {
      const outcome = await handleDeviceLoginRequest(request, deps);
      assert.deepEqual(outcome, { status: 400, body: { ok: false, error: 'invalid_request' } });
    }
    for (const body of [{ deviceSecret: SECRET, email: EMAIL }, { deviceSecret: 'EED-123' }, { deviceSecret: SECRET, guardId: GUARD }]) {
      assert.deepEqual(await handleDeviceRosterRequest(jsonRequest(body), deps), { status: 400, body: { ok: false, error: 'invalid_request' } });
    }
    assert.equal(calls.rpc.length, 0);
    assert.equal(calls.link.length, 0);
  });

  it('accepts application/json with a charset parameter', async () => {
    const { deps } = fakeDeps();
    const outcome = await handleDeviceRosterRequest(
      jsonRequest({ deviceSecret: SECRET }, { 'content-type': 'application/json; charset=utf-8' }),
      deps
    );
    assert.equal(outcome.status, 200);
  });
});

describe('readLimitedBodyText', () => {
  it('reads up to the limit and refuses anything larger', async () => {
    const exact = new Uint8Array(MAX_DEVICE_REQUEST_BYTES).fill(0x61);
    assert.equal((await readLimitedBodyText(streamOf(exact)))?.length, MAX_DEVICE_REQUEST_BYTES);
    assert.equal(await readLimitedBodyText(streamOf(exact, new Uint8Array([0x61]))), null);
    assert.equal(await readLimitedBodyText(streamOf(new TextEncoder().encode('{"a":'), new TextEncoder().encode('1}'))), '{"a":1}');
    assert.equal(await readLimitedBodyText(null), null);
    assert.equal(await readLimitedBodyText(streamOf(new Uint8Array([0xc3]))), null, 'truncated UTF-8 is refused');
  });
});

// ---------------------------------------------------------------------------------------------
// Contract with the browser client (src/lib/auth/patrolDevice.ts): the real client talks to these
// handlers through an injected fetch, so a shape mismatch between the two sides fails here.
// ---------------------------------------------------------------------------------------------

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function enrolledStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  savePatrolDevice(
    { deviceId: DEVICE, secret: SECRET, siteId: SITE, siteName: 'Boplaas', label: 'Gate phone 1', enrolledAt: '2026-10-01T18:00:00.000Z' },
    storage
  );
  return storage;
}

function handlerFetch(deps: DeviceLoginDeps, sent: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const request = new Request(new URL(path, 'http://localhost'), { method: init?.method, headers: init?.headers, body: init?.body });
    sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
    const http: DeviceHttpRequest = {
      contentType: request.headers.get('content-type'),
      contentLength: request.headers.get('content-length'),
      body: request.body
    };
    if (path === '/api/auth/device-roster') {
      const outcome = await handleDeviceRosterRequest(http, deps);
      return Response.json(outcome.body, { status: outcome.status });
    }
    if (path === '/api/auth/device-login') {
      const outcome = await handleDeviceLoginRequest(http, deps);
      return Response.json(outcome.body, { status: outcome.status });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function fakeBrowserSupabase(verified: unknown[]): Pick<SupabaseClient, 'auth'> {
  return {
    auth: {
      verifyOtp: async (params: unknown) => {
        verified.push(params);
        const user = { id: GUARD };
        return { data: { user, session: { access_token: 'a', refresh_token: 'r', user } }, error: null };
      },
      signOut: async () => ({ error: null })
    }
  } as unknown as Pick<SupabaseClient, 'auth'>;
}

describe('contract with the browser client (patrolDevice.ts)', () => {
  const online = () => false;

  it('the phone waits longer than the server can take (two upstream calls), so a slow success is not reported as failed', () => {
    assert.ok(DEVICE_REQUEST_TIMEOUT_MS > 2 * DEVICE_UPSTREAM_TIMEOUT_MS, `${DEVICE_REQUEST_TIMEOUT_MS} vs 2 x ${DEVICE_UPSTREAM_TIMEOUT_MS}`);
  });

  it('roster and guard sign-in succeed end to end; the client sends no e-mail', async () => {
    const { deps, calls } = fakeDeps();
    const storage = enrolledStorage();
    const sent: unknown[] = [];
    const roster = await fetchDeviceRoster({ fetch: handlerFetch(deps, sent), storage, isOffline: online });
    assert.deepEqual(roster, {
      ok: true,
      device: { id: DEVICE, label: 'Gate phone 1' },
      site: { id: SITE, name: 'Boplaas' },
      guards: [
        { id: GUARD, firstName: 'Sipho', lastName: 'Dlamini' },
        { id: OTHER_GUARD, firstName: 'Johan', lastName: 'van Wyk' }
      ]
    });

    const verified: unknown[] = [];
    const signedIn = await signInGuardOnDevice(fakeBrowserSupabase(verified), GUARD, { fetch: handlerFetch(deps, sent), storage, isOffline: online });
    assert.deepEqual(signedIn, { ok: true, userId: GUARD });
    assert.deepEqual(verified, [{ token_hash: TOKEN, type: 'magiclink' }]);
    assert.deepEqual(sent, [{ deviceSecret: SECRET }, { deviceSecret: SECRET, guardId: GUARD }]);
    assert.equal(serialised(sent).includes('@'), false);
    assert.deepEqual(calls.link, [EMAIL]);
  });

  it('server refusals reach the client as the right error kinds', async () => {
    const cases: Array<[FakeOptions, string, boolean]> = [
      [{ rpc: rpcError('device_not_enrolled') }, 'not_enrolled', true],
      [{ rpc: rpcError('guard_not_allowed') }, 'not_allowed', false],
      [
        {
          rpc: async () => {
            throw new ServerNotConfiguredError();
          }
        },
        'server_not_configured',
        false
      ],
      [{ rpc: rpcError('boom', 'XX000') }, 'failed', false],
      [{ link: async () => ({ error: 'x' }) }, 'failed', false]
    ];
    for (const [options, expected, clearsEnrolment] of cases) {
      const { deps } = fakeDeps(options);
      const storage = enrolledStorage();
      const verified: unknown[] = [];
      const result = await signInGuardOnDevice(fakeBrowserSupabase(verified), GUARD, { fetch: handlerFetch(deps, []), storage, isOffline: online });
      assert.deepEqual(result, { ok: false, error: expected });
      assert.equal(verified.length, 0, 'no session is created after a refusal');
      assert.equal(storage.getItem(PATROL_DEVICE_STORAGE_KEY) === null, clearsEnrolment);
    }

    const revoked = fakeDeps({ rpc: async () => ({ data: null, error: null }) });
    const storage = enrolledStorage();
    assert.deepEqual(await fetchDeviceRoster({ fetch: handlerFetch(revoked.deps, []), storage, isOffline: online }), {
      ok: false,
      error: 'not_enrolled'
    });
    assert.equal(storage.getItem(PATROL_DEVICE_STORAGE_KEY), null, 'a revoked phone forgets its enrolment');
  });
});
