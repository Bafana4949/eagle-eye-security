/**
 * In-process Postgres (PGlite) harness for database, RLS and storage-policy tests.
 *
 * createTestDb() boots a fresh PGlite instance, loads a small Supabase platform shim
 * (roles anon / authenticated / service_role, auth.uid(), storage.objects, the
 * supabase_realtime publication, Supabase's default grants) and then applies every file
 * in supabase/migrations in lexical order - i.e. the exact SQL that ships.
 *
 * Statements are executed "as" a user the same way PostgREST / Storage do it: inside a
 * transaction with SET LOCAL ROLE and the request.jwt.* settings, so RLS policies,
 * SECURITY DEFINER helpers and triggers see a real auth.uid(). Everything is reset when
 * the transaction ends, and a failing statement rolls its transaction back.
 *
 * Kept generic on purpose: the E2E fake-Supabase server reuses it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
export const SEED_FILE = path.join(REPO_ROOT, 'supabase', 'seed.sql');
export const SHIM_FILE = path.join(HERE, 'supabase-shim.sql');

/** Session settings the shim establishes (a cloned instance starts a new session). */
const SESSION_SETUP = `SET search_path TO "$user", public, extensions;`;

export type DbRole = 'anon' | 'authenticated' | 'service_role';

export interface JwtClaims {
  /** auth.uid(); omitted for anon / service_role. */
  sub?: string | null;
  role: DbRole;
  email?: string | null;
  /** Any additional claims to expose through auth.jwt(). */
  [claim: string]: unknown;
}

export interface CreateTestDbOptions {
  /** Apply supabase/migrations/*.sql (default true). */
  migrations?: boolean;
  /** Only apply migrations whose file name sorts <= this name. */
  upTo?: string;
  /** Run supabase/seed.sql after the migrations (default false). */
  seed?: boolean;
}

export interface QueryOk<T> {
  ok: true;
  rows: T[];
  affectedRows: number;
}

export interface QueryFailed {
  ok: false;
  /** SQLSTATE, e.g. '42501' (insufficient privilege / RLS), '23505' (unique). */
  code: string;
  message: string;
  /** Postgres HINT (PostgREST passes it through as error.hint), e.g. 'device_clock_ahead'. */
  hint?: string;
}

export type QueryOutcome<T> = QueryOk<T> | QueryFailed;

/** Absolute paths of supabase/migrations/*.sql in lexical (= version) order. */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Executes a SQL file as the superuser; errors name the file. */
export async function runSqlFile(db: PGlite, file: string): Promise<void> {
  const sql = readFileSync(file, 'utf8');
  try {
    await db.exec(sql);
  } catch (error) {
    throw new Error(`Failed to execute ${path.basename(file)}: ${describeError(error).message}`, { cause: error });
  }
}

/** Applies the migrations (optionally only those up to `upTo`), returns the file names applied. */
export async function applyMigrations(db: PGlite, options: { upTo?: string } = {}): Promise<string[]> {
  const applied: string[] = [];
  for (const file of listMigrationFiles()) {
    const name = path.basename(file);
    if (options.upTo && name > options.upTo) break;
    await runSqlFile(db, file);
    applied.push(name);
  }
  return applied;
}

/** Fresh database: Supabase shim + all migrations (+ optional seed). Close it with db.close(). */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await runSqlFile(db, SHIM_FILE);
    if (options.migrations !== false) await applyMigrations(db, { upTo: options.upTo });
    if (options.seed) await runSqlFile(db, SEED_FILE);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

/** Independent copy of a prepared database (fast way to isolate a test). */
export async function cloneTestDb(db: PGlite): Promise<PGlite> {
  const copy = (await db.clone()) as PGlite;
  await copy.exec(SESSION_SETUP);
  return copy;
}

/**
 * Runs `fn` in one transaction as the given JWT identity (PostgREST semantics):
 * SET LOCAL ROLE + request.jwt.claims / request.jwt.claim.sub / .role / .email.
 */
export async function withClaims<T>(db: PGlite, claims: JwtClaims, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const { role } = claims;
  if (role !== 'anon' && role !== 'authenticated' && role !== 'service_role') {
    throw new Error(`Unsupported database role: ${String(role)}`);
  }
  const sub = claims.sub ?? '';
  const email = claims.email ?? '';
  const json = JSON.stringify({ ...claims, sub: claims.sub ?? undefined, email: claims.email ?? undefined });
  return db.transaction(async (tx) => {
    await tx.query(
      `SELECT set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', $3, true),
              set_config('request.jwt.claim.email', $4, true)`,
      [json, sub, role, email]
    );
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  });
}

/** Claims for a signed-in user (userId) or an anonymous caller (null). */
export function claimsFor(userId: string | null, extra: Partial<JwtClaims> = {}): JwtClaims {
  return userId ? { ...extra, sub: userId, role: 'authenticated' } : { ...extra, sub: null, role: 'anon' };
}

/** One statement as `userId` (authenticated) or as anon when null. Throws on SQL errors. */
export async function asUser<T = Record<string, unknown>>(
  db: PGlite,
  userId: string | null,
  sql: string,
  params: unknown[] = []
): Promise<Results<T>> {
  return withClaims(db, claimsFor(userId), (tx) => tx.query<T>(sql, params));
}

/** One statement as service_role (BYPASSRLS, auth.uid() IS NULL). */
export async function asServiceRole<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<Results<T>> {
  return withClaims(db, { role: 'service_role', sub: null }, (tx) => tx.query<T>(sql, params));
}

/** Like asUser but returns the outcome (including SQLSTATE) instead of throwing. */
export async function tryAsUser<T = Record<string, unknown>>(
  db: PGlite,
  userId: string | null,
  sql: string,
  params: unknown[] = []
): Promise<QueryOutcome<T>> {
  try {
    const result = await asUser<T>(db, userId, sql, params);
    return { ok: true, rows: result.rows, affectedRows: result.affectedRows ?? 0 };
  } catch (error) {
    const { code, message, hint } = describeError(error);
    return hint === undefined ? { ok: false, code, message } : { ok: false, code, message, hint };
  }
}

/** Superuser query (fixtures / verification), bypasses RLS entirely. */
export async function asSuperuser<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<Results<T>> {
  return db.query<T>(sql, params);
}

export function describeError(error: unknown): { code: string; message: string; hint?: string } {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown; hint?: unknown };
    const described: { code: string; message: string; hint?: string } = {
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
      message: typeof e.message === 'string' ? e.message : String(error)
    };
    if (typeof e.hint === 'string') described.hint = e.hint;
    return described;
  }
  return { code: 'UNKNOWN', message: String(error) };
}
