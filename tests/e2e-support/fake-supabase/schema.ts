/**
 * E2E TEST SUPPORT ONLY: PostgREST-style "schema cache" (relations, columns, primary keys,
 * foreign keys, functions of the public schema), read from the migrated database catalog.
 */
import type { PGlite } from '@electric-sql/pglite';

export interface ColumnInfo {
  name: string;
  type: string;
  generated: boolean;
}

export interface RelationInfo {
  name: string;
  kind: 'table' | 'view';
  columns: Map<string, ColumnInfo>;
  primaryKey: string[];
}

export interface ForeignKeyInfo {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FunctionInfo {
  name: string;
  returnsSet: boolean;
  returnType: string;
  returnsComposite: boolean;
  inputNames: string[];
  inputTypes: string[];
  requiredCount: number;
}

export interface SchemaCache {
  relations: Map<string, RelationInfo>;
  foreignKeys: ForeignKeyInfo[];
  functions: Map<string, FunctionInfo[]>;
}

export async function loadSchemaCache(db: PGlite): Promise<SchemaCache> {
  const relations = new Map<string, RelationInfo>();
  const columns = await db.query<{ table: string; relkind: string; column: string; type: string; generated: boolean }>(
    `SELECT c.relname AS "table", c.relkind::text AS relkind, a.attname AS "column",
            format_type(a.atttypid, a.atttypmod) AS type, (a.attgenerated <> '') AS generated
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
      ORDER BY c.relname, a.attnum`
  );
  for (const row of columns.rows) {
    let relation = relations.get(row.table);
    if (!relation) {
      relation = { name: row.table, kind: row.relkind === 'v' || row.relkind === 'm' ? 'view' : 'table', columns: new Map(), primaryKey: [] };
      relations.set(row.table, relation);
    }
    relation.columns.set(row.column, { name: row.column, type: row.type, generated: row.generated });
  }

  const pks = await db.query<{ table: string; cols: string[] }>(
    `SELECT c.relname AS "table",
            array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'p'`
  );
  for (const row of pks.rows) {
    const relation = relations.get(row.table);
    if (relation) relation.primaryKey = row.cols;
  }

  const fks = await db.query<{ name: string; table: string; ref_table: string; cols: string[]; ref_cols: string[] }>(
    `SELECT con.conname::text AS name, c.relname::text AS "table", fc.relname::text AS ref_table,
            array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
            array(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS ref_cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public' AND fn.nspname = 'public'`
  );
  const foreignKeys = fks.rows.map((row) => ({
    name: row.name,
    table: row.table,
    columns: row.cols,
    refTable: row.ref_table,
    refColumns: row.ref_cols
  }));

  const fns = await db.query<{
    name: string;
    retset: boolean;
    rettype: string;
    composite: boolean;
    nargs: number;
    nargdefaults: number;
    argnames: string[];
    argmodes: string[];
    argtypes: string[];
  }>(
    `SELECT p.proname::text AS name, p.proretset AS retset, format_type(p.prorettype, NULL) AS rettype,
            (coalesce(t.typrelid, 0) <> 0 OR p.prorettype = 'record'::regtype) AS composite,
            p.pronargs::int AS nargs, p.pronargdefaults::int AS nargdefaults,
            coalesce(p.proargnames, '{}'::text[])::text[] AS argnames,
            coalesce(p.proargmodes::text[], '{}'::text[]) AS argmodes,
            array(SELECT format_type(x, NULL) FROM unnest(p.proargtypes) x)::text[] AS argtypes
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       LEFT JOIN pg_type t ON t.oid = p.prorettype
      WHERE n.nspname = 'public' AND p.prokind = 'f'`
  );
  const functions = new Map<string, FunctionInfo[]>();
  for (const row of fns.rows) {
    const inputNames =
      row.argmodes.length === 0
        ? row.argnames.slice(0, row.nargs)
        : row.argnames.filter((_name, index) => ['i', 'b', 'v'].includes(row.argmodes[index]));
    const info: FunctionInfo = {
      name: row.name,
      returnsSet: row.retset,
      returnType: row.rettype,
      returnsComposite: row.composite,
      inputNames,
      inputTypes: row.argtypes,
      requiredCount: row.nargs - row.nargdefaults
    };
    const list = functions.get(row.name) ?? [];
    list.push(info);
    functions.set(row.name, list);
  }

  return { relations, foreignKeys, functions };
}
