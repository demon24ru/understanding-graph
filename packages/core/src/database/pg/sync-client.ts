/**
 * Synchronous Postgres client, main-thread half.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine's data layer is synchronous end to end. `GraphStore.getNode()`
 * returns a node, not a promise; `sqlite.getEventLog()` returns rows. About 190
 * call sites across 23k lines are written that way, and the functions that call
 * *them* are synchronous too, all the way up into the MCP tool handlers.
 * Converting that to async is not a storage change, it is a rewrite of the
 * whole package.
 *
 * So instead: `pg` runs on a worker thread and the main thread blocks on
 * `Atomics.wait` until the answer arrives, then picks it up with
 * `receiveMessageOnPort`. The call site still sees a plain synchronous return.
 * This is the same mechanism `synckit` uses, and `Atomics.wait` on the main
 * thread is permitted in Node (unlike in a browser).
 *
 * WHAT IT COSTS — read before deploying against a remote database
 * ---------------------------------------------------------------
 * Every statement now costs a full network round trip, and the main thread is
 * *blocked* for all of it — nothing else in the process runs. With SQLite a
 * query was a memory read (microseconds); over a WAN link it is milliseconds,
 * and this codebase issues queries in loops. An operation that ran 200
 * statements was imperceptible on SQLite; at 20 ms RTT it takes 4 seconds.
 *
 * The practical consequence: put the database close to the process. On the
 * same host or the same LAN this is fine. Across the open internet it will be
 * slow in a way no amount of tuning inside this file can fix, because the cost
 * is latency multiplied by statement count, not throughput.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from 'node:worker_threads';

export interface SyncPgOptions {
  config: Record<string, unknown>;
  schema: string;
  /** Extra entries appended to search_path, e.g. "public" for the vector type. */
  searchPathExtra?: string;
  /** How long the main thread will block on one statement before giving up. */
  callTimeoutMs?: number;
}

export interface SyncQueryResult {
  rows: Record<string, unknown>[];
  changes: number;
  lastInsertRowid: number;
}

interface Reply {
  id: number;
  ok: boolean;
  rows?: Record<string, unknown>[];
  changes?: number;
  lastInsertRowid?: number;
  vectorColumns?: string[];
  error?: {
    message: string;
    code?: string;
    detail?: string;
    hint?: string;
    position?: string;
  };
}

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'worker.js',
);

export class SyncPgClient {
  private worker: Worker;
  private port: MessagePort;
  private signal: Int32Array;
  private nextId = 1;
  private closed = false;
  private readonly callTimeoutMs: number;
  readonly schema: string;

  constructor(opts: SyncPgOptions) {
    this.schema = opts.schema;
    // `??` does not catch NaN, and `Atomics.wait` treats a NaN timeout as
    // +Infinity — a call that blocks the whole process forever with no error,
    // no CPU and no lock. Anything not finite and positive falls back.
    this.callTimeoutMs =
      Number.isFinite(opts.callTimeoutMs) && (opts.callTimeoutMs as number) > 0
        ? (opts.callTimeoutMs as number)
        : 60_000;

    const sab = new SharedArrayBuffer(4);
    this.signal = new Int32Array(sab);

    const channel = new MessageChannel();
    this.port = channel.port1;

    this.worker = new Worker(WORKER_PATH, {
      workerData: {
        port: channel.port2,
        signal: sab,
        config: opts.config,
        schema: opts.schema,
        searchPathExtra: opts.searchPathExtra ?? 'public',
      },
      transferList: [channel.port2],
      // Without this the process will not exit while the worker is idle.
      stdout: false,
      stderr: false,
    });
    this.worker.unref();

    this.call({ op: 'connect' });
  }

  /**
   * Post a request, block until the worker answers, return its reply.
   * The blocking is the whole point; see the header comment.
   */
  private call(req: Record<string, unknown>): Reply {
    if (this.closed) {
      throw new Error('Postgres connection is closed');
    }
    const id = this.nextId++;

    const deadline = Date.now() + this.callTimeoutMs;
    Atomics.store(this.signal, 0, 0);
    this.worker.postMessage({ ...req, id });

    // Wait for the reply *to this request*. The id check is load-bearing: a
    // call that timed out earlier leaves its reply in the port queue, and the
    // worker's late `Atomics.store(1)` can land after the next call has already
    // reset the signal. Without matching ids, the next call woke up, took the
    // stale message off the queue and returned somebody else's rows — an
    // off-by-one that then persists for the life of the connection and reports
    // no error at all. Stale replies are discarded here instead.
    for (;;) {
      const reply = this.takeReply(id);
      if (reply) return SyncPgClient.unwrap(reply);

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.timeoutError(req);

      Atomics.store(this.signal, 0, 0);
      // A reply may have been delivered between the drain above and this
      // store, in which case the store just clobbered the worker's signal.
      // Drain once more so that wakeup cannot be lost.
      const raced = this.takeReply(id);
      if (raced) return SyncPgClient.unwrap(raced);

      if (Atomics.wait(this.signal, 0, 0, remaining) === 'timed-out') {
        throw this.timeoutError(req);
      }
    }
  }

  /** Drain the port, returning the reply for `id` and discarding stale ones. */
  private takeReply(id: number): Reply | null {
    for (;;) {
      const message = receiveMessageOnPort(this.port);
      if (!message) return null;
      const reply = message.message as Reply;
      if (reply.id === id) return reply;
      // Reply to a call that already gave up. Dropping it is the whole point.
    }
  }

  private timeoutError(req: Record<string, unknown>): Error {
    return new Error(
      `Postgres call timed out after ${this.callTimeoutMs} ms with no reply from the database worker. ` +
        'Either the server is unreachable, or a statement exceeded UG_PG_STATEMENT_TIMEOUT_MS. ' +
        `SQL: ${String(req.sql ?? req.op).slice(0, 200)}`,
    );
  }

  private static unwrap(reply: Reply): Reply {
    if (!reply.ok) {
      const e = reply.error;
      const err = new Error(e?.message ?? 'Unknown Postgres error') as Error & {
        code?: string;
        detail?: string;
        hint?: string;
      };
      err.code = e?.code;
      err.detail = e?.detail;
      err.hint = e?.hint;
      throw err;
    }
    return reply;
  }

  query(
    sql: string,
    params: unknown[],
    mode: 'all' | 'get' | 'run' | 'exec',
    returningColumn: string | null = null,
  ): SyncQueryResult {
    const reply = this.call({ op: 'query', sql, params, mode, returningColumn });
    const rows = reply.rows ?? [];

    // Structured clone strips the Buffer subclass on the way back, leaving a
    // plain Uint8Array. GraphStore.rowToNode gates on Buffer.isBuffer(), so
    // without this every embedding would read back as null — a silent wrong
    // answer rather than an error.
    if (reply.vectorColumns?.length && rows.length) {
      for (const row of rows) {
        for (const col of reply.vectorColumns) {
          const v = row[col];
          if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
            row[col] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
          }
        }
      }
    }

    return {
      rows,
      changes: reply.changes ?? 0,
      lastInsertRowid: reply.lastInsertRowid ?? 0,
    };
  }

  close(): void {
    if (this.closed) return;
    try {
      this.call({ op: 'close' });
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }
}
