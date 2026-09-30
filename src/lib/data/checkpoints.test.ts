import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Checkpoint } from '@/types/models';
import {
  CHECKPOINT_COLUMNS,
  CheckpointLoadError,
  CheckpointSecretsError,
  classifyCheckpointWriteError,
  fetchCheckpointSecrets,
  generateCheckpointToken,
  loadCheckpoints,
  mapCheckpointRow,
  nfcSerialFingerprint,
  parseCheckpointPayload,
  qrTokenFingerprint,
  resolveCheckpoint,
  type CheckpointCacheRecord,
  type CheckpointCacheStore,
  type CheckpointRow
} from './checkpoints';

/** Independent reference (node:crypto) for the fingerprints the database stores. */
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const cp = (over: Partial<Checkpoint>): Checkpoint => ({
  id: 'id',
  siteId: 'site-1',
  name: 'Point',
  qrTokenSha256: sha('EE-CP-00000000000000000000000000000000'),
  permittedRadiusMeters: 50,
  orderIndex: 1,
  isActive: true,
  ...over
});

const checkpoints: Checkpoint[] = [
  cp({
    id: 'a',
    name: 'Main gate',
    qrTokenSha256: sha('EE-CP-3F2A9C0B7D5E41A8B6C9D0E1F2A3B4C5'),
    nfcUidSha256: sha('04:a2:3b:1c:5d:80:00'),
    legacyCode: 'CP1'
  }),
  cp({ id: 'b', name: 'Sheep kraal', qrTokenSha256: sha('EE-CP-MAIN-GATE-01'), nfcUidSha256: sha('04:11:22:33:44:55:66'), legacyCode: 'CP2' }),
  cp({
    id: 'c',
    name: 'Old pump',
    qrTokenSha256: sha('EE-CP-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    nfcUidSha256: sha('04:99:88:77:66:55:44'),
    legacyCode: 'CP5',
    isActive: false
  }),
  cp({ id: 'd', name: 'Shade-net garden', qrTokenSha256: sha('EE-CP-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), legacyCode: 'cp6' })
];

describe('generateCheckpointToken', () => {
  it('is EE-CP- + 32 upper-case hex characters', () => {
    const token = generateCheckpointToken();
    assert.match(token, /^EE-CP-[0-9A-F]{32}$/);
  });

  it('uses crypto.getRandomValues on 16 bytes (128 bits)', () => {
    const spy = mock.method(globalThis.crypto, 'getRandomValues');
    try {
      generateCheckpointToken();
      assert.strictEqual(spy.mock.callCount(), 1);
      const arg = spy.mock.calls[0].arguments[0] as Uint8Array;
      assert.ok(arg instanceof Uint8Array);
      assert.strictEqual(arg.length, 16);
    } finally {
      spy.mock.restore();
    }
  });

  it('maps the random bytes to hex exactly (no truncation)', () => {
    const token = generateCheckpointToken((bytes) => {
      bytes.forEach((_, i) => (bytes[i] = i * 17));
      return bytes;
    });
    assert.strictEqual(token, 'EE-CP-00112233445566778899AABBCCDDEEFF');
  });

  it('produces no duplicates over 10 000 tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) seen.add(generateCheckpointToken());
    assert.strictEqual(seen.size, 10000);
  });

  it('refuses to run without a CSPRNG instead of falling back to Math.random', () => {
    assert.throws(
      () =>
        generateCheckpointToken(() => {
          throw new Error('crypto.getRandomValues is unavailable');
        }),
      /unavailable/
    );
    assert.throws(() => generateCheckpointToken(() => new Uint8Array(4)), /unexpected buffer/);
  });
});

describe('parseCheckpointPayload', () => {
  it('accepts new 32-hex tokens and older seeded tokens', () => {
    assert.deepStrictEqual(parseCheckpointPayload('EE-CP-3F2A9C0B7D5E41A8B6C9D0E1F2A3B4C5'), {
      kind: 'secure_token',
      token: 'EE-CP-3F2A9C0B7D5E41A8B6C9D0E1F2A3B4C5'
    });
    assert.deepStrictEqual(parseCheckpointPayload('  EE-CP-MAIN-GATE-01\n'), { kind: 'secure_token', token: 'EE-CP-MAIN-GATE-01' });
  });

  it("parses Dawie's legacy PLAAS-CP cards", () => {
    assert.deepStrictEqual(parseCheckpointPayload('PLAAS-CP:CP5'), { kind: 'legacy_qr', code: 'CP5' });
  });

  it('rejects look-alikes and substrings (no containment matching)', () => {
    for (const raw of [
      'https://evil.example/?EE-CP-MAIN-GATE-01',
      'EE-CP-MAIN-GATE-01 extra',
      'EE-CP-ABC', // too short
      'ee-cp-main-gate-01', // tokens are upper case
      'EE-CP-' + 'A'.repeat(65),
      'PLAAS-CP:',
      'PLAAS-CP:CP 1',
      '04:a2:3b:1c:5d:80:00',
      ''
    ]) {
      assert.strictEqual(parseCheckpointPayload(raw).kind, 'unknown', raw);
    }
  });
});

describe('checkpoint fingerprints', () => {
  it('QR fingerprint is the lower-case hex SHA-256 of the token (checkpoints.qr_token_sha256)', async () => {
    assert.strictEqual(await qrTokenFingerprint('EE-CP-MAIN-GATE-01'), sha('EE-CP-MAIN-GATE-01'));
  });

  it('NFC fingerprint hashes the normalised serial, whatever the reader printed', async () => {
    for (const raw of ['04:a2:3b:1c:5d:80:00', '04:A2:3B:1C:5D:80:00', '04A23B1C5D8000', '04-a2-3b-1c-5d-80-00']) {
      assert.strictEqual(await nfcSerialFingerprint(raw), sha('04:a2:3b:1c:5d:80:00'), raw);
    }
    assert.strictEqual(await nfcSerialFingerprint(''), null);
    assert.strictEqual(await nfcSerialFingerprint('04:a2'), null, 'shorter than 4 bytes');
    assert.strictEqual(await nfcSerialFingerprint(null), null);
  });
});

describe('resolveCheckpoint', () => {
  it('resolves NFC serials regardless of case / separators', async () => {
    for (const raw of ['04:a2:3b:1c:5d:80:00', '04:A2:3B:1C:5D:80:00', '04A23B1C5D8000', '04-a2-3b-1c-5d-80-00']) {
      const r = await resolveCheckpoint({ method: 'nfc', raw }, checkpoints);
      assert.ok(r.ok, raw);
      assert.strictEqual(r.checkpoint.id, 'a');
      assert.strictEqual(r.payloadType, 'nfc_uid');
    }
  });

  it('reports unknown tags and never matches an NFC serial against QR tokens', async () => {
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'nfc', raw: '04:00:00:00:00:00:01' }, checkpoints), {
      ok: false,
      reason: 'unknown_tag'
    });
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'nfc', raw: '' }, checkpoints), { ok: false, reason: 'unknown_tag' });
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'nfc', raw: 'EE-CP-MAIN-GATE-01' }, checkpoints), {
      ok: false,
      reason: 'unknown_tag'
    });
  });

  it('never matches a checkpoint without an enrolled tag', async () => {
    const r = await resolveCheckpoint({ method: 'nfc', raw: '04:7a:b2:c1' }, [cp({ id: 'x' })]);
    assert.deepStrictEqual(r, { ok: false, reason: 'unknown_tag' });
  });

  it('resolves QR tokens by exact match only', async () => {
    const r = await resolveCheckpoint({ method: 'qr', raw: 'EE-CP-MAIN-GATE-01' }, checkpoints);
    assert.ok(r.ok);
    assert.strictEqual(r.checkpoint.id, 'b');
    assert.strictEqual(r.payloadType, 'secure_token');
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'qr', raw: 'https://x/?EE-CP-MAIN-GATE-01' }, checkpoints), {
      ok: false,
      reason: 'unknown_qr'
    });
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'qr', raw: 'EE-CP-0123456789ABCDEF0123456789ABCDEF' }, checkpoints), {
      ok: false,
      reason: 'unknown_qr'
    });
  });

  it('does not accept a QR code that encodes an NFC UID', async () => {
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'qr', raw: '04:a2:3b:1c:5d:80:00' }, checkpoints), {
      ok: false,
      reason: 'unknown_qr'
    });
  });

  it('resolves legacy PLAAS-CP cards by legacy code, case-insensitively, for any CP number', async () => {
    const r2 = await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP2' }, checkpoints);
    assert.ok(r2.ok);
    assert.strictEqual(r2.checkpoint.id, 'b');
    assert.strictEqual(r2.payloadType, 'legacy_qr');
    const r6 = await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP6' }, checkpoints);
    assert.ok(r6.ok);
    assert.strictEqual(r6.checkpoint.id, 'd');
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP9' }, checkpoints), {
      ok: false,
      reason: 'unknown_qr'
    });
  });

  it('refuses legacy cards on a site that switched them off (allow_legacy_qr = false)', async () => {
    assert.deepStrictEqual(await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP2' }, checkpoints, { allowLegacyQr: false }), {
      ok: false,
      reason: 'legacy_disabled'
    });
    const token = await resolveCheckpoint({ method: 'qr', raw: 'EE-CP-MAIN-GATE-01' }, checkpoints, { allowLegacyQr: false });
    assert.ok(token.ok, 'secure tokens are unaffected');
    assert.ok((await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP2' }, checkpoints, { allowLegacyQr: true })).ok);
  });

  it('reports inactive checkpoints for every method', async () => {
    for (const input of [
      { method: 'nfc' as const, raw: '04:99:88:77:66:55:44' },
      { method: 'qr' as const, raw: 'EE-CP-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { method: 'qr' as const, raw: 'PLAAS-CP:CP5' }
    ]) {
      const r = await resolveCheckpoint(input, checkpoints);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(!r.ok && r.reason, 'inactive');
      assert.strictEqual(!r.ok && r.reason === 'inactive' && r.checkpoint.id, 'c');
    }
  });

  it('prefers an active checkpoint when an inactive one carries the same legacy code', async () => {
    const list = [cp({ id: 'old', legacyCode: 'CP1', isActive: false }), cp({ id: 'new', legacyCode: 'CP1' })];
    const r = await resolveCheckpoint({ method: 'qr', raw: 'PLAAS-CP:CP1' }, list);
    assert.ok(r.ok);
    assert.strictEqual(r.checkpoint.id, 'new');
  });
});

// ---------------------------------------------------------------------------
// loadCheckpoints with a fake Supabase query builder and an in-memory cache
// ---------------------------------------------------------------------------

const row = (over: Partial<CheckpointRow>): CheckpointRow => ({
  id: 'r1',
  site_id: 'site-1',
  name: 'Main gate',
  description: null,
  qr_token_sha256: sha('EE-CP-3F2A9C0B7D5E41A8B6C9D0E1F2A3B4C5'),
  qr_token_strong: true,
  nfc_uid_sha256: sha('04:a2:3b:1c:5d:80:00'),
  latitude: -25.68412,
  longitude: '27.81452',
  permitted_radius_meters: 50,
  order_index: 1,
  is_active: true,
  deactivated_at: null,
  legacy_code: 'CP1',
  organisation_id: 'org-1',
  nfc_enrolled_at: '2026-09-30T10:00:00.000Z',
  nfc_enrolled_by: 'admin-1',
  ...over
});

/**
 * Fake PostgREST builder chain. `result: 'hang'` models a connected-but-dead link: the request
 * never answers, and (like a transport that ignores it) not even the abort signal settles it.
 */
function fakeSupabase(result: { data: CheckpointRow[] | null; error: { message: string } | null } | Error | 'hang') {
  const calls: Array<[string, ...unknown[]]> = [];
  const signals: AbortSignal[] = [];
  const builder = {
    select(cols: string) {
      calls.push(['select', cols]);
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.push(['eq', col, val]);
      return builder;
    },
    order(col: string, opts: unknown) {
      calls.push(['order', col, opts]);
      return builder;
    },
    abortSignal(signal: AbortSignal) {
      signals.push(signal);
      if (result === 'hang') return new Promise(() => undefined);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }
  };
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return builder;
    }
  };
  return { client: client as unknown as Pick<SupabaseClient, 'from'>, calls, signals };
}

function memoryCache(initial?: CheckpointCacheRecord): CheckpointCacheStore & { records: Map<string, CheckpointCacheRecord> } {
  const records = new Map<string, CheckpointCacheRecord>();
  if (initial) records.set(initial.siteId, initial);
  return {
    records,
    get: async (siteId: string) => records.get(siteId),
    put: async (record: CheckpointCacheRecord) => {
      records.set(record.siteId, record);
      return record.siteId;
    }
  };
}

describe('mapCheckpointRow', () => {
  it('maps columns, coerces numerics and keeps only fingerprints (no secrets)', () => {
    const m = mapCheckpointRow(row({}));
    assert.strictEqual(m.siteId, 'site-1');
    assert.strictEqual(m.nfcUidSha256, sha('04:a2:3b:1c:5d:80:00'));
    assert.strictEqual(m.qrTokenStrong, true);
    assert.strictEqual(m.longitude, 27.81452);
    assert.strictEqual(m.latitude, -25.68412);
    assert.strictEqual(m.legacyCode, 'CP1');
    assert.strictEqual(m.organisationId, 'org-1');
    assert.strictEqual(m.nfcEnrolledBy, 'admin-1');
    assert.strictEqual(m.description, undefined);
    assert.ok(!('qrCodeHash' in m) && !('nfcUid' in m));
    const noCoords = mapCheckpointRow(row({ latitude: null, longitude: null, nfc_uid_sha256: null, deactivated_at: '2026-09-30T11:00:00Z' }));
    assert.strictEqual(noCoords.latitude, undefined);
    assert.strictEqual(noCoords.nfcUidSha256, undefined);
    assert.strictEqual(noCoords.deactivatedAt, '2026-09-30T11:00:00Z');
  });

  it('never selects the secret columns (the database refuses them with 42501)', () => {
    const columns = CHECKPOINT_COLUMNS.split(',').map((column) => column.trim());
    assert.ok(!columns.includes('qr_code_hash'));
    assert.ok(!columns.includes('nfc_uid'));
    assert.ok(columns.includes('qr_token_sha256') && columns.includes('nfc_uid_sha256'));
  });
});

describe('loadCheckpoints', () => {
  const fixedNow = () => new Date('2026-09-30T18:00:00.000Z');

  it('queries explicit columns for the site, ordered, and refreshes the cache', async () => {
    const { client, calls, signals } = fakeSupabase({
      data: [row({}), row({ id: 'r2', order_index: 2, nfc_uid_sha256: null })],
      error: null
    });
    const cache = memoryCache();
    const result = await loadCheckpoints('site-1', { supabase: client, cache, isOnline: () => true, now: fixedNow });
    assert.strictEqual(signals.length, 1, 'the request is abortable');
    assert.strictEqual(signals[0].aborted, false);
    assert.strictEqual(result.source, 'network');
    assert.strictEqual(result.checkpoints.length, 2);
    assert.strictEqual(result.cachedAt, '2026-09-30T18:00:00.000Z');
    assert.deepStrictEqual(calls, [
      ['from', 'checkpoints'],
      ['select', CHECKPOINT_COLUMNS],
      ['eq', 'site_id', 'site-1'],
      ['order', 'order_index', { ascending: true }]
    ]);
    assert.ok(!CHECKPOINT_COLUMNS.includes('*'));
    assert.strictEqual(cache.records.get('site-1')?.checkpoints.length, 2);
  });

  it('uses the cache without touching the network when offline', async () => {
    const { client, calls } = fakeSupabase({ data: [], error: null });
    const cached: CheckpointCacheRecord = { siteId: 'site-1', checkpoints: [cp({ id: 'cached' })], cachedAt: '2026-09-29T08:00:00.000Z' };
    const result = await loadCheckpoints('site-1', { supabase: client, cache: memoryCache(cached), isOnline: () => false });
    assert.deepStrictEqual(result, { checkpoints: cached.checkpoints, source: 'cache', cachedAt: cached.cachedAt });
    assert.strictEqual(calls.length, 0);
  });

  it('falls back to the cache on a Supabase error or a network failure', async () => {
    const cached: CheckpointCacheRecord = { siteId: 'site-1', checkpoints: [cp({ id: 'cached' })], cachedAt: '2026-09-29T08:00:00.000Z' };
    const e1 = await loadCheckpoints('site-1', {
      supabase: fakeSupabase({ data: null, error: { message: 'JWT expired' } }).client,
      cache: memoryCache(cached),
      isOnline: () => true
    });
    assert.strictEqual(e1.source, 'cache');
    assert.strictEqual(e1.networkError, 'JWT expired');

    const e2 = await loadCheckpoints('site-1', {
      supabase: fakeSupabase(new TypeError('Failed to fetch')).client,
      cache: memoryCache(cached),
      isOnline: () => true
    });
    assert.strictEqual(e2.source, 'cache');
    assert.strictEqual(e2.networkError, 'Failed to fetch');
  });

  it('a request that never answers falls back to the cache within the timeout (review reproduction)', async () => {
    const cached: CheckpointCacheRecord = { siteId: 'site-1', checkpoints: [cp({ id: 'cached' })], cachedAt: '2026-09-29T08:00:00.000Z' };
    const hung = fakeSupabase('hang');
    const started = Date.now();
    const result = await loadCheckpoints('site-1', {
      supabase: hung.client,
      cache: memoryCache(cached),
      isOnline: () => true,
      timeoutMs: 50
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.source, 'cache');
    assert.deepStrictEqual(result.checkpoints, cached.checkpoints);
    assert.match(result.networkError ?? '', /timed out/);
    assert.ok(elapsed < 2000, `took ${elapsed} ms`);
    assert.strictEqual(hung.signals[0].aborted, true, 'the stalled request is aborted');
  });

  it('a timed-out request without a cache throws a typed error instead of hanging', async () => {
    await assert.rejects(
      loadCheckpoints('site-1', { supabase: fakeSupabase('hang').client, cache: memoryCache(), isOnline: () => true, timeoutMs: 20 }),
      (e: unknown) => e instanceof CheckpointLoadError && e.reason === 'network_error_no_cache' && /timed out/.test(e.message)
    );
  });

  it('throws a typed error (never fake data) when there is neither network nor cache', async () => {
    await assert.rejects(
      loadCheckpoints('site-1', { supabase: fakeSupabase({ data: [], error: null }).client, cache: memoryCache(), isOnline: () => false }),
      (e: unknown) => e instanceof CheckpointLoadError && e.reason === 'offline_no_cache'
    );
    await assert.rejects(
      loadCheckpoints('site-1', { supabase: fakeSupabase(new Error('boom')).client, cache: memoryCache(), isOnline: () => true }),
      (e: unknown) => e instanceof CheckpointLoadError && e.reason === 'network_error_no_cache'
    );
  });

  it('still returns fresh server data when writing the cache fails', async () => {
    const cache: CheckpointCacheStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error('QuotaExceededError');
      }
    };
    const result = await loadCheckpoints('site-1', {
      supabase: fakeSupabase({ data: [row({})], error: null }).client,
      cache,
      isOnline: () => true
    });
    assert.strictEqual(result.source, 'network');
    assert.strictEqual(result.checkpoints.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

function fakeRpc(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    rpc(fn: string, args: unknown) {
      calls.push([fn, args]);
      return Promise.resolve(result);
    }
  };
  return { client: client as unknown as Pick<SupabaseClient, 'rpc'>, calls };
}

describe('fetchCheckpointSecrets', () => {
  it('calls get_checkpoint_secrets for the site and maps the rows', async () => {
    const { client, calls } = fakeRpc({
      data: [{ checkpoint_id: 'c1', site_id: 's1', qr_token: 'EE-CP-00112233445566778899AABBCCDDEEFF', nfc_uid: null }],
      error: null
    });
    const secrets = await fetchCheckpointSecrets('s1', { supabase: client });
    assert.deepStrictEqual(calls, [['get_checkpoint_secrets', { p_site_id: 's1' }]]);
    assert.deepStrictEqual(secrets, [
      { checkpointId: 'c1', siteId: 's1', qrToken: 'EE-CP-00112233445566778899AABBCCDDEEFF', nfcUid: null }
    ]);
  });

  it('surfaces a refusal with its code instead of returning an empty list', async () => {
    const { client } = fakeRpc({ data: null, error: { message: 'Only an organisation admin can view…', code: '42501' } });
    await assert.rejects(fetchCheckpointSecrets(null, { supabase: client }), (e: unknown) => e instanceof CheckpointSecretsError && e.code === '42501');
  });
});

describe('classifyCheckpointWriteError', () => {
  it('maps the database rules to admin messages', () => {
    const cases: Array<[{ code: string; message: string }, string]> = [
      [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_checkpoints_org_nfc_uid"' }, 'duplicate_tag'],
      [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_checkpoints_site_legacy_code"' }, 'duplicate_legacy_code'],
      [{ code: '22023', message: 'Invalid NFC tag serial "zz": expected 4 to 10 hexadecimal bytes' }, 'invalid_tag_serial'],
      [{ code: '22023', message: 'Checkpoint QR token must be EE-CP- followed by 32 upper-case hex characters' }, 'invalid_token'],
      [{ code: '23001', message: 'update or delete on table "checkpoints" violates RESTRICT setting of foreign key constraint' }, 'in_use'],
      [{ code: '23503', message: 'Checkpoint site x does not exist' }, 'error'],
      [{ code: '42501', message: 'new row violates row-level security policy' }, 'not_allowed']
    ];
    for (const [error, problem] of cases) assert.strictEqual(classifyCheckpointWriteError(error).problem, problem, error.message);
    assert.match(classifyCheckpointWriteError({ code: 'XX000', message: 'boom' }).message, /boom/);
  });
});
