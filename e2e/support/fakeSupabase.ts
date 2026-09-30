/**
 * Client for the fake Supabase server's /__test control API (reset + seed, fixture data,
 * superuser / as-user SQL for assertions, request log, fault injection, recovery links).
 */
import { FAKE_SUPABASE_URL, TEST_CONTROL_HEADER, TEST_CONTROL_TOKEN } from '../../tests/e2e-support/constants';
import type { RecoveryLink } from '../../tests/e2e-support/fake-supabase/gotrue';
import type { E2EFixture } from '../../tests/e2e-support/fixture';
import { retryFetch } from '../../tests/e2e-support/netRetry';

export type { E2EFixture, E2EUser, E2EUserKey, E2ECheckpoint, E2ESite } from '../../tests/e2e-support/fixture';
export type { RecoveryLink } from '../../tests/e2e-support/fake-supabase/gotrue';

export interface FakeHealth {
  ok: boolean;
  service: string;
  migrations: string[];
  seeded: boolean;
  fixtureSeededAt: string | null;
  resets: number;
}

export interface LoggedRequest {
  seq: number;
  at: string;
  method: string;
  path: string;
  status: number;
  role: string;
  userId: string | null;
  durationMs: number;
  errorCode: string | null;
  fault: string | null;
}

export interface FaultRule {
  method?: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** RegExp source matched against path + query, e.g. '^/rest/v1/patrol_scans'. */
  path?: string;
  /** network_error: connection dropped before processing; lose_response: processed, answer dropped. */
  action: 'network_error' | 'lose_response' | 'status' | 'delay';
  status?: number;
  body?: unknown;
  delayMs?: number;
  times?: number;
}

export class SqlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null
  ) {
    super(`${code}: ${message}`);
  }
}

export class FakeSupabaseControl {
  constructor(readonly baseUrl: string = FAKE_SUPABASE_URL) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await retryFetch(`${this.baseUrl}/__test/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { [TEST_CONTROL_HEADER]: TEST_CONTROL_TOKEN, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: { code?: string; message?: string; hint?: string | null } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // not JSON
      }
      if (path === 'sql' && parsed.code) throw new SqlError(parsed.code, parsed.message ?? text, parsed.hint ?? null);
      throw new Error(`fake Supabase /__test/${path} → HTTP ${res.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  health(): Promise<FakeHealth> {
    return this.call<FakeHealth>('health');
  }

  /** Fresh database (all migrations) + the E2E fixture; clears Auth sessions, Storage, faults. */
  async reset(options: { seed?: boolean } = {}): Promise<E2EFixture> {
    return (await this.call<{ fixture: E2EFixture }>('reset', { body: { seed: options.seed !== false } })).fixture;
  }

  fixture(): Promise<E2EFixture> {
    return this.call<E2EFixture>('fixture');
  }

  /** Superuser SQL (bypasses RLS) — for assertions and test setup. */
  async sql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.call<{ rows: T[] }>('sql', { body: { sql, params } })).rows;
  }

  /** SQL executed exactly like a PostgREST request of that user (RLS applies). */
  async sqlAs<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.call<{ rows: T[] }>('sql', { body: { sql, params, as: { role: 'authenticated', userId } } })).rows;
  }

  /** Polls a superuser query until `accept(rows)` holds (e.g. until the phone's queue has synced). */
  async waitForRows<T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
    accept: (rows: T[]) => boolean,
    options: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<T[]> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    let rows: T[] = [];
    for (;;) {
      rows = await this.sql<T>(sql, params);
      if (accept(rows)) return rows;
      if (Date.now() > deadline) {
        throw new Error(`waitForRows timed out; last rows: ${JSON.stringify(rows).slice(0, 2000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
    }
  }

  async requests(since = 0): Promise<{ lastSeq: number; entries: LoggedRequest[] }> {
    return this.call('requests?since=' + since);
  }

  async lastSeq(): Promise<number> {
    return (await this.requests(Number.MAX_SAFE_INTEGER)).lastSeq;
  }

  async addFaults(rules: FaultRule[]): Promise<void> {
    await this.call('faults', { body: { rules } });
  }

  async clearFaults(): Promise<void> {
    await this.call('faults', { method: 'DELETE' });
  }

  /** Server unreachable (connections dropped) while the phone itself is "online". */
  async setOutage(on: boolean): Promise<void> {
    await this.call('outage', { body: { on } });
  }

  /** Password-reset mails the fake Auth server "sent" (PKCE code link and token-hash link). */
  async recoveries(): Promise<RecoveryLink[]> {
    return (await this.call<{ recoveries: RecoveryLink[] }>('recoveries')).recoveries;
  }

  async sessions(): Promise<Array<{ id: string; userId: string; revoked: boolean; createdAt: string }>> {
    return (await this.call<{ sessions: never[] }>('sessions')).sessions;
  }

  /** Shorter access tokens (seconds, >= 5) to exercise token refresh. */
  async setJwtExpiry(seconds: number): Promise<void> {
    await this.call('config', { body: { jwtExpirySeconds: seconds } });
  }

  async storageObjects(prefix = ''): Promise<Array<{ bucket: string; name: string; size: number; contentType: string; createdAt: string }>> {
    return (await this.call<{ objects: never[] }>('storage?prefix=' + encodeURIComponent(prefix))).objects;
  }

  async storageObject(bucket: string, name: string): Promise<Buffer> {
    const res = await retryFetch(
      `${this.baseUrl}/__test/storage/object?bucket=${encodeURIComponent(bucket)}&name=${encodeURIComponent(name)}`,
      { headers: { [TEST_CONTROL_HEADER]: TEST_CONTROL_TOKEN } }
    );
    if (!res.ok) throw new Error(`storage object ${bucket}/${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
