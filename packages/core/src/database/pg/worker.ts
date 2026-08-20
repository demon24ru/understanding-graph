/**
 * Postgres worker thread.
 *
 * The engine's entire data layer is synchronous (better-sqlite3 style:
 * `db.prepare(sql).get(...)` returns a row, it does not return a promise), and
 * roughly 190 call sites across 23k lines depend on that. `pg` is asynchronous.
 * This worker is the bridge: it owns the async Postgres client, and the main
 * thread blocks on `Atomics.wait` until this thread answers. See sync-client.ts
 * for the main-thread half and for the latency consequences.
 *
 * One worker owns exactly one `pg.Client` — a single session, never a pool.
 * That is not an optimisation, it is a correctness requirement: graph_batch
 * implements atomicity with bare `BEGIN` / `COMMIT` / `ROLLBACK` statements
 * (see mcp-server/src/tools/batch.ts), which only mean anything if every
 * statement in the batch lands on the same session.
 */

import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import pg from 'pg';

interface WorkerInit {
  port: MessagePort;
  signal: SharedArrayBuffer;
  config: Record<string, unknown>;
  schema: string;
  searchPathExtra: string;
}

const init = workerData as WorkerInit;
const notify = new Int32Array(init.signal);
const replyPort = init.port;

let client: pg.Client | null = null;
let vectorOid: number | null = null;

/** int8 arrives as a string by default; the engine expects numbers. */
pg.types.setTypeParser(20, (v: string) => Number(v));
/** numeric/float8 likewise. */
pg.types.setTypeParser(1700, (v: string) => Number(v));

type Mode = 'all' | 'get' | 'run' | 'exec';

interface Request {
  id: number;
  op: 'connect' | 'query' | 'close';
  sql?: string;
  params?: unknown[];
  mode?: Mode;
  returningColumn?: string | null;
}

interface Reply {
  id: number;
  ok: boolean;
  rows?: Record<string, unknown>[];
  changes?: number;
  lastInsertRowid?: number;
  /** Columns decoded from pgvector, so the main thread can restore Buffers. */
  vectorColumns?: string[];
  error?: { message: string; code?: string; detail?: string; hint?: string; position?: string };
}

/**
 * Float32 blob -> pgvector literal.
 *
 * The engine stores embeddings by handing the driver a Buffer wrapping a
 * Float32Array (EmbeddingService.embeddingToBuffer). `nodes.embedding` is the
 * only binary column in the schema, so a Buffer parameter is unambiguously an
 * embedding and can be converted without inspecting the statement.
 */
function bufferToVectorLiteral(buf: Buffer): string {
  const floats = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  return `[${Array.from(floats).join(',')}]`;
}

/** pgvector literal -> the Buffer shape the engine's readers expect. */
function vectorLiteralToBuffer(text: string): Buffer {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner) return Buffer.alloc(0);
  const parts = inner.split(',');
  const floats = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) floats[i] = Number(parts[i]);
  return Buffer.from(floats.buffer);
}

function encodeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    // Note the Uint8Array test rather than Buffer.isBuffer: a Buffer posted
    // across the worker boundary is structured-cloned, and structured clone
    // does not preserve the Buffer subclass — it arrives here as a plain
    // Uint8Array. Testing for Buffer alone silently skipped the conversion
    // and handed pgvector raw bytes, which it rejected with
    // "vector must have at least 1 dimension".
    if (p instanceof Uint8Array) {
      return bufferToVectorLiteral(
        Buffer.from(p.buffer, p.byteOffset, p.byteLength),
      );
    }
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}

async function connect(): Promise<void> {
  client = new pg.Client(init.config as pg.ClientConfig);
  await client.connect();

  const searchPath = init.searchPathExtra
    ? `"${init.schema}", ${init.searchPathExtra}`
    : `"${init.schema}"`;
  await client.query(`SET search_path TO ${searchPath}`);

  const oidRes = await client.query(
    "SELECT oid FROM pg_type WHERE typname = 'vector' LIMIT 1",
  );
  vectorOid = oidRes.rows.length ? Number(oidRes.rows[0].oid) : null;
}

async function runQuery(req: Request): Promise<Reply> {
  if (!client) throw new Error('Postgres worker received a query before connect()');
  const params = encodeParams(req.params ?? []);

  // exec() may carry several statements separated by ';'. The simple query
  // protocol handles that, but it cannot take parameters — which is fine,
  // exec() is only ever used for DDL and transaction control.
  const res =
    req.mode === 'exec'
      ? await client.query(req.sql as string)
      : await client.query(req.sql as string, params);

  const results = Array.isArray(res) ? res : [res];
  const last = results[results.length - 1];

  let rows: Record<string, unknown>[] = (last?.rows ?? []) as Record<string, unknown>[];

  // Decode pgvector columns back into Buffers.
  let vectorColumns: string[] = [];
  if (vectorOid !== null && last?.fields?.length) {
    const vectorFields = last.fields
      .filter((f: pg.FieldDef) => Number(f.dataTypeID) === vectorOid)
      .map((f: pg.FieldDef) => f.name);
    vectorColumns = vectorFields;
    if (vectorFields.length) {
      rows = rows.map((row) => {
        const copy = { ...row };
        for (const name of vectorFields) {
          const v = copy[name];
          if (typeof v === 'string') copy[name] = vectorLiteralToBuffer(v);
        }
        return copy;
      });
    }
  }

  const changes = results.reduce((sum, r) => sum + (r?.rowCount ?? 0), 0);

  let lastInsertRowid = 0;
  if (req.returningColumn && rows.length) {
    const v = rows[rows.length - 1][req.returningColumn];
    if (v != null) lastInsertRowid = Number(v);
  }

  return { id: req.id, ok: true, rows, changes, lastInsertRowid, vectorColumns };
}

function reply(msg: Reply): void {
  replyPort.postMessage(msg);
  Atomics.store(notify, 0, 1);
  Atomics.notify(notify, 0);
}

parentPort?.on('message', (req: Request) => {
  const handle = async (): Promise<Reply> => {
    if (req.op === 'connect') {
      await connect();
      return { id: req.id, ok: true, rows: [], changes: 0 };
    }
    if (req.op === 'close') {
      if (client) await client.end();
      client = null;
      return { id: req.id, ok: true, rows: [], changes: 0 };
    }
    return runQuery(req);
  };

  handle().then(reply, (err: unknown) => {
    const e = err as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
    reply({
      id: req.id,
      ok: false,
      error: {
        message: e?.message ?? String(err),
        code: e?.code,
        detail: e?.detail,
        hint: e?.hint,
        position: e?.position,
      },
    });
  });
});
