/**
 * TEST SUPPORT: the parts of supabase-js the production modules call, executed against the
 * PGlite database of ./harness.ts (real migrations, RLS, triggers, storage policies).
 *
 * Every request runs the way PostgREST / Supabase Storage run it: in its own transaction,
 * as the session user (SET LOCAL ROLE authenticated + request.jwt.* claims, see withClaims),
 * and results come back as JSON (timestamps as strings, like the REST API). Errors carry the
 * SQLSTATE in `code` and an HTTP-like `status`, so production error handling (sync engine
 * classification, identity loading) sees what it would see against a hosted project.
 *
 * Supported surface (what src/lib uses):
 *   auth.getSession / getUser / getClaims
 *   from(t).select(cols).eq/neq/is/in/gt/gte/lt/lte/order/limit/maybeSingle/single/abortSignal
 *   from(t).insert(rows) / upsert(rows, { onConflict, ignoreDuplicates }) [.select(cols)]
 *   from(t).update(values).<filters>[.select(cols)] / from(t).delete().<filters>
 *   rpc(fn, args)
 *   storage.from(bucket).upload(path, blob, { contentType, upsert }) / createSignedUrl(path, s)
 * It is not a PostgREST re-implementation: embedded resources, OR filters and the like are
 * deliberately unsupported (they throw) rather than approximated.
 */
import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withClaims } from './harness';

export interface PgError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

export interface PgResult<T = unknown> {
  data: T | null;
  error: PgError | null;
  status: number;
  count: null;
}

export interface StorageError {
  message: string;
  statusCode: string;
  error: string;
  /** HTTP status; absent when no response arrived (network failure). */
  status?: number;
}

/** A request the adapter saw (for assertions). */
export interface PgCall {
  kind: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'rpc' | 'upload' | 'signed_url';
  target: string;
}

type Filter = { sql: string; values: unknown[] };

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  const trimmed = name.trim();
  if (!IDENT.test(trimmed)) throw new Error(`pgSupabase: unsupported identifier "${name}"`);
  return `"${trimmed}"`;
}

function columnList(columns: string): string {
  const trimmed = columns.trim();
  if (trimmed === '*') return '*';
  return trimmed
    .split(',')
    .map((column) => ident(column))
    .join(', ');
}

/** PostgREST's HTTP status for a SQLSTATE (the subset the app can meet). */
export function httpStatusFor(code: string): number {
  if (code === '42501') return 403;
  if (code === '23505' || code === '23503' || code === '23001') return 409;
  if (code === '42P01' || code === '42883') return 404;
  if (/^(08|53|57|58|XX)/.test(code)) return 503;
  return 400;
}

function toPgError(error: unknown): PgError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  return {
    message: typeof e.message === 'string' ? e.message : String(error),
    code: typeof e.code === 'string' ? e.code : 'XX000',
    details: typeof e.detail === 'string' ? e.detail : null,
    hint: typeof e.hint === 'string' ? e.hint : null
  };
}

/** Builds `$n` placeholders while collecting values. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

abstract class Request<T> implements PromiseLike<PgResult<T>> {
  private settled: Promise<PgResult<T>> | null = null;

  protected constructor(protected readonly client: PgSupabase) {}

  protected abstract run(tx: Transaction): Promise<{ data: T | null; status: number }>;
  protected abstract describe(): PgCall;

  /** Accepted for API compatibility (the local database never hangs). */
  abortSignal(signal: AbortSignal): this {
    void signal;
    return this;
  }

  private execute(): Promise<PgResult<T>> {
    if (!this.settled) {
      this.settled = (async () => {
        this.client.calls.push(this.describe());
        const lost = this.client.takeLostResponse(this.describe());
        try {
          const { data, status } = await this.client.asSession((tx) => this.run(tx));
          if (lost) return { data: null, error: { ...lost }, status: 0, count: null };
          return { data, error: null, status, count: null };
        } catch (error) {
          const pgError = toPgError(error);
          return { data: null, error: pgError, status: httpStatusFor(pgError.code), count: null };
        }
      })();
    }
    return this.settled;
  }

  then<R1 = PgResult<T>, R2 = never>(
    onfulfilled?: ((value: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

abstract class FilteredRequest<T> extends Request<T> {
  protected filters: Array<(params: Params) => Filter['sql']> = [];
  protected orders: string[] = [];
  protected limitCount: number | null = null;
  protected returning: string | null = null;
  protected cardinality: 'many' | 'maybe_single' | 'single' = 'many';

  private op(column: string, operator: string, value: unknown): this {
    const col = ident(column);
    this.filters.push((params) => `${col} ${operator} ${params.add(value)}`);
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.op(column, '=', value);
  }
  neq(column: string, value: unknown): this {
    return this.op(column, '<>', value);
  }
  gt(column: string, value: unknown): this {
    return this.op(column, '>', value);
  }
  gte(column: string, value: unknown): this {
    return this.op(column, '>=', value);
  }
  lt(column: string, value: unknown): this {
    return this.op(column, '<', value);
  }
  lte(column: string, value: unknown): this {
    return this.op(column, '<=', value);
  }
  is(column: string, value: null | boolean): this {
    const col = ident(column);
    const keyword = value === null ? 'NULL' : value ? 'TRUE' : 'FALSE';
    this.filters.push(() => `${col} IS ${keyword}`);
    return this;
  }
  in(column: string, values: readonly unknown[]): this {
    const col = ident(column);
    this.filters.push((params) => (values.length === 0 ? 'false' : `${col} IN (${values.map((v) => params.add(v)).join(', ')})`));
    return this;
  }
  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    const direction = options.ascending === false ? 'DESC' : 'ASC';
    const nulls = options.nullsFirst === undefined ? '' : options.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
    this.orders.push(`${ident(column)} ${direction}${nulls}`);
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  select(columns = '*'): this {
    this.returning = columnList(columns);
    return this;
  }
  maybeSingle(): this {
    this.cardinality = 'maybe_single';
    return this;
  }
  single(): this {
    this.cardinality = 'single';
    return this;
  }

  protected where(params: Params): string {
    return this.filters.length === 0 ? '' : ` WHERE ${this.filters.map((f) => f(params)).join(' AND ')}`;
  }

  /** Applies maybeSingle()/single() like PostgREST (PGRST116 when the row count is wrong). */
  protected shape(rows: unknown[]): { data: unknown; status: number } {
    if (this.cardinality === 'many') return { data: rows, status: 200 };
    if (rows.length > 1 || (this.cardinality === 'single' && rows.length === 0)) {
      throw Object.assign(new Error(`JSON object requested, multiple (or no) rows returned (${rows.length})`), {
        code: 'PGRST116'
      });
    }
    return { data: rows[0] ?? null, status: 200 };
  }
}

async function jsonRows(tx: Transaction, sql: string, values: unknown[]): Promise<unknown[]> {
  const result = await tx.query<{ rows: unknown[] }>(
    `WITH q AS (${sql}) SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) AS rows FROM q`,
    values
  );
  return result.rows[0]?.rows ?? [];
}

class SelectRequest extends FilteredRequest<unknown> {
  constructor(
    client: PgSupabase,
    private readonly table: string,
    columns: string
  ) {
    super(client);
    this.returning = columnList(columns);
  }
  protected describe(): PgCall {
    return { kind: 'select', target: this.table };
  }
  protected async run(tx: Transaction) {
    const params = new Params();
    let sql = `SELECT ${this.returning ?? '*'} FROM public.${ident(this.table)}${this.where(params)}`;
    if (this.orders.length > 0) sql += ` ORDER BY ${this.orders.join(', ')}`;
    if (this.limitCount !== null) sql += ` LIMIT ${Math.max(0, Math.floor(this.limitCount))}`;
    return this.shape(await jsonRows(tx, sql, params.values));
  }
}

class UpdateRequest extends FilteredRequest<unknown> {
  constructor(
    client: PgSupabase,
    private readonly table: string,
    private readonly values: Record<string, unknown>
  ) {
    super(client);
  }
  protected describe(): PgCall {
    return { kind: 'update', target: this.table };
  }
  protected async run(tx: Transaction) {
    const params = new Params();
    const sets = Object.entries(this.values).map(([column, value]) => `${ident(column)} = ${params.add(value)}`);
    if (sets.length === 0) throw new Error('pgSupabase: update() without values');
    const sql = `UPDATE public.${ident(this.table)} SET ${sets.join(', ')}${this.where(params)}`;
    if (!this.returning) {
      await tx.query(sql, params.values);
      return { data: null, status: 204 };
    }
    return this.shape(await jsonRows(tx, `${sql} RETURNING ${this.returning}`, params.values));
  }
}

class DeleteRequest extends FilteredRequest<unknown> {
  constructor(
    client: PgSupabase,
    private readonly table: string
  ) {
    super(client);
  }
  protected describe(): PgCall {
    return { kind: 'delete', target: this.table };
  }
  protected async run(tx: Transaction) {
    const params = new Params();
    if (this.filters.length === 0) throw new Error('pgSupabase: delete() without a filter');
    const sql = `DELETE FROM public.${ident(this.table)}${this.where(params)}`;
    if (!this.returning) {
      await tx.query(sql, params.values);
      return { data: null, status: 204 };
    }
    return this.shape(await jsonRows(tx, `${sql} RETURNING ${this.returning}`, params.values));
  }
}

class InsertRequest extends FilteredRequest<unknown> {
  constructor(
    client: PgSupabase,
    private readonly table: string,
    private readonly rows: ReadonlyArray<Record<string, unknown>>,
    private readonly mode: { kind: 'insert' } | { kind: 'upsert'; onConflict: string; ignoreDuplicates: boolean }
  ) {
    super(client);
  }
  protected describe(): PgCall {
    return { kind: this.mode.kind, target: this.table };
  }
  protected async run(tx: Transaction) {
    const out: unknown[] = [];
    for (const row of this.rows) {
      const params = new Params();
      const columns = Object.keys(row);
      let sql = `INSERT INTO public.${ident(this.table)} (${columns.map(ident).join(', ')}) VALUES (${columns
        .map((column) => params.add(row[column]))
        .join(', ')})`;
      if (this.mode.kind === 'upsert') {
        const target = this.mode.onConflict.split(',').map(ident).join(', ');
        sql += this.mode.ignoreDuplicates
          ? ` ON CONFLICT (${target}) DO NOTHING`
          : ` ON CONFLICT (${target}) DO UPDATE SET ${columns.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
      }
      if (this.returning) out.push(...(await jsonRows(tx, `${sql} RETURNING ${this.returning}`, params.values)));
      else await tx.query(sql, params.values);
    }
    if (!this.returning) return { data: null, status: 201 };
    const shaped = this.shape(out);
    return { data: shaped.data, status: 201 };
  }
}

class RpcRequest extends Request<unknown> {
  constructor(
    client: PgSupabase,
    private readonly fn: string,
    private readonly args: Record<string, unknown>
  ) {
    super(client);
  }
  protected describe(): PgCall {
    return { kind: 'rpc', target: this.fn };
  }
  protected async run(tx: Transaction) {
    const params = new Params();
    const named = Object.entries(this.args).map(([name, value]) => `${ident(name)} => ${params.add(value)}`);
    const call = `public.${ident(this.fn)}(${named.join(', ')})`;
    const setReturning = await this.client.isSetReturning(this.fn, tx);
    if (setReturning) return { data: await jsonRows(tx, `SELECT * FROM ${call}`, params.values), status: 200 };
    const result = await tx.query<{ v: unknown }>(`SELECT to_json(${call}) AS v`, params.values);
    return { data: result.rows[0]?.v ?? null, status: 200 };
  }
}

class TableApi {
  constructor(
    private readonly client: PgSupabase,
    private readonly table: string
  ) {}
  select(columns = '*'): SelectRequest {
    return new SelectRequest(this.client, this.table, columns);
  }
  insert(rows: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>): InsertRequest {
    return new InsertRequest(this.client, this.table, Array.isArray(rows) ? rows : [rows as Record<string, unknown>], {
      kind: 'insert'
    });
  }
  upsert(
    rows: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>,
    options: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  ): InsertRequest {
    return new InsertRequest(this.client, this.table, Array.isArray(rows) ? rows : [rows as Record<string, unknown>], {
      kind: 'upsert',
      onConflict: options.onConflict ?? 'id',
      ignoreDuplicates: options.ignoreDuplicates === true
    });
  }
  update(values: Record<string, unknown>): UpdateRequest {
    return new UpdateRequest(this.client, this.table, values);
  }
  delete(): DeleteRequest {
    return new DeleteRequest(this.client, this.table);
  }
}

export interface LostResponse {
  match: (call: PgCall) => boolean;
  remaining: number;
}

/** A network error the caller sees although the server applied the request (response lost). */
export const LOST_RESPONSE_ERROR: PgError = { message: 'TypeError: fetch failed', code: '', details: null, hint: null };

export class PgSupabase {
  readonly calls: PgCall[] = [];
  private readonly lost: LostResponse[] = [];
  private readonly setReturning = new Map<string, boolean>();

  constructor(
    readonly db: PGlite,
    public session: { userId: string; email?: string | null } | null
  ) {}

  /** Runs `fn` in one transaction as the session user (anon when signed out). */
  asSession<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const claims = this.session
      ? { sub: this.session.userId, role: 'authenticated' as const, email: this.session.email ?? null }
      : { sub: null, role: 'anon' as const };
    return withClaims(this.db, claims, fn);
  }

  /** The next `times` matching requests are applied but answered with a network error. */
  loseResponses(match: (call: PgCall) => boolean, times = 1): void {
    this.lost.push({ match, remaining: times });
  }

  /** Lost responses scripted with loseResponses() that no request has consumed yet. */
  get unconsumedLostResponses(): number {
    return this.lost.reduce((total, entry) => total + entry.remaining, 0);
  }

  takeLostResponse(call: PgCall): PgError | null {
    const entry = this.lost.find((candidate) => candidate.remaining > 0 && candidate.match(call));
    if (!entry) return null;
    entry.remaining -= 1;
    return LOST_RESPONSE_ERROR;
  }

  /** Must run on the request's own transaction: PGlite serialises queries, so db.query here would deadlock. */
  async isSetReturning(fn: string, tx: Transaction): Promise<boolean> {
    const cached = this.setReturning.get(fn);
    if (cached !== undefined) return cached;
    const result = await tx.query<{ retset: boolean }>(
      `SELECT bool_or(p.proretset) AS retset FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1`,
      [fn]
    );
    const value = result.rows[0]?.retset === true;
    this.setReturning.set(fn, value);
    return value;
  }

  readonly auth = {
    getSession: async () => ({
      data: {
        session: this.session
          ? { access_token: 'pglite-test-token', user: { id: this.session.userId, email: this.session.email ?? null } }
          : null
      },
      error: null
    }),
    getUser: async () => ({
      data: { user: this.session ? { id: this.session.userId, email: this.session.email ?? null } : null },
      error: null
    }),
    getClaims: async () => ({
      data: this.session ? { claims: { sub: this.session.userId, role: 'authenticated' } } : null,
      error: null
    })
  };

  from(table: string): TableApi {
    return new TableApi(this, table);
  }

  rpc(fn: string, args: Record<string, unknown> = {}): RpcRequest {
    return new RpcRequest(this, fn, args);
  }

  readonly storage = {
    from: (bucket: string) => ({
      upload: async (
        path: string,
        body: Blob,
        options: { contentType?: string; upsert?: boolean; cacheControl?: string } = {}
      ): Promise<{ data: { path: string } | null; error: StorageError | null }> => {
        const call: PgCall = { kind: 'upload', target: `${bucket}/${path}` };
        this.calls.push(call);
        const lost = this.takeLostResponse(call);
        const contentType = options.contentType ?? body.type ?? 'application/octet-stream';
        // Bucket limits are enforced by the Storage API (not by RLS); mirror them.
        const config = await this.db.query<{ file_size_limit: number | null; allowed_mime_types: string[] | null }>(
          `SELECT file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1`,
          [bucket]
        );
        const bucketRow = config.rows[0];
        if (!bucketRow) return { data: null, error: storageError('Bucket not found', '404', 'Bucket not found', 404) };
        if (bucketRow.file_size_limit !== null && body.size > Number(bucketRow.file_size_limit)) {
          return { data: null, error: storageError('The object exceeded the maximum allowed size', '413', 'Payload too large', 413) };
        }
        if (bucketRow.allowed_mime_types && !bucketRow.allowed_mime_types.includes(contentType)) {
          return { data: null, error: storageError(`mime type ${contentType} is not supported`, '415', 'invalid_mime_type', 415) };
        }
        try {
          await this.asSession((tx) =>
            tx.query(
              `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
               VALUES ($1, $2, auth.uid(), auth.uid()::text, jsonb_build_object('mimetype', $3::text, 'size', $4::bigint))`,
              [bucket, path, contentType, body.size]
            )
          );
        } catch (error) {
          const pgError = toPgError(error);
          if (pgError.code === '23505') {
            return { data: null, error: storageError('The resource already exists', '409', 'Duplicate', 409) };
          }
          if (pgError.code === '42501') {
            return { data: null, error: storageError(pgError.message, '403', 'Unauthorized', 403) };
          }
          return { data: null, error: storageError(pgError.message, '400', pgError.code, 400) };
        }
        if (lost) return { data: null, error: { message: lost.message, statusCode: '', error: 'StorageUnknownError' } };
        return { data: { path }, error: null };
      },
      createSignedUrl: async (
        path: string,
        expiresIn: number
      ): Promise<{ data: { signedUrl: string } | null; error: StorageError | null }> => {
        this.calls.push({ kind: 'signed_url', target: `${bucket}/${path}` });
        const visible = await this.asSession((tx) =>
          tx.query(`SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [bucket, path])
        );
        if (visible.rows.length === 0) {
          return { data: null, error: storageError('Object not found', '404', 'not_found', 400) };
        }
        return { data: { signedUrl: `https://storage.pglite.test/${bucket}/${path}?expires=${expiresIn}` }, error: null };
      }
    })
  };

  /** Typed as the real client for production functions that take one. */
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

function storageError(message: string, statusCode: string, error: string, status: number): StorageError {
  return { message, statusCode, error, status };
}
