/**
 * E2E TEST SUPPORT ONLY: a PostgREST (v12-style) subset on top of the PGlite database.
 *
 * Each request is one transaction as the caller (SET LOCAL ROLE anon | authenticated |
 * service_role + request.jwt.claims), so RLS policies, column privileges, SECURITY DEFINER
 * helpers and triggers behave as on a hosted project. Supported:
 *   GET/HEAD  /rest/v1/<table>?select=...&<filters>&order=&limit=&offset=   (embedded resources,
 *             aliases, casts, JSON paths, or/and/not logic trees, per-embed filters/order/limit,
 *             !inner, Prefer: count=exact, Accept: application/vnd.pgrst.object+json)
 *   POST      insert / upsert (on_conflict, resolution=ignore|merge-duplicates, columns=,
 *             missing=default, return=representation|minimal)
 *   PATCH / DELETE with filters (pg-safeupdate: a filter is required, as on Supabase)
 *   POST/GET  /rest/v1/rpc/<fn> (named arguments, set-returning functions with filters)
 * Errors are PostgREST-shaped ({ code, message, details, hint }) with PostgREST's HTTP statuses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Transaction } from '@electric-sql/pglite';
import { HttpError, header, parseJsonBody, send } from './http';
import {
  checkedTypeName,
  columnExpr,
  conditionColumns,
  conditionSql,
  orderSql,
  parseModifiers,
  parseSelect,
  pgrstError,
  quoteIdent,
  type EmbedItem,
  type LevelModifiers,
  type SelectItem
} from './pgrstQuery';
import type { ForeignKeyInfo, FunctionInfo, RelationInfo } from './schema';
import type { Caller, FakeSupabaseState } from './state';

interface ResolvedEmbed {
  name: string;
  item: EmbedItem;
  level: Level;
  kind: 'many_to_one' | 'one_to_many';
  fk: ForeignKeyInfo;
}

interface Level {
  /** null for RPC result sets (no catalog relation). */
  relation: RelationInfo | null;
  alias: string;
  items: SelectItem[];
  embeds: Map<EmbedItem, ResolvedEmbed>;
  mods: LevelModifiers;
}

interface RestResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

interface Prefer {
  return: 'representation' | 'minimal' | 'headers-only' | null;
  count: 'exact' | 'planned' | 'estimated' | null;
  resolution: 'ignore-duplicates' | 'merge-duplicates' | null;
  missingDefault: boolean;
}

function parsePrefer(req: IncomingMessage): Prefer {
  const prefer: Prefer = { return: null, count: null, resolution: null, missingDefault: false };
  const raw = header(req, 'prefer');
  if (!raw) return prefer;
  for (const part of raw.split(',')) {
    const [key, value] = part.trim().split('=').map((s) => s.trim());
    if (key === 'return' && (value === 'representation' || value === 'minimal' || value === 'headers-only')) prefer.return = value;
    else if (key === 'count' && (value === 'exact' || value === 'planned' || value === 'estimated')) prefer.count = value;
    else if (key === 'resolution' && (value === 'ignore-duplicates' || value === 'merge-duplicates')) prefer.resolution = value;
    else if (key === 'missing' && value === 'default') prefer.missingDefault = true;
  }
  return prefer;
}

/** PostgREST's SQLSTATE → HTTP status table (src/PostgREST/Error.hs). */
export function pgHttpStatus(code: string, authenticated: boolean, isRpc: boolean): number {
  if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
  if (code === '42501') return authenticated ? 403 : 401;
  if (code === '23503' || code === '23505') return 409;
  if (code === '25006') return 405;
  if (code === '42883') return isRpc ? 404 : 500;
  if (code === '42P01') return 404;
  if (code === '42P17') return 500;
  if (code === 'P0001') return 400;
  if (code === '53400' || code === '57P01') return code === '57P01' ? 503 : 500;
  const prefix = code.slice(0, 2);
  if (prefix === '08' || prefix === '53') return 503;
  if (['09', '25', '2D', '38', '39', '3B', '40', '54', '55', '57', '58', 'F0', 'HV', 'P0', 'XX'].includes(prefix)) return 500;
  if (prefix === '0L' || prefix === '0P' || prefix === '28') return 403;
  return 400;
}

function toHttpError(error: unknown, caller: Caller, isRpc: boolean): HttpError {
  if (error instanceof HttpError) return error;
  const e = (error ?? {}) as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown };
  const code = typeof e.code === 'string' && e.code ? e.code : 'XX000';
  const body = {
    code,
    message: typeof e.message === 'string' ? e.message : String(error),
    details: typeof e.detail === 'string' ? e.detail : null,
    hint: typeof e.hint === 'string' ? e.hint : null
  };
  return new HttpError(pgHttpStatus(code, caller.role !== 'anon', isRpc), body);
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[key] = stripNulls(v);
    }
    return out;
  }
  return value;
}

class AliasCounter {
  private n = 0;
  next(): string {
    const alias = `pgrst_${this.n}`;
    this.n += 1;
    return alias;
  }
}

function embedName(item: EmbedItem): string {
  return item.alias ?? item.relation;
}

function missingColumn(relation: RelationInfo, column: string): HttpError {
  return pgrstError(400, '42703', `column ${relation.name}.${column} does not exist`);
}

export class PostgrestHandler {
  constructor(private readonly state: FakeSupabaseState) {}

  private relation(name: string): RelationInfo {
    const relation = this.state.schema.relations.get(name);
    if (!relation) {
      throw pgrstError(404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`);
    }
    return relation;
  }

  private resolveRelationship(parent: RelationInfo, item: EmbedItem): { kind: ResolvedEmbed['kind']; fk: ForeignKeyInfo; target: RelationInfo } {
    const fks = this.state.schema.foreignKeys;
    type Candidate = { kind: ResolvedEmbed['kind']; fk: ForeignKeyInfo; target: string };
    let candidates: Candidate[] = [];
    if (this.state.schema.relations.has(item.relation)) {
      for (const fk of fks) {
        if (fk.table === parent.name && fk.refTable === item.relation) candidates.push({ kind: 'many_to_one', fk, target: fk.refTable });
        if (fk.table === item.relation && fk.refTable === parent.name) candidates.push({ kind: 'one_to_many', fk, target: fk.table });
      }
    } else {
      // Embedding by foreign-key column or constraint name: select=guard:guard_id(first_name)
      for (const fk of fks) {
        if (fk.table === parent.name && (fk.name === item.relation || (fk.columns.length === 1 && fk.columns[0] === item.relation))) {
          candidates.push({ kind: 'many_to_one', fk, target: fk.refTable });
        }
      }
    }
    for (const hint of item.hints) {
      candidates = candidates.filter(
        (c) => c.fk.name === hint || c.fk.columns.includes(hint) || (c.kind === 'one_to_many' && c.fk.refColumns.includes(hint))
      );
    }
    if (candidates.length === 0) {
      throw pgrstError(
        400,
        'PGRST200',
        `Could not find a relationship between '${parent.name}' and '${item.relation}' in the schema cache`,
        `Searched for a foreign key relationship between '${parent.name}' and '${item.relation}'${item.hints.length ? ` using the hint '${item.hints.join('!')}'` : ''} in the schema 'public', but no matches were found.`
      );
    }
    if (candidates.length > 1) {
      throw pgrstError(
        300,
        'PGRST201',
        `Could not embed because more than one relationship was found for '${parent.name}' and '${item.relation}'`,
        candidates.map((c) => `${c.kind} via ${c.fk.name} (${c.fk.table}(${c.fk.columns.join(',')}))`).join('; '),
        `Try changing '${item.relation}' to one of the following: ${candidates.map((c) => `'${item.relation}!${c.fk.name}'`).join(', ')}. Find the desired relationship in the 'details' key.`
      );
    }
    const chosen = candidates[0];
    return { kind: chosen.kind, fk: chosen.fk, target: this.relation(chosen.target) };
  }

  /** Select tree + modifiers grouped by embed path → levels with SQL aliases. */
  private buildLevel(
    relation: RelationInfo | null,
    items: SelectItem[],
    modifiers: Map<string, LevelModifiers>,
    path: string,
    aliases: AliasCounter,
    usedPaths: Set<string>
  ): Level {
    usedPaths.add(path);
    const mods = modifiers.get(path) ?? { conditions: [], order: [], limit: null, offset: null };
    const level: Level = { relation, alias: aliases.next(), items, embeds: new Map(), mods };
    if (relation) {
      for (const item of items) {
        if (item.kind === 'field' && !relation.columns.has(item.column)) throw missingColumn(relation, item.column);
      }
      for (const condition of mods.conditions) {
        for (const column of conditionColumns(condition)) if (!relation.columns.has(column)) throw missingColumn(relation, column);
      }
      for (const term of mods.order) if (!relation.columns.has(term.column)) throw missingColumn(relation, term.column);
    }
    for (const item of items) {
      if (item.kind !== 'embed') continue;
      if (!relation) throw pgrstError(400, 'PGRST200', 'Embedding is not supported on function results by the E2E fake server');
      const resolved = this.resolveRelationship(relation, item);
      const name = embedName(item);
      const childPath = path ? `${path}.${name}` : name;
      const child = this.buildLevel(resolved.target, item.items, modifiers, childPath, aliases, usedPaths);
      level.embeds.set(item, { name, item, level: child, kind: resolved.kind, fk: resolved.fk });
    }
    return level;
  }

  private buildTree(relation: RelationInfo | null, select: string | null, modifiers: Map<string, LevelModifiers>): Level {
    const usedPaths = new Set<string>();
    const root = this.buildLevel(relation, parseSelect(select), modifiers, '', new AliasCounter(), usedPaths);
    for (const path of modifiers.keys()) {
      if (!usedPaths.has(path)) {
        throw pgrstError(400, 'PGRST108', `'${path}' is not an embedded resource in this request`, null, `Verify that '${path}' is included in the 'select' query parameter.`);
      }
    }
    return root;
  }

  private embedExpr(parent: Level, embed: ResolvedEmbed): string {
    const child = embed.level;
    const { fk } = embed;
    const joins =
      embed.kind === 'many_to_one'
        ? fk.columns.map((c, i) => `${child.alias}.${quoteIdent(fk.refColumns[i])} = ${parent.alias}.${quoteIdent(c)}`)
        : fk.columns.map((c, i) => `${child.alias}.${quoteIdent(c)} = ${parent.alias}.${quoteIdent(fk.refColumns[i])}`);
    const inner = this.levelQuery(child, `public.${quoteIdent(child.relation!.name)} AS ${child.alias}`, joins, true);
    return embed.kind === 'many_to_one'
      ? `(SELECT row_to_json(pgrst_e) FROM (${inner}) pgrst_e LIMIT 1)`
      : `(SELECT coalesce(json_agg(pgrst_e), '[]'::json) FROM (${inner}) pgrst_e)`;
  }

  private selectList(level: Level): string {
    const parts: string[] = [];
    for (const item of level.items) {
      if (item.kind === 'star') {
        parts.push(`${level.alias}.*`);
      } else if (item.kind === 'field') {
        let expr = columnExpr(level.alias, item.column, item.json);
        if (item.cast) expr = `(${expr})::${checkedTypeName(item.cast)}`;
        const name = item.alias ?? (item.json.length > 0 ? item.json[item.json.length - 1].key : item.column);
        parts.push(`${expr} AS ${quoteIdent(name)}`);
      } else {
        const embed = level.embeds.get(item)!;
        parts.push(`${this.embedExpr(level, embed)} AS ${quoteIdent(embed.name)}`);
      }
    }
    return parts.join(', ');
  }

  private whereClauses(level: Level, extra: string[]): string[] {
    const where = [...extra, ...level.mods.conditions.map((c) => conditionSql(c, level.alias))];
    for (const embed of level.embeds.values()) {
      if (!embed.item.inner) continue;
      const expr = this.embedExpr(level, embed);
      where.push(embed.kind === 'many_to_one' ? `${expr} IS NOT NULL` : `json_array_length(${expr}) > 0`);
    }
    return where;
  }

  private levelQuery(level: Level, from: string, extraWhere: string[], paginate: boolean): string {
    const where = this.whereClauses(level, extraWhere);
    let sql = `SELECT ${this.selectList(level)} FROM ${from}`;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += orderSql(level.mods.order, level.alias);
    if (paginate && level.mods.limit !== null) sql += ` LIMIT ${level.mods.limit}`;
    if (paginate && level.mods.offset !== null) sql += ` OFFSET ${level.mods.offset}`;
    return sql;
  }

  private countQuery(level: Level, from: string): string {
    const where = this.whereClauses(level, []);
    return `SELECT count(*)::bigint AS n FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  }

  // ------------------------------------------------------------------ entry point

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, subpath: string, caller: Caller, body: Buffer): Promise<void> {
    const method = req.method ?? 'GET';
    const profile = header(req, method === 'GET' || method === 'HEAD' ? 'accept-profile' : 'content-profile');
    if (profile && profile !== 'public') {
      throw pgrstError(406, 'PGRST106', 'The schema must be one of the following: public');
    }
    if (subpath === '' && (method === 'GET' || method === 'HEAD')) {
      return send(req, res, 200, { swagger: '2.0', info: { title: 'E2E fake PostgREST' }, paths: {} });
    }
    const accept = header(req, 'accept') ?? '';
    const wantsObject = accept.includes('application/vnd.pgrst.object+json');
    const nullsStripped = accept.includes('nulls=stripped');
    const prefer = parsePrefer(req);
    const requestInfo = {
      method,
      path: url.pathname,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'apikey').map(([k, v]) => [k, String(v)]))
    };

    const rpc = /^rpc\/([^/]+)$/.exec(subpath);
    const isRpc = Boolean(rpc);
    let result: RestResult;
    try {
      result = await this.state.runAs(caller, requestInfo, async (tx): Promise<RestResult> => {
        if (rpc) return this.rpc(tx, decodeURIComponent(rpc[1]), method, url, body, prefer, wantsObject);
        if (subpath.includes('/')) throw pgrstError(404, 'PGRST125', `Invalid path specified in request URL: /rest/v1/${subpath}`);
        const relation = this.relation(decodeURIComponent(subpath));
        if (method === 'GET' || method === 'HEAD') return this.read(tx, relation, url, prefer, wantsObject);
        if (method === 'POST') return this.insert(tx, relation, url, body, prefer, wantsObject);
        if (method === 'PATCH') return this.update(tx, relation, url, body, prefer, wantsObject);
        if (method === 'DELETE') return this.remove(tx, relation, url, prefer, wantsObject);
        throw pgrstError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
      });
    } catch (error) {
      throw toHttpError(error, caller, isRpc);
    }
    const payload = nullsStripped && result.body !== undefined && result.body !== null ? stripNulls(result.body) : result.body;
    if (result.status === 204 || payload === undefined) return send(req, res, result.status, null, result.headers);
    // A scalar function that returned NULL: PostgREST answers the JSON literal `null`.
    return send(req, res, result.status, payload === null ? 'null' : payload, {
      'Content-Type': wantsObject ? 'application/vnd.pgrst.object+json; charset=utf-8' : 'application/json; charset=utf-8',
      ...result.headers
    });
  }

  private singleOrThrow(rows: unknown[], wantsObject: boolean): unknown {
    if (!wantsObject) return rows;
    if (rows.length !== 1) {
      throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`);
    }
    return rows[0];
  }

  private contentRange(offset: number, rows: number, total: number | null): string {
    const totalText = total === null ? '*' : String(total);
    return rows === 0 ? `*/${totalText}` : `${offset}-${offset + rows - 1}/${totalText}`;
  }

  // ------------------------------------------------------------------ GET / HEAD

  private async read(tx: Transaction, relation: RelationInfo, url: URL, prefer: Prefer, wantsObject: boolean): Promise<RestResult> {
    const root = this.buildTree(relation, url.searchParams.get('select'), parseModifiers(url.searchParams));
    const from = `public.${quoteIdent(relation.name)} AS ${root.alias}`;
    const sql = `SELECT coalesce(json_agg(pgrst_r), '[]'::json)::text AS body FROM (${this.levelQuery(root, from, [], true)}) pgrst_r`;
    const result = await tx.query<{ body: string }>(sql);
    const rows = JSON.parse(result.rows[0]?.body ?? '[]') as unknown[];
    let total: number | null = null;
    if (prefer.count) {
      const counted = await tx.query<{ n: number | bigint | string }>(this.countQuery(root, from));
      total = Number(counted.rows[0]?.n ?? 0);
    }
    const offset = root.mods.offset ?? 0;
    const body = this.singleOrThrow(rows, wantsObject);
    const partial = total !== null && rows.length < total && (root.mods.limit !== null || offset > 0);
    return { status: partial ? 206 : 200, body, headers: { 'Content-Range': this.contentRange(offset, rows.length, total) } };
  }

  // ------------------------------------------------------------------ mutations

  /** Columns RETURNING must produce for the select tree built on top of the mutated rows. */
  private returningColumns(root: Level, alias: string): string {
    if (root.items.some((item) => item.kind === 'star')) return `${alias}.*`;
    const columns = new Set<string>();
    for (const item of root.items) if (item.kind === 'field') columns.add(item.column);
    for (const embed of root.embeds.values()) {
      for (const column of embed.kind === 'many_to_one' ? embed.fk.columns : embed.fk.refColumns) columns.add(column);
    }
    if (columns.size === 0) return '1 AS pgrst_none';
    return [...columns].map((c) => `${alias}.${quoteIdent(c)}`).join(', ');
  }

  /** Runs `mutation` (which must end where RETURNING can follow) with PostgREST's return semantics. */
  private async runMutation(
    tx: Transaction,
    relation: RelationInfo,
    url: URL,
    mutation: string,
    params: unknown[],
    prefer: Prefer,
    wantsObject: boolean,
    okStatus: number
  ): Promise<RestResult> {
    const representation = prefer.return === 'representation';
    let rows: unknown[] | null = null;
    let affected = 0;
    if (representation) {
      const root = this.buildTree(relation, url.searchParams.get('select'), new Map());
      const returning = this.returningColumns(root, 'pgrst_target');
      const sql = `WITH pgrst_source AS (${mutation} RETURNING ${returning})
        SELECT coalesce(json_agg(pgrst_r), '[]'::json)::text AS body, (SELECT count(*) FROM pgrst_source)::bigint AS n
          FROM (${this.levelQuery(root, `pgrst_source AS ${root.alias}`, [], false)}) pgrst_r`;
      const result = await tx.query<{ body: string; n: number | bigint | string }>(sql, params);
      rows = JSON.parse(result.rows[0]?.body ?? '[]') as unknown[];
      affected = Number(result.rows[0]?.n ?? 0);
    } else {
      const result = await tx.query(mutation, params);
      affected = result.affectedRows ?? 0;
    }
    if (wantsObject && affected !== 1) {
      // PostgREST rolls the mutation back when a single object was requested.
      throw pgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${affected} rows`);
    }
    const headers: Record<string, string> = { 'Content-Range': this.contentRange(0, affected, prefer.count ? affected : null) };
    if (prefer.return) headers['Preference-Applied'] = `return=${prefer.return}`;
    if (!representation) return { status: okStatus === 200 ? 204 : okStatus, body: undefined, headers };
    return { status: okStatus, body: wantsObject ? rows![0] : rows, headers };
  }

  private payloadColumns(relation: RelationInfo, keys: Iterable<string>): string[] {
    const columns = [...new Set(keys)];
    for (const column of columns) {
      if (!relation.columns.has(column)) {
        throw pgrstError(400, 'PGRST204', `Could not find the '${column}' column of '${relation.name}' in the schema cache`);
      }
    }
    return columns;
  }

  private async insert(tx: Transaction, relation: RelationInfo, url: URL, body: Buffer, prefer: Prefer, wantsObject: boolean): Promise<RestResult> {
    const parsed = parseJsonBody(body);
    const rows = Array.isArray(parsed) ? parsed : parsed === undefined ? [] : [parsed];
    if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw pgrstError(400, 'PGRST102', 'All object keys must match');
    }
    const objects = rows as Array<Record<string, unknown>>;
    const columnsParam = url.searchParams.get('columns');
    let columns: string[];
    if (columnsParam) {
      columns = columnsParam.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    } else {
      columns = Object.keys(objects[0] ?? {});
      const signature = [...columns].sort().join(',');
      if (objects.some((row) => Object.keys(row).sort().join(',') !== signature)) {
        throw pgrstError(400, 'PGRST102', 'All object keys must match');
      }
    }
    columns = this.payloadColumns(relation, columns);

    let conflict = '';
    const onConflict = url.searchParams.get('on_conflict');
    if (prefer.resolution) {
      const target = onConflict
        ? onConflict.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
        : relation.primaryKey;
      if (target.length === 0) throw pgrstError(400, 'PGRST103', 'on_conflict requires a unique or primary key');
      this.payloadColumns(relation, target);
      const targetSql = target.map(quoteIdent).join(', ');
      if (prefer.resolution === 'ignore-duplicates') {
        conflict = ` ON CONFLICT (${targetSql}) DO NOTHING`;
      } else {
        const sets = columns.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
        conflict = sets.length ? ` ON CONFLICT (${targetSql}) DO UPDATE SET ${sets.join(', ')}` : ` ON CONFLICT (${targetSql}) DO NOTHING`;
      }
    }

    const table = `public.${quoteIdent(relation.name)}`;
    const columnSql = columns.map(quoteIdent).join(', ');
    if (objects.length === 0) {
      return { status: 201, body: prefer.return === 'representation' ? [] : undefined, headers: { 'Content-Range': '*/*' } };
    }
    // PostgREST semantics: keys missing from an object become NULL, unless Prefer: missing=default.
    const heterogeneous = objects.some((row) => columns.some((c) => !(c in row)));
    if (prefer.missingDefault && heterogeneous) {
      if (prefer.return === 'representation' || wantsObject) {
        throw pgrstError(400, 'PGRST100', 'missing=default with differing object keys and return=representation is not supported by the E2E fake server');
      }
      let affected = 0;
      for (const row of objects) {
        const present = columns.filter((c) => c in row);
        const sql = present.length
          ? `INSERT INTO ${table} AS pgrst_target (${present.map(quoteIdent).join(', ')}) SELECT ${present.map(quoteIdent).join(', ')} FROM json_populate_record(NULL::${table}, $1::json)${conflict}`
          : `INSERT INTO ${table} AS pgrst_target DEFAULT VALUES${conflict}`;
        const result = await tx.query(sql, [JSON.stringify(row)]);
        affected += result.affectedRows ?? 0;
      }
      return { status: 201, body: undefined, headers: { 'Content-Range': this.contentRange(0, affected, prefer.count ? affected : null) } };
    }
    const mutation =
      columns.length > 0
        ? `INSERT INTO ${table} AS pgrst_target (${columnSql}) SELECT ${columnSql} FROM json_populate_recordset(NULL::${table}, $1::json) AS pgrst_body${conflict}`
        : `INSERT INTO ${table} AS pgrst_target DEFAULT VALUES${conflict}`;
    return this.runMutation(tx, relation, url, mutation, columns.length > 0 ? [JSON.stringify(objects)] : [], prefer, wantsObject, 201);
  }

  private mutationWhere(relation: RelationInfo, url: URL, verb: 'UPDATE' | 'DELETE'): string {
    const modifiers = parseModifiers(url.searchParams, new Set(['select']));
    const root = modifiers.get('') ?? { conditions: [], order: [], limit: null, offset: null };
    for (const path of modifiers.keys()) {
      if (path !== '') throw pgrstError(400, 'PGRST100', `Filters on embedded resources are not supported for ${verb} by the E2E fake server`);
    }
    for (const condition of root.conditions) {
      for (const column of conditionColumns(condition)) if (!relation.columns.has(column)) throw missingColumn(relation, column);
    }
    if (root.conditions.length === 0) {
      // Supabase enables pg-safeupdate for API requests.
      throw pgrstError(400, '21000', `${verb} requires a WHERE clause`);
    }
    return root.conditions.map((c) => conditionSql(c, 'pgrst_target')).join(' AND ');
  }

  private async update(tx: Transaction, relation: RelationInfo, url: URL, body: Buffer, prefer: Prefer, wantsObject: boolean): Promise<RestResult> {
    const parsed = parseJsonBody(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw pgrstError(400, 'PGRST102', 'Empty or invalid json');
    const values = parsed as Record<string, unknown>;
    const columns = this.payloadColumns(relation, Object.keys(values));
    const where = this.mutationWhere(relation, url, 'UPDATE');
    const table = `public.${quoteIdent(relation.name)}`;
    if (columns.length === 0) {
      return { status: prefer.return === 'representation' ? 200 : 204, body: prefer.return === 'representation' ? [] : undefined, headers: {} };
    }
    const sets = columns.map((c) => `${quoteIdent(c)} = pgrst_body.${quoteIdent(c)}`).join(', ');
    const mutation = `UPDATE ${table} AS pgrst_target SET ${sets} FROM json_populate_record(NULL::${table}, $1::json) AS pgrst_body WHERE ${where}`;
    return this.runMutation(tx, relation, url, mutation, [JSON.stringify(values)], prefer, wantsObject, 200);
  }

  private async remove(tx: Transaction, relation: RelationInfo, url: URL, prefer: Prefer, wantsObject: boolean): Promise<RestResult> {
    const where = this.mutationWhere(relation, url, 'DELETE');
    const mutation = `DELETE FROM public.${quoteIdent(relation.name)} AS pgrst_target WHERE ${where}`;
    return this.runMutation(tx, relation, url, mutation, [], prefer, wantsObject, 200);
  }

  // ------------------------------------------------------------------ RPC

  private chooseFunction(name: string, argNames: string[]): FunctionInfo {
    const overloads = this.state.schema.functions.get(name) ?? [];
    const match = overloads.find(
      (fn) =>
        argNames.every((arg) => fn.inputNames.includes(arg)) &&
        fn.inputNames.slice(0, fn.requiredCount).every((required) => argNames.includes(required))
    );
    if (!match) {
      const signature = argNames.length ? argNames.join(', ') : '';
      throw pgrstError(
        404,
        'PGRST202',
        `Could not find the function public.${name}(${signature}) in the schema cache`,
        `Searched for the function public.${name}${argNames.length ? ` with parameters ${signature}` : ' without parameters'}, but no matches were found in the schema cache.`
      );
    }
    return match;
  }

  private async rpc(tx: Transaction, name: string, method: string, url: URL, body: Buffer, prefer: Prefer, wantsObject: boolean): Promise<RestResult> {
    let args: Record<string, unknown> = {};
    let skip = new Set<string>(['select']);
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed !== undefined) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw pgrstError(400, 'PGRST102', 'Function arguments must be a JSON object');
        args = parsed as Record<string, unknown>;
      }
    } else if (method === 'GET' || method === 'HEAD') {
      const overloads = this.state.schema.functions.get(name) ?? [];
      const known = new Set(overloads.flatMap((fn) => fn.inputNames));
      for (const [key, value] of url.searchParams) if (known.has(key)) args[key] = value;
      skip = new Set([...skip, ...Object.keys(args)]);
    } else {
      throw pgrstError(405, 'PGRST101', 'Only GET and POST are allowed for functions');
    }
    const argNames = Object.keys(args);
    const fn = this.chooseFunction(name, argNames);
    const fnSql = `public.${quoteIdent(fn.name)}`;
    const argsFrom = argNames.length
      ? `json_to_record($1::json) AS pgrst_args(${argNames.map((a) => `${quoteIdent(a)} ${checkedTypeName(fn.inputTypes[fn.inputNames.indexOf(a)])}`).join(', ')})`
      : null;
    const call = `${fnSql}(${argNames.map((a) => `${quoteIdent(a)} => pgrst_args.${quoteIdent(a)}`).join(', ')})`;
    const params = argNames.length ? [JSON.stringify(args)] : [];

    if (fn.returnType === 'void' && !fn.returnsSet) {
      await tx.query(`SELECT ${call}${argsFrom ? ` FROM ${argsFrom}` : ''}`, params);
      return { status: 204, body: undefined, headers: {} };
    }
    if (!fn.returnsSet) {
      const sql = fn.returnsComposite
        ? `SELECT row_to_json(pgrst_0)::text AS body FROM ${argsFrom ? `${argsFrom}, LATERAL ` : ''}${call} AS pgrst_0`
        : `SELECT to_json(${call})::text AS body${argsFrom ? ` FROM ${argsFrom}` : ''}`;
      const result = await tx.query<{ body: string | null }>(sql, params);
      const value = JSON.parse(result.rows[0]?.body ?? 'null') as unknown;
      return { status: 200, body: value, headers: {} };
    }
    const from = `${argsFrom ? `${argsFrom}, LATERAL ` : ''}${call} AS pgrst_0`;
    if (!fn.returnsComposite) {
      const result = await tx.query<{ body: string }>(`SELECT coalesce(json_agg(pgrst_0), '[]'::json)::text AS body FROM ${from}`, params);
      const rows = JSON.parse(result.rows[0]?.body ?? '[]') as unknown[];
      return { status: 200, body: this.singleOrThrow(rows, wantsObject), headers: {} };
    }
    const root = this.buildTree(null, url.searchParams.get('select'), parseModifiers(url.searchParams, skip));
    // The tree's root alias is pgrst_0 (first alias allocated), matching `from`.
    const sql = `SELECT coalesce(json_agg(pgrst_r), '[]'::json)::text AS body FROM (${this.levelQuery(root, from, [], true)}) pgrst_r`;
    const result = await tx.query<{ body: string }>(sql, params);
    const rows = JSON.parse(result.rows[0]?.body ?? '[]') as unknown[];
    let total: number | null = null;
    if (prefer.count) {
      const counted = await tx.query<{ n: number | bigint | string }>(this.countQuery(root, from), params);
      total = Number(counted.rows[0]?.n ?? 0);
    }
    return {
      status: 200,
      body: this.singleOrThrow(rows, wantsObject),
      headers: { 'Content-Range': this.contentRange(root.mods.offset ?? 0, rows.length, total) }
    };
  }
}
