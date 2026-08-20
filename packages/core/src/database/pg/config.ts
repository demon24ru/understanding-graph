/**
 * Postgres backend configuration — everything from environment variables so it
 * can be declared in the `env` block of an MCP server definition.
 *
 *   UG_DB_BACKEND      sqlite (default) | postgres
 *   UG_PG_URL          postgres://user:pass@host:port/db      (preferred)
 *   UG_PG_HOST / UG_PG_PORT / UG_PG_DB / UG_PG_USER / UG_PG_PASSWORD
 *                      component form, used only when UG_PG_URL is absent
 *   UG_PG_SSL          require | no-verify | disable (default disable)
 *   UG_PG_SCHEMA_PREFIX  schema name prefix per project (default "ug_")
 *   UG_PG_STATEMENT_TIMEOUT_MS   per-statement timeout (default 30000)
 *   UG_PG_CONNECT_TIMEOUT_MS     connection timeout   (default 15000)
 */

export type DbBackend = 'sqlite' | 'postgres';

export function getDbBackend(): DbBackend {
  const raw = (process.env.UG_DB_BACKEND ?? 'sqlite').trim().toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') {
    return 'postgres';
  }
  if (raw === 'sqlite' || raw === '') return 'sqlite';
  throw new Error(
    `UG_DB_BACKEND="${raw}" is not a known backend. Use "sqlite" or "postgres".`,
  );
}

export interface PgConnectionConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: false | { rejectUnauthorized: boolean };
  connectionTimeoutMillis: number;
  statement_timeout: number;
}

function parseSsl(): PgConnectionConfig['ssl'] {
  const raw = (process.env.UG_PG_SSL ?? 'disable').trim().toLowerCase();
  if (raw === 'require') return { rejectUnauthorized: true };
  if (raw === 'no-verify' || raw === 'allow') return { rejectUnauthorized: false };
  return false;
}

export function getPgConfig(): PgConnectionConfig {
  const connectTimeout = Number(
    process.env.UG_PG_CONNECT_TIMEOUT_MS ?? '15000',
  );
  const statementTimeout = Number(
    process.env.UG_PG_STATEMENT_TIMEOUT_MS ?? '30000',
  );

  const url = process.env.UG_PG_URL?.trim();
  if (url) {
    return {
      connectionString: url,
      ssl: parseSsl(),
      connectionTimeoutMillis: connectTimeout,
      statement_timeout: statementTimeout,
    };
  }

  const host = process.env.UG_PG_HOST?.trim();
  if (!host) {
    throw new Error(
      'UG_DB_BACKEND=postgres but neither UG_PG_URL nor UG_PG_HOST is set. ' +
        'Set UG_PG_URL="postgres://user:password@host:port/database" (preferred), ' +
        'or the component variables UG_PG_HOST / UG_PG_PORT / UG_PG_DB / UG_PG_USER / UG_PG_PASSWORD.',
    );
  }

  return {
    host,
    port: Number(process.env.UG_PG_PORT ?? '5432'),
    database: process.env.UG_PG_DB?.trim() || 'ugraph',
    user: process.env.UG_PG_USER?.trim() || 'ugraph',
    password: process.env.UG_PG_PASSWORD ?? '',
    ssl: parseSsl(),
    connectionTimeoutMillis: connectTimeout,
    statement_timeout: statementTimeout,
  };
}

/**
 * Postgres schema name for a project id. One schema per project mirrors the
 * one-store.db-per-project layout of the SQLite backend, so cross-project
 * lookups stay a matter of switching search_path rather than reconnecting.
 */
export function schemaForProject(projectId: string): string {
  const prefix = process.env.UG_PG_SCHEMA_PREFIX ?? 'ug_';
  const safe = projectId.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  if (!safe) throw new Error(`Project id "${projectId}" has no usable characters for a schema name.`);
  return `${prefix}${safe}`;
}

/** Inverse of schemaForProject, for enumerating projects that exist in PG. */
export function projectFromSchema(schema: string): string | null {
  const prefix = process.env.UG_PG_SCHEMA_PREFIX ?? 'ug_';
  if (!schema.startsWith(prefix)) return null;
  return schema.slice(prefix.length);
}
