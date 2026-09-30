/**
 * TEST SUPPORT ONLY (imported by *.test.ts, never by app code).
 *
 * In-memory stand-in for the parts of supabase-js the sync engine and shift store use:
 * auth.getSession, from(table).upsert / insert / update().eq().is().select() /
 * select().eq().order().limit().maybeSingle(), storage.from(bucket).upload.
 * It keeps server-side state (tables, stored objects) so idempotency is observable, records
 * every call, and can be scripted to fail — either before applying an operation (rejection /
 * outage) or after applying it (response lost on the way back) — or to hang until released
 * (a request that never answers).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface RecordedCall {
  kind: 'upload' | 'upsert' | 'insert' | 'update' | 'select';
  table?: string;
  bucket?: string;
  path?: string;
  row?: Row;
  values?: Row;
  options?: Record<string, unknown>;
  filters?: Array<{ op: 'eq' | 'is'; column: string; value: unknown }>;
}

export interface FakeError {
  message: string;
  code?: string;
  status?: number;
  statusCode?: string;
  error?: string;
}

interface Script {
  match: (call: RecordedCall) => boolean;
  error: FakeError;
  status: number;
  /** 'before': operation not applied. 'after': applied, but the caller gets the error (lost response). */
  when: 'before' | 'after';
  remaining: number;
}

export const NETWORK_ERROR: FakeError = { message: 'TypeError: fetch failed' };
export const RLS_ERROR: FakeError = { message: 'new row violates row-level security policy', code: '42501' };

type Result = { data: unknown; error: FakeError | null; status: number };

interface Hold {
  match: (call: RecordedCall) => boolean;
  remaining: number;
  gate: Promise<void>;
  onHeld: () => void;
}

export interface HeldCalls {
  /** Resolves when the first matching call is being held. */
  reached: Promise<void>;
  /** Lets the held calls (and later matching ones) proceed. */
  release(): void;
}

class FilterBuilder implements PromiseLike<Result> {
  private filters: Array<{ op: 'eq' | 'is'; column: string; value: unknown }> = [];
  private selectColumns: string | null = null;
  private single = false;
  private limitCount: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly fake: FakeSupabase,
    private readonly table: string,
    private readonly kind: 'update' | 'select',
    private readonly values: Row | null
  ) {
    if (kind === 'select') this.selectColumns = '*';
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  select(columns = '*'): this {
    this.selectColumns = columns;
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderBy = { column, ascending: options.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private async execute(): Promise<Result> {
    const call: RecordedCall = {
      kind: this.kind,
      table: this.table,
      values: this.values ?? undefined,
      filters: [...this.filters]
    };
    this.fake.calls.push(call);
    await this.fake.passHolds(call);
    const before = this.fake.takeScript(call, 'before');
    if (before) return { data: null, error: before.error, status: before.status };

    const rows = [...this.fake.table(this.table).values()].filter((row) =>
      this.filters.every((filter) =>
        filter.op === 'eq' ? row[filter.column] === filter.value : (row[filter.column] ?? null) === filter.value
      )
    );
    if (this.kind === 'update' && this.values) {
      rows.forEach((row) => Object.assign(row, this.values));
    }
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    const limited = this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    const project = (row: Row): Row => {
      if (!this.selectColumns || this.selectColumns === '*') return { ...row };
      return Object.fromEntries(
        this.selectColumns.split(',').map((column) => [column.trim(), row[column.trim()] ?? null])
      );
    };
    let data: unknown = null;
    if (this.selectColumns) data = this.single ? (limited[0] ? project(limited[0]) : null) : limited.map(project);

    const after = this.fake.takeScript(call, 'after');
    if (after) return { data: null, error: after.error, status: after.status };
    return { data, error: null, status: 200 };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}

class TableApi {
  constructor(
    private readonly fake: FakeSupabase,
    private readonly name: string
  ) {}

  upsert(row: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}): PromiseLike<Result> {
    return this.write('upsert', row, options);
  }

  insert(row: Row): PromiseLike<Result> {
    return this.write('insert', row, {});
  }

  update(values: Row): FilterBuilder {
    return new FilterBuilder(this.fake, this.name, 'update', values);
  }

  select(columns = '*'): FilterBuilder {
    return new FilterBuilder(this.fake, this.name, 'select', null).select(columns);
  }

  private async write(
    kind: 'upsert' | 'insert',
    row: Row,
    options: { onConflict?: string; ignoreDuplicates?: boolean }
  ): Promise<Result> {
    await Promise.resolve();
    const call: RecordedCall = { kind, table: this.name, row: { ...row }, options: { ...options } };
    this.fake.calls.push(call);
    await this.fake.passHolds(call);
    const before = this.fake.takeScript(call, 'before');
    if (before) return { data: null, error: before.error, status: before.status };

    const table = this.fake.table(this.name);
    const conflictColumn = options.onConflict ?? 'id';
    const existing = [...table.values()].find((candidate) => candidate[conflictColumn] === row[conflictColumn]);
    if (existing) {
      if (kind === 'insert') {
        return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' }, status: 409 };
      }
      if (!options.ignoreDuplicates) Object.assign(existing, row);
    } else {
      const id = typeof row.id === 'string' ? row.id : `${this.name}-${table.size + 1}`;
      table.set(id, { ...row, id });
    }
    const after = this.fake.takeScript(call, 'after');
    if (after) return { data: null, error: after.error, status: after.status };
    return { data: null, error: null, status: 201 };
  }
}

export class FakeSupabase {
  sessionUserId: string | null;
  sessionError: unknown = null;
  readonly calls: RecordedCall[] = [];
  readonly objects = new Map<string, { blob: Blob; contentType?: string }>();
  private readonly tables = new Map<string, Map<string, Row>>();
  private scripts: Script[] = [];
  private holds: Hold[] = [];

  constructor(sessionUserId: string | null) {
    this.sessionUserId = sessionUserId;
  }

  table(name: string): Map<string, Row> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  rows(name: string): Row[] {
    return [...this.table(name).values()];
  }

  /** Fail the next `times` calls matching `match` (default: before applying = rejected / unreachable). */
  failWhen(
    match: (call: RecordedCall) => boolean,
    error: FakeError,
    options: { status?: number; times?: number; when?: 'before' | 'after' } = {}
  ): void {
    this.scripts.push({
      match,
      error,
      status: options.status ?? (error === NETWORK_ERROR ? 0 : 403),
      when: options.when ?? 'before',
      remaining: options.times ?? 1
    });
  }

  /** The next `times` calls matching `match` hang until release() (never released = no answer, ever). */
  holdWhen(match: (call: RecordedCall) => boolean, options: { times?: number } = {}): HeldCalls {
    let release: () => void = () => undefined;
    let onHeld: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      onHeld = resolve;
    });
    this.holds.push({ match, remaining: options.times ?? 1, gate, onHeld });
    return { reached, release };
  }

  async passHolds(call: RecordedCall): Promise<void> {
    const hold = this.holds.find((candidate) => candidate.remaining > 0 && candidate.match(call));
    if (!hold) return;
    hold.remaining -= 1;
    hold.onHeld();
    await hold.gate;
  }

  takeScript(call: RecordedCall, when: 'before' | 'after'): Script | null {
    const script = this.scripts.find((candidate) => candidate.when === when && candidate.remaining > 0 && candidate.match(call));
    if (!script) return null;
    script.remaining -= 1;
    return script;
  }

  callsOf(kind: RecordedCall['kind'], table?: string): RecordedCall[] {
    return this.calls.filter((call) => call.kind === kind && (table === undefined || call.table === table));
  }

  readonly auth = {
    getSession: async () => ({
      data: { session: this.sessionUserId ? { user: { id: this.sessionUserId } } : null },
      error: this.sessionError
    })
  };

  readonly storage = {
    from: (bucket: string) => ({
      upload: async (path: string, blob: Blob, options: Record<string, unknown> = {}) => {
        const call: RecordedCall = { kind: 'upload', bucket, path, options: { ...options } };
        this.calls.push(call);
        await this.passHolds(call);
        const before = this.takeScript(call, 'before');
        if (before) return { data: null, error: { ...before.error, status: before.status || undefined } };
        if (this.objects.has(`${bucket}/${path}`)) {
          // What Supabase Storage returns for an existing object when upsert is false.
          return {
            data: null,
            error: { message: 'The resource already exists', statusCode: '409', error: 'Duplicate', status: 400 }
          };
        }
        this.objects.set(`${bucket}/${path}`, { blob, contentType: options.contentType as string | undefined });
        const after = this.takeScript(call, 'after');
        if (after) return { data: null, error: { ...after.error, status: after.status || undefined } };
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path: string, expiresIn: number) => {
        this.calls.push({ kind: 'select', bucket, path, options: { expiresIn } });
        if (!this.objects.has(`${bucket}/${path}`)) {
          return { data: null, error: { message: 'Object not found', statusCode: '404' } };
        }
        return { data: { signedUrl: `https://storage.test/${bucket}/${path}?token=signed&expires=${expiresIn}` }, error: null };
      }
    })
  };

  from(table: string): TableApi {
    return new TableApi(this, table);
  }

  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}
