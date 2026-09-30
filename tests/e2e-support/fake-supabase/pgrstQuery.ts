/**
 * E2E TEST SUPPORT ONLY: parser for the PostgREST URL grammar that supabase-js produces
 * (select lists with aliases / casts / JSON paths / embedded resources, horizontal filters,
 * or/and logic trees, order, limit / offset, per-embed modifiers) and helpers that turn the
 * parsed conditions into SQL. Everything that reaches SQL is either a quoted identifier, a
 * validated type name, or an escaped string literal (Postgres infers its type from the column,
 * exactly like PostgREST's untyped parameters).
 */
import { HttpError } from './http';

export type JsonStep = { arrow: '->' | '->>'; key: string };

export interface FieldItem {
  kind: 'field';
  alias: string | null;
  column: string;
  json: JsonStep[];
  cast: string | null;
}
export interface StarItem {
  kind: 'star';
}
export interface EmbedItem {
  kind: 'embed';
  alias: string | null;
  relation: string;
  hints: string[];
  inner: boolean;
  items: SelectItem[];
}
export type SelectItem = FieldItem | StarItem | EmbedItem;

export interface OpCondition {
  kind: 'op';
  column: string;
  json: JsonStep[];
  negate: boolean;
  op: string;
  modifier: 'any' | 'all' | null;
  /** Language for fts operators. */
  lang: string | null;
  value: string;
}
export interface LogicCondition {
  kind: 'logic';
  op: 'and' | 'or';
  negate: boolean;
  children: Condition[];
}
export type Condition = OpCondition | LogicCondition;

export interface OrderTerm {
  column: string;
  json: JsonStep[];
  direction: 'ASC' | 'DESC';
  nulls: 'FIRST' | 'LAST' | null;
}

/** Filters / modifiers attached to one level of the select tree ([] = the root table). */
export interface LevelModifiers {
  conditions: Condition[];
  order: OrderTerm[];
  limit: number | null;
  offset: number | null;
}

export function pgrstError(status: number, code: string, message: string, details: string | null = null, hint: string | null = null): HttpError {
  return new HttpError(status, { code, message, details, hint });
}

function parseError(message: string, details: string | null = null): HttpError {
  return pgrstError(400, 'PGRST100', message, details);
}

// ------------------------------------------------------------------ SQL quoting

export function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes('\u0000')) throw parseError(`Invalid identifier "${name}"`);
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw parseError('Values must not contain NUL characters');
  return `'${value.replace(/'/g, "''")}'`;
}

const TYPE_NAME = /^[a-z_][a-z0-9_]*(\s[a-z_][a-z0-9_]*)*(\[\])?$/i;

export function checkedTypeName(type: string): string {
  if (!TYPE_NAME.test(type)) throw parseError(`Invalid type name "${type}"`);
  return type;
}

/** `alias."col"->'a'->>0` */
export function columnExpr(alias: string, column: string, json: JsonStep[]): string {
  let expr = `${alias}.${quoteIdent(column)}`;
  for (const step of json) {
    expr += /^-?\d+$/.test(step.key) ? `${step.arrow}${step.key}` : `${step.arrow}${quoteLiteral(step.key)}`;
  }
  return expr;
}

// ------------------------------------------------------------------ select=

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  peek(n = 1): string {
    return this.s.slice(this.i, this.i + n);
  }
  eat(token: string): boolean {
    if (this.s.startsWith(token, this.i)) {
      this.i += token.length;
      return true;
    }
    return false;
  }
  expect(token: string): void {
    if (!this.eat(token)) throw parseError(`"failed to parse select parameter (${this.s})"`, `unexpected "${this.peek() || 'end of input'}" expecting "${token}"`);
  }
  ident(): string {
    if (this.peek() === '"') {
      let out = '';
      this.i += 1;
      while (!this.done) {
        const ch = this.s[this.i];
        if (ch === '"') {
          if (this.s[this.i + 1] === '"') {
            out += '"';
            this.i += 2;
            continue;
          }
          this.i += 1;
          return out;
        }
        out += ch;
        this.i += 1;
      }
      throw parseError(`"failed to parse select parameter (${this.s})"`, 'unterminated quoted identifier');
    }
    const match = /^[A-Za-z0-9_$@ ]+/.exec(this.s.slice(this.i));
    if (!match) {
      throw parseError(`"failed to parse select parameter (${this.s})"`, `unexpected "${this.peek() || 'end of input'}" expecting field name`);
    }
    this.i += match[0].length;
    return match[0].trim();
  }
}

function parseJsonSteps(cur: Cursor): JsonStep[] {
  const steps: JsonStep[] = [];
  for (;;) {
    let arrow: JsonStep['arrow'] | null = null;
    if (cur.eat('->>')) arrow = '->>';
    else if (cur.eat('->')) arrow = '->';
    if (!arrow) return steps;
    steps.push({ arrow, key: cur.ident() });
  }
}

function parseSelectItems(cur: Cursor, nested: boolean): SelectItem[] {
  const items: SelectItem[] = [];
  if (nested && cur.peek() === ')') return items;
  for (;;) {
    items.push(parseSelectItem(cur));
    if (cur.eat(',')) continue;
    if (cur.done || (nested && cur.peek() === ')')) return items;
    throw parseError(`"failed to parse select parameter (${cur.s})"`, `unexpected "${cur.peek()}"`);
  }
}

function parseSelectItem(cur: Cursor): SelectItem {
  if (cur.eat('*')) return { kind: 'star' };
  if (cur.peek(3) === '...') throw parseError('Spread embedded resources (...) are not supported by the E2E fake server');
  let alias: string | null = null;
  let name = cur.ident();
  if (cur.peek() === ':' && cur.peek(2) !== '::') {
    cur.expect(':');
    alias = name;
    name = cur.ident();
  }
  if (cur.peek() === '!' || cur.peek() === '(') {
    const hints: string[] = [];
    let inner = false;
    while (cur.eat('!')) {
      const hint = cur.ident();
      if (hint === 'inner') inner = true;
      else if (hint !== 'left') hints.push(hint);
    }
    cur.expect('(');
    const items = parseSelectItems(cur, true);
    cur.expect(')');
    return { kind: 'embed', alias, relation: name, hints, inner, items };
  }
  const json = parseJsonSteps(cur);
  let cast: string | null = null;
  if (cur.eat('::')) cast = checkedTypeName(cur.ident());
  if (cur.peek() === '.') throw parseError('Aggregate functions are not supported by the E2E fake server');
  return { kind: 'field', alias, column: name, json, cast };
}

export function parseSelect(select: string | null): SelectItem[] {
  const text = select === null || select === '' ? '*' : select;
  const cur = new Cursor(text);
  const items = parseSelectItems(cur, false);
  if (!cur.done) throw parseError(`"failed to parse select parameter (${text})"`, `unexpected "${cur.peek()}"`);
  return items;
}

// ------------------------------------------------------------------ filters

const OPERATORS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch', 'is', 'isdistinct', 'in',
  'cs', 'cd', 'ov', 'sl', 'sr', 'nxr', 'nxl', 'adj', 'fts', 'plfts', 'phfts', 'wfts'
]);

/** Splits a column reference like `data->>key` into the column and its JSON path. */
export function parseColumnRef(text: string): { column: string; json: JsonStep[] } {
  const cur = new Cursor(text);
  const column = cur.ident();
  const json = parseJsonSteps(cur);
  if (!cur.done) throw parseError(`"failed to parse filter (${text})"`, `unexpected "${cur.peek()}"`);
  return { column, json };
}

/** `[not.]op[(any|all)|(lang)].value` */
export function parseOperatorValue(column: string, json: JsonStep[], text: string): OpCondition {
  let rest = text;
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const match = /^([a-z]+)(?:\(([a-z_]+)\))?(?:\.|$)/.exec(rest);
  if (!match || !OPERATORS.has(match[1])) {
    throw parseError(`"failed to parse filter (${text})"`, `unknown operator in "${text}"`);
  }
  const op = match[1];
  const paren = match[2] ?? null;
  const value = rest.slice(match[0].length);
  let modifier: OpCondition['modifier'] = null;
  let lang: string | null = null;
  if (paren) {
    if (paren === 'any' || paren === 'all') modifier = paren;
    else if (op === 'fts' || op === 'plfts' || op === 'phfts' || op === 'wfts') lang = paren;
    else throw parseError(`"failed to parse filter (${text})"`, `unexpected modifier "${paren}"`);
  }
  return { kind: 'op', column, json, negate, op, modifier, lang, value };
}

/** Splits on top-level commas, respecting parentheses and double quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/** `(a.eq.1,or(b.gt.2,c.is.null))` → children */
export function parseLogicTree(op: 'and' | 'or', negate: boolean, text: string): LogicCondition {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw parseError(`"failed to parse logic tree (${text})"`, 'expected a parenthesised list');
  }
  const children: Condition[] = [];
  for (const raw of splitTopLevel(trimmed.slice(1, -1))) {
    const item = raw.trim();
    if (!item) continue;
    const logic = /^(not\.)?(and|or)(\([\s\S]*\))$/.exec(item);
    if (logic) {
      children.push(parseLogicTree(logic[2] as 'and' | 'or', Boolean(logic[1]), logic[3]));
      continue;
    }
    // column[->json...].[not.]op.value — the column ends at the first '.' after its JSON path.
    const opMatch = /\.(not\.)?([a-z]+)(\([a-z_]+\))?(\.|$)/.exec(item);
    if (!opMatch || !OPERATORS.has(opMatch[2])) {
      throw parseError(`"failed to parse logic tree (${text})"`, `could not parse "${item}"`);
    }
    const { column, json } = parseColumnRef(item.slice(0, opMatch.index));
    const condition = parseOperatorValue(column, json, item.slice(opMatch.index + 1));
    condition.value = unquote(condition.value);
    children.push(condition);
  }
  return { kind: 'logic', op, negate, children };
}

export function parseOrder(text: string): OrderTerm[] {
  return splitTopLevel(text)
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const segments = part.split('.');
      let direction: OrderTerm['direction'] = 'ASC';
      let nulls: OrderTerm['nulls'] = null;
      while (segments.length > 1) {
        const last = segments[segments.length - 1];
        if (last === 'asc' || last === 'desc') direction = last === 'desc' ? 'DESC' : 'ASC';
        else if (last === 'nullsfirst') nulls = 'FIRST';
        else if (last === 'nullslast') nulls = 'LAST';
        else break;
        segments.pop();
      }
      const { column, json } = parseColumnRef(segments.join('.'));
      return { column, json, direction, nulls };
    });
}

function parseNonNegativeInt(value: string, what: string): number {
  if (!/^\d+$/.test(value)) throw parseError(`"failed to parse ${what} parameter (${value})"`);
  return Number(value);
}

const RESERVED = new Set(['select', 'columns', 'on_conflict']);

/**
 * Groups filters and modifiers by embed path. Keys: `col`, `embed.col`, `or`, `not.and`,
 * `embed.or`, `order`, `embed.order`, `limit`, `offset`, `embed.limit`.
 * `argNames` (RPC via GET) are skipped.
 */
export function parseModifiers(params: URLSearchParams, skip: Set<string> = new Set()): Map<string, LevelModifiers> {
  const levels = new Map<string, LevelModifiers>();
  const level = (path: string): LevelModifiers => {
    let found = levels.get(path);
    if (!found) {
      found = { conditions: [], order: [], limit: null, offset: null };
      levels.set(path, found);
    }
    return found;
  };
  for (const [key, value] of params) {
    if (RESERVED.has(key) || skip.has(key)) continue;
    // Logic trees: [path.]or / [path.]not.or / and
    const logic = /^(?:(.*)\.)?(not\.)?(and|or)$/.exec(key);
    if (logic) {
      level(logic[1] ?? '').conditions.push(parseLogicTree(logic[3] as 'and' | 'or', Boolean(logic[2]), value));
      continue;
    }
    const modifier = /^(?:(.*)\.)?(order|limit|offset)$/.exec(key);
    if (modifier) {
      const target = level(modifier[1] ?? '');
      if (modifier[2] === 'order') target.order.push(...parseOrder(value));
      else if (modifier[2] === 'limit') target.limit = parseNonNegativeInt(value, 'limit');
      else target.offset = parseNonNegativeInt(value, 'offset');
      continue;
    }
    // Horizontal filter; the path is everything before the last '.' that is not inside a JSON arrow.
    const arrowAt = key.search(/->/);
    const head = arrowAt === -1 ? key : key.slice(0, arrowAt);
    const dot = head.lastIndexOf('.');
    const path = dot === -1 ? '' : key.slice(0, dot);
    const columnText = dot === -1 ? key : key.slice(dot + 1);
    const { column, json } = parseColumnRef(columnText);
    level(path).conditions.push(parseOperatorValue(column, json, value));
  }
  return levels;
}

// ------------------------------------------------------------------ condition → SQL

function parseInList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw parseError(`"failed to parse filter (in.${value})"`, 'expected (a,b,...)');
  }
  const inner = trimmed.slice(1, -1);
  if (inner.trim() === '') return [];
  return splitTopLevel(inner).map((item) => unquote(item.trim()));
}

const SIMPLE_OPS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  match: '~',
  imatch: '~*',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxr: '&<',
  nxl: '&>',
  adj: '-|-',
  isdistinct: 'IS DISTINCT FROM'
};

const FTS_FUNCTIONS: Record<string, string> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery'
};

function opConditionSql(c: OpCondition, alias: string): string {
  const col = columnExpr(alias, c.column, c.json);
  let sql: string;
  if (c.op === 'is') {
    const v = c.value.toLowerCase();
    const keyword = v === 'null' ? 'NULL' : v === 'not_null' ? 'NOT NULL' : v === 'true' ? 'TRUE' : v === 'false' ? 'FALSE' : v === 'unknown' ? 'UNKNOWN' : null;
    if (!keyword) throw parseError(`"failed to parse filter (is.${c.value})"`, 'is accepts null, not_null, true, false or unknown');
    sql = `${col} IS ${keyword}`;
  } else if (c.op === 'in') {
    const values = parseInList(c.value);
    sql = values.length === 0 ? 'false' : `${col} IN (${values.map(quoteLiteral).join(', ')})`;
  } else if (FTS_FUNCTIONS[c.op]) {
    const fn = FTS_FUNCTIONS[c.op];
    sql = `${col} @@ ${fn}(${c.lang ? `${quoteLiteral(c.lang)}, ` : ''}${quoteLiteral(c.value)})`;
  } else {
    const operator = SIMPLE_OPS[c.op];
    if (!operator) throw parseError(`Unsupported operator ${c.op}`);
    const toLiteral = (v: string) => quoteLiteral(c.op === 'like' || c.op === 'ilike' ? v.replace(/\*/g, '%') : v);
    if (c.modifier) {
      const list = c.value.replace(/^\{|\}$/g, '');
      const values = list === '' ? [] : splitTopLevel(list).map((v) => unquote(v.trim()));
      sql = `${col} ${operator} ${c.modifier === 'any' ? 'ANY' : 'ALL'}(ARRAY[${values.map(toLiteral).join(', ')}])`;
    } else {
      sql = `${col} ${operator} ${toLiteral(c.value)}`;
    }
  }
  return c.negate ? `NOT (${sql})` : sql;
}

export function conditionSql(c: Condition, alias: string): string {
  if (c.kind === 'op') return opConditionSql(c, alias);
  const parts = c.children.map((child) => `(${conditionSql(child, alias)})`);
  const joined = parts.length === 0 ? 'true' : parts.join(c.op === 'and' ? ' AND ' : ' OR ');
  return c.negate ? `NOT (${joined})` : `(${joined})`;
}

export function orderSql(terms: OrderTerm[], alias: string): string {
  if (terms.length === 0) return '';
  return ` ORDER BY ${terms
    .map((t) => `${columnExpr(alias, t.column, t.json)} ${t.direction}${t.nulls ? ` NULLS ${t.nulls}` : ''}`)
    .join(', ')}`;
}

/** Columns a condition tree references (for validation). */
export function conditionColumns(c: Condition): string[] {
  return c.kind === 'op' ? [c.column] : c.children.flatMap(conditionColumns);
}
