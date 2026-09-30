// Per-project SQLite access. One connection per database (node:sqlite is
// synchronous, so requests are serialized anyway), WAL mode plus busy_timeout
// so concurrent readers never block and lock contention surfaces as
// SQLITE_BUSY instead of corruption.
//
// Every statement goes through the JSON codec in jsonsql.ts. query/exec accept
// exactly one statement (node:sqlite silently drops trailing statements);
// batch runs several in one transaction and picks query/exec shape per
// statement based on whether it returns rows.

import { DatabaseSync } from "node:sqlite";
import { SlopError } from "./errors.ts";
import { bindValue, encodeValue, type Json, type SqlValue } from "./jsonsql.ts";
import { singleStatement } from "./sqlscan.ts";

export type Params = Json[] | { [k: string]: Json };

export interface QueryResult {
  columns: string[];
  rows: { [k: string]: Json }[];
}

export interface ExecResult {
  changes: number | string;
  last_insert_rowid: number | string;
}

export type StmtResult = QueryResult | ExecResult;

export interface Statement {
  sql: string;
  params?: Params;
}

function sqlErr(e: unknown): never {
  if (e instanceof SlopError) throw e;
  throw new SlopError("sql_error", e instanceof Error ? e.message : String(e));
}

// The runtime accepts named parameters as one object argument
// (stmt.all({ name: value })); the node:sqlite type definitions do not model
// that overload, hence this narrow facade over StatementSync.
interface RawStmt {
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  columns(): { name: string }[];
  setReadBigInts(v: boolean): void;
}

function bindArgs(params?: Params): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  const named: { [k: string]: SqlValue } = {};
  for (const [key, value] of Object.entries(params)) named[key] = bindValue(value);
  return [named];
}

export class ProjectDb {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA busy_timeout=5000");
  }

  close(): void {
    this.#db.close();
  }

  query(sql: string, params?: Params): QueryResult {
    const stmt = this.#prepare(sql, params);
    try {
      const rows = stmt.all(...bindArgs(params)) as Record<string, SqlValue>[];
      return {
        columns: this.#columns(stmt),
        rows: rows.map((row) => {
          const out: { [k: string]: Json } = {};
          for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
          return out;
        }),
      };
    } catch (e) {
      sqlErr(e);
    }
  }

  exec(sql: string, params?: Params): ExecResult {
    const stmt = this.#prepare(sql, params);
    try {
      const r = stmt.run(...bindArgs(params));
      return {
        changes: encodeValue(r.changes) as number | string,
        last_insert_rowid: encodeValue(r.lastInsertRowid) as number | string,
      };
    } catch (e) {
      sqlErr(e);
    }
  }

  // All statements in one transaction; per statement the result is rows (if it
  // returns any) or change counters. Rolls back everything on the first error.
  batch(stmts: Statement[]): StmtResult[] {
    if (stmts.length === 0) throw new SlopError("bad_request", "empty batch");
    this.#db.exec("BEGIN");
    try {
      const results = stmts.map((s) => this.#runOne(s));
      this.#db.exec("COMMIT");
      return results;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // transaction already gone
      }
      throw e;
    }
  }

  schema(): { tables: { name: string; sql: string }[] } {
    try {
      const rows = this.#db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as unknown as { name: string; sql: string | null }[];
      return { tables: rows.map((r) => ({ name: r.name, sql: r.sql ?? "" })) };
    } catch (e) {
      sqlErr(e);
    }
  }

  // Make the on-disk db file self-contained, for download-db.
  checkpoint(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  #runOne(s: Statement): StmtResult {
    const params = s.params;
    const stmt = this.#prepare(s.sql, params);
    try {
      if (this.#columns(stmt).length > 0) {
        const rows = stmt.all(...bindArgs(params)) as Record<string, SqlValue>[];
        return {
          columns: this.#columns(stmt),
          rows: rows.map((row) => {
            const out: { [k: string]: Json } = {};
            for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
            return out;
          }),
        };
      }
      const r = stmt.run(...bindArgs(params));
      return {
        changes: encodeValue(r.changes) as number | string,
        last_insert_rowid: encodeValue(r.lastInsertRowid) as number | string,
      };
    } catch (e) {
      sqlErr(e);
    }
  }

  #prepare(sql: string, params?: Params): RawStmt {
    const text = singleStatement(sql);
    try {
      const stmt = this.#db.prepare(text) as unknown as RawStmt;
      // Big integers come back as bigint and are narrowed in encodeValue.
      stmt.setReadBigInts(true);
      return stmt;
    } catch (e) {
      sqlErr(e);
    }
  }

  #columns(stmt: RawStmt): string[] {
    return stmt.columns().map((c) => c.name);
  }
}

// One connection per database path, shared across requests.
const open = new Map<string, ProjectDb>();

export function getProjectDb(path: string): ProjectDb {
  let db = open.get(path);
  if (!db) {
    db = new ProjectDb(path);
    open.set(path, db);
  }
  return db;
}

export function closeProjectDb(path: string): void {
  open.get(path)?.close();
  open.delete(path);
}
