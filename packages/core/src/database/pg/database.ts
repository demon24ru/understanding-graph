/**
 * PgDatabase — the better-sqlite3 surface, backed by Postgres.
 *
 * The engine only ever uses a small slice of better-sqlite3's API. The whole
 * of it, verified by grepping every call site in packages/{core,mcp-server,
 * web-server}:
 *
 *   db.prepare(sql).get(...params)   -> row | undefined
 *   db.prepare(sql).all(...params)   -> row[]
 *   db.prepare(sql).run(...params)   -> { changes, lastInsertRowid }
 *   db.exec(sql)                     -> void      (DDL, BEGIN/COMMIT/ROLLBACK)
 *   db.transaction(fn)               -> callable wrapper
 *   db.close()
 *
 * No .iterate(), no .pluck(), no .raw(), no user-defined functions, no backup
 * API. That is why a facade this size is enough to swap the storage engine.
 */

import { translate, type TranslatedStatement } from './dialect.js';
import { SyncPgClient } from './sync-client.js';

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Cache of translated SQL, keyed by the original statement text. */
const translationCache = new Map<string, TranslatedStatement>();

function translateCached(sql: string): TranslatedStatement {
  let t = translationCache.get(sql);
  if (!t) {
    t = translate(sql);
    translationCache.set(sql, t);
  }
  return t;
}

class PgStatement {
  constructor(
    private readonly db: PgDatabase,
    private readonly sql: string,
  ) {}

  private exec(
    mode: 'all' | 'get' | 'run',
    params: unknown[],
  ): { rows: Record<string, unknown>[]; changes: number; lastInsertRowid: number } {
    const t = translateCached(this.sql);
    // better-sqlite3 accepts either spread arguments or a single array.
    const flat =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    return this.db.rawQuery(t.text, flat, mode, t.returningColumn);
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const res = this.exec('get', params);
    return res.rows[0];
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.exec('all', params).rows;
  }

  run(...params: unknown[]): RunResult {
    const res = this.exec('run', params);
    return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
  }
}

export class PgDatabase {
  private client: SyncPgClient;
  /** Depth of the current transaction, including bare BEGIN from exec(). */
  private txDepth = 0;
  private savepointSeq = 0;

  constructor(client: SyncPgClient) {
    this.client = client;
  }

  /** Escape hatch used by PgStatement; not part of the better-sqlite3 API. */
  rawQuery(
    sql: string,
    params: unknown[],
    mode: 'all' | 'get' | 'run' | 'exec',
    returningColumn: string | null,
  ) {
    return this.client.query(sql, params, mode, returningColumn);
  }

  /**
   * Run SQL exactly as written, bypassing dialect translation. Used for the
   * Postgres-native schema DDL, which is already in the target dialect and
   * contains dollar-quoted PL/pgSQL the SQLite translator has no business
   * touching.
   */
  execRaw(sql: string): void {
    this.client.query(sql, [], 'exec', null);
  }

  prepare(sql: string): PgStatement {
    // Translate eagerly so a statement this backend cannot handle fails at
    // prepare() — where the stack still points at the call site — rather than
    // at execution time inside some unrelated loop.
    translateCached(sql);
    return new PgStatement(this, sql);
  }

  /**
   * exec() carries three different jobs in this codebase: schema DDL,
   * transaction control (graph_batch issues bare BEGIN/COMMIT/ROLLBACK), and
   * the occasional multi-statement script. Transaction control has to be
   * tracked, because db.transaction() must nest via SAVEPOINT when a bare
   * BEGIN is already open.
   */
  exec(sql: string): void {
    const bare = sql.trim().replace(/;$/, '').toUpperCase();

    if (bare === 'BEGIN' || bare === 'BEGIN TRANSACTION') {
      this.beginTransaction();
      return;
    }
    if (bare === 'COMMIT' || bare === 'COMMIT TRANSACTION') {
      this.commitTransaction();
      return;
    }
    if (bare === 'ROLLBACK' || bare === 'ROLLBACK TRANSACTION') {
      this.rollbackTransaction();
      return;
    }

    const t = translateCached(sql);
    this.client.query(t.text, [], 'exec', null);
  }

  private beginTransaction(): void {
    if (this.txDepth === 0) {
      this.client.query('BEGIN', [], 'exec', null);
    } else {
      this.client.query(
        `SAVEPOINT ug_sp_${++this.savepointSeq}`,
        [],
        'exec',
        null,
      );
    }
    this.txDepth++;
  }

  private commitTransaction(): void {
    if (this.txDepth === 0) return;
    if (this.txDepth === 1) {
      this.client.query('COMMIT', [], 'exec', null);
    } else {
      this.client.query(
        `RELEASE SAVEPOINT ug_sp_${this.savepointSeq--}`,
        [],
        'exec',
        null,
      );
    }
    this.txDepth--;
  }

  private rollbackTransaction(): void {
    if (this.txDepth === 0) return;
    if (this.txDepth === 1) {
      this.client.query('ROLLBACK', [], 'exec', null);
    } else {
      this.client.query(
        `ROLLBACK TO SAVEPOINT ug_sp_${this.savepointSeq--}`,
        [],
        'exec',
        null,
      );
    }
    this.txDepth--;
  }

  /**
   * better-sqlite3's db.transaction(fn) returns a function that runs fn inside
   * a transaction and rolls back if it throws. Same contract here.
   */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      self.beginTransaction();
      try {
        const result = fn.apply(this, args);
        self.commitTransaction();
        return result;
      } catch (err) {
        self.rollbackTransaction();
        throw err;
      }
    };
    return wrapped as unknown as T;
  }

  /** Present so `PRAGMA`-style tuning calls do not crash. Postgres has none. */
  pragma(_source: string): unknown[] {
    return [];
  }

  close(): void {
    this.client.close();
  }

  /** better-sqlite3 exposes this; a few diagnostics print it. */
  get name(): string {
    return `postgres:${this.client.schema}`;
  }

  get open(): boolean {
    return true;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }
}
