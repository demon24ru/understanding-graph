/**
 * SQLite -> PostgreSQL statement translation.
 *
 * The engine's ~190 SQL statements were written against better-sqlite3. Rather
 * than rewrite every call site, this module rewrites the statement text at
 * prepare()/exec() time. It is deliberately a *lexer*, not a parser: it walks
 * the string tracking whether it is inside a single-quoted literal, a
 * double-quoted identifier, or a comment, and only rewrites outside them. That
 * is enough for this dialect gap and it never mangles a JSON payload that
 * happens to contain a "?" or the word "LIKE".
 *
 * Differences handled, in the order they matter:
 *
 *  1. Placeholders    ?               -> $1, $2, ...
 *  2. Clock           datetime('now') -> to_char(now() at time zone 'UTC', ...)
 *                     kept as TEXT in the same 'YYYY-MM-DD HH:MM:SS' shape the
 *                     rest of the engine parses and sorts lexicographically.
 *  3. Upsert          INSERT OR REPLACE/IGNORE -> ON CONFLICT ...
 *  4. LIKE            -> ILIKE. SQLite's LIKE is case-insensitive for ASCII;
 *                     Postgres' is not. ILIKE restores the original behaviour.
 *  5. Full text       the single FTS5 `nodes_fts MATCH ?` query is replaced
 *                     wholesale with a tsvector query over title+understanding.
 *  6. Catalog         sqlite_master / PRAGMA table_info -> information_schema.
 *  7. JSON            json_extract(col,'$.k') -> (col::jsonb ->> 'k'), with the
 *                     `= 1` truthiness comparison handled explicitly
 *  8. Misc            IFNULL -> COALESCE, last_insert_rowid() -> lastval()
 *
 * Anything not listed above passes through untouched, which is correct for the
 * overwhelming majority of statements: the schema is plain TEXT/INTEGER columns
 * and the SQL is ordinary ANSI.
 */

/** Primary/unique key used as the ON CONFLICT target for INSERT OR REPLACE. */
const CONFLICT_TARGETS: Record<string, string> = {
  nodes: 'id',
  edges: 'id',
  commits: 'id',
  conversations: 'id',
  documents: 'hash',
  project_meta: 'key',
  solvers: 'id',
  tasks: 'id',
  solver_feedback: 'id',
  enforcement_log: 'id',
  text_sources: 'id',
  // resource_locks has UNIQUE(resource_id, holder_id); that, not the surrogate
  // id, is what an "acquire this lock again" upsert actually conflicts on.
  resource_locks: 'resource_id, holder_id',
};

/**
 * Tables whose primary key is generated, so INSERT ... RETURNING <pk> can
 * stand in for better-sqlite3's `lastInsertRowid`.
 */
export const IDENTITY_PK: Record<string, string> = {
  event_log: 'seq',
  tool_calls: 'id',
  chat_history: 'id',
};

export interface TranslatedStatement {
  /** Rewritten SQL, with $n placeholders. */
  text: string;
  /** Number of $n placeholders in `text`. */
  paramCount: number;
  /** For INSERTs into identity tables: the column returned for lastInsertRowid. */
  returningColumn: string | null;
  /** True when a caller-visible statement had its shape replaced (FTS, PRAGMA). */
  rewritten: boolean;
}

/**
 * Split a statement into alternating (text, isCode) spans so rewrites only
 * ever touch code, never string literals, quoted identifiers or comments.
 */
function lex(sql: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  let buf = '';
  let i = 0;
  const push = (isCode: boolean, text: string) => {
    if (text) out.push([text, isCode]);
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      push(true, buf);
      buf = '';
      const quote = ch;
      let lit = quote;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          lit += quote;
          i++;
          if (sql[i] === quote) {
            // A doubled quote is an escaped quote: still inside the literal.
            lit += quote;
            i++;
            continue;
          }
          break;
        }
        lit += sql[i];
        i++;
      }
      push(false, lit);
      continue;
    }
    if (ch === '-' && next === '-') {
      push(true, buf);
      buf = '';
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      push(false, sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      push(true, buf);
      buf = '';
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      push(false, sql.slice(i, stop));
      i = stop;
      continue;
    }
    buf += ch;
    i++;
  }
  push(true, buf);
  return out;
}

/** Apply a rewrite to code spans only. */
function mapCode(sql: string, fn: (code: string) => string): string {
  return lex(sql)
    .map(([text, isCode]) => (isCode ? fn(text) : text))
    .join('');
}

/** The 'YYYY-MM-DD HH:MM:SS' UTC string that SQLite's datetime('now') yields. */
export const PG_NOW_TEXT =
  "to_char((now() at time zone 'UTC'), 'YYYY-MM-DD HH24:MI:SS')";

/**
 * Rewrites applied to the WHOLE statement, literals included.
 *
 * These are function calls whose arguments are string literals —
 * datetime('now'), json_extract(col,'$.k') — so scanning only outside quotes
 * would step over the very text that has to change. That was a real bug: the
 * first version of this file lexed first, which split datetime('now') at the
 * quote and left all ~20 runtime UPDATE ... SET updated_at = datetime('now')
 * statements untranslated.
 *
 * Matching inside a literal is not a practical risk here. The patterns are
 * whole call expressions with a fixed argument shape, and user payloads reach
 * the database as bind parameters, never as inlined SQL text.
 */
function rewriteFunctions(sql: string): string {
  return (
    sql
      .replace(/\bdatetime\s*\(\s*'now'\s*\)/gi, PG_NOW_TEXT)
      .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
      .replace(/\blast_insert_rowid\s*\(\s*\)/gi, 'lastval()')
      // json_extract(col,'$.k') = 1 must not become `text = integer`, which
      // Postgres rejects outright. SQLite's json_extract yields 1 for a JSON
      // true, so that equality is really a truthiness test on the text form.
      .replace(
        /\bjson_extract\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)\s*=\s*1\b/gi,
        "(nullif($1, '')::jsonb ->> '$2') IN ('1', 'true')",
      )
      .replace(
        /\bjson_extract\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)\s*=\s*(\d+)\b/gi,
        "(nullif($1, '')::jsonb ->> '$2') = '$3'",
      )
      .replace(
        /\bjson_extract\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi,
        "(nullif($1, '')::jsonb ->> '$2')",
      )
  );
}

/**
 * Rewrites applied to code spans only.
 *
 * LIKE is a bare word and could plausibly occur inside a literal, so unlike
 * the function rewrites above this one has to respect quoting.
 */
function rewriteOperators(sql: string): string {
  return mapCode(sql, (code) =>
    code
      .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
      .replace(/(?<!NOT\s)\bLIKE\b/gi, 'ILIKE'),
  );
}

function rewriteCommon(sql: string): string {
  return rewriteOperators(rewriteFunctions(sql));
}

/** ? -> $n, counting only placeholders that live in code spans. */
function numberPlaceholders(sql: string): { text: string; count: number } {
  let n = 0;
  const text = lex(sql)
    .map(([part, isCode]) => {
      if (!isCode) return part;
      return part.replace(/\?/g, () => `$${++n}`);
    })
    .join('');
  return { text, count: n };
}

/**
 * INSERT OR REPLACE INTO t (a, b, c) VALUES (...)
 *   -> INSERT INTO t (a, b, c) VALUES (...)
 *      ON CONFLICT (<key>) DO UPDATE SET a = EXCLUDED.a, ...
 * INSERT OR IGNORE -> ON CONFLICT DO NOTHING.
 */
function rewriteUpsert(sql: string): string {
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  const replace = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\b/i.test(sql);
  if (!ignore && !replace) return sql;

  const m = sql.match(
    /INSERT\s+OR\s+(?:REPLACE|IGNORE)\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([^)]*)\)/i,
  );
  if (!m) {
    throw new Error(
      `Cannot translate this INSERT OR REPLACE/IGNORE to Postgres — its column list could not be read: ${sql.slice(0, 200)}`,
    );
  }
  const table = m[1].toLowerCase();
  const columns = m[2]
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  const base = sql.replace(
    /INSERT\s+OR\s+(?:REPLACE|IGNORE)\s+INTO/i,
    'INSERT INTO',
  );

  if (ignore) return `${base} ON CONFLICT DO NOTHING`;

  const target = CONFLICT_TARGETS[table];
  if (!target) {
    throw new Error(
      `INSERT OR REPLACE INTO "${table}" cannot be translated: no ON CONFLICT target is registered for that table in dialect.ts (CONFLICT_TARGETS).`,
    );
  }
  const targetCols = target.split(',').map((c) => c.trim());
  const assignments = columns
    .filter((c) => !targetCols.includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`);
  if (assignments.length === 0) {
    return `${base} ON CONFLICT (${target}) DO NOTHING`;
  }
  return `${base} ON CONFLICT (${target}) DO UPDATE SET ${assignments.join(', ')}`;
}

/**
 * The engine has exactly one FTS5 query (GraphStore.searchNodes). FTS5's
 * MATCH operator and its implicit `rank` column have no Postgres equivalent
 * reachable by token substitution, so the statement is replaced outright.
 *
 * $1 is referenced twice on purpose — Postgres allows a parameter to appear
 * any number of times, so the caller still passes exactly (query, limit).
 */
const FTS_EXPR =
  "to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.understanding, ''))";

const PG_FTS_QUERY = `
  SELECT n.* FROM nodes n
  WHERE n.active = 1
    AND ${FTS_EXPR} @@ websearch_to_tsquery('simple', $1)
  ORDER BY ts_rank(${FTS_EXPR}, websearch_to_tsquery('simple', $1)) DESC
  LIMIT $2
`;

/** PRAGMA table_info("t") -> a result set carrying SQLite's column names. */
function pragmaTableInfo(table: string): string {
  const lit = table.replace(/'/g, "''");
  return `
    SELECT (c.ordinal_position - 1)::int              AS cid,
           c.column_name                              AS name,
           upper(c.data_type)                         AS type,
           CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END::int AS notnull,
           c.column_default                           AS dflt_value,
           CASE WHEN kc.column_name IS NOT NULL THEN 1 ELSE 0 END::int AS pk
    FROM information_schema.columns c
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = c.table_schema
     AND tc.table_name  = c.table_name
     AND tc.constraint_type = 'PRIMARY KEY'
    LEFT JOIN information_schema.key_column_usage kc
      ON kc.constraint_name = tc.constraint_name
     AND kc.table_schema = c.table_schema
     AND kc.column_name = c.column_name
    WHERE c.table_schema = current_schema()
      AND c.table_name = '${lit}'
    ORDER BY c.ordinal_position
  `;
}

const SQLITE_MASTER_TABLES = `
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  ORDER BY table_name
`;

/**
 * Translate one SQLite statement into one Postgres statement.
 * Pure function of its input — callers cache the result per statement text.
 */
export function translate(sqlIn: string): TranslatedStatement {
  const sql = sqlIn.trim();

  // --- statements whose shape is replaced wholesale ------------------------
  if (/\bnodes_fts\s+MATCH\b/i.test(sql)) {
    return {
      text: PG_FTS_QUERY,
      paramCount: 2,
      returningColumn: null,
      rewritten: true,
    };
  }
  const pragma = sql.match(
    /^PRAGMA\s+table_info\s*\(\s*"?([A-Za-z0-9_]+)"?\s*\)\s*;?$/i,
  );
  if (pragma) {
    return {
      text: pragmaTableInfo(pragma[1]),
      paramCount: 0,
      returningColumn: null,
      rewritten: true,
    };
  }
  if (/\bsqlite_master\b/i.test(sql)) {
    if (/type\s*=\s*'table'/i.test(sql)) {
      return {
        text: SQLITE_MASTER_TABLES,
        paramCount: 0,
        returningColumn: null,
        rewritten: true,
      };
    }
    throw new Error(
      `Query reads sqlite_master in a form the Postgres backend does not translate: ${sql.slice(0, 200)}`,
    );
  }
  if (/^PRAGMA\b/i.test(sql)) {
    // Every other PRAGMA is a SQLite tuning knob with no Postgres meaning.
    return {
      text: 'SELECT 1 WHERE false',
      paramCount: 0,
      returningColumn: null,
      rewritten: true,
    };
  }

  // --- ordinary statements -------------------------------------------------
  let text = rewriteUpsert(sql);
  text = rewriteCommon(text);

  // INSERT into an identity table: surface the generated key so .run() can
  // report lastInsertRowid the way better-sqlite3 does.
  let returningColumn: string | null = null;
  const ins = text.match(/^\s*INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
  if (ins && !/\bRETURNING\b/i.test(text)) {
    const pk = IDENTITY_PK[ins[1].toLowerCase()];
    if (pk) {
      returningColumn = pk;
      text = `${text.replace(/;\s*$/, '')} RETURNING "${pk}"`;
    }
  }

  const numbered = numberPlaceholders(text);
  return {
    text: numbered.text,
    paramCount: numbered.count,
    returningColumn,
    rewritten: false,
  };
}
