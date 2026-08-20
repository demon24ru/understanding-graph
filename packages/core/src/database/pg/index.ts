/**
 * Postgres backend entry point.
 *
 * `openPgDatabase(projectId)` is the Postgres counterpart of
 * `new Database(store.db)`: it returns an object the rest of the engine can
 * use exactly as it used better-sqlite3, with the project's schema created and
 * migrated to the current shape.
 */

import { getEmbeddingDimension } from '../../services/EmbeddingService.js';
import { getPgConfig, projectFromSchema, schemaForProject } from './config.js';
import { PgDatabase } from './database.js';
import {
  BOOTSTRAP_DDL,
  embeddingDimFixupSql,
  projectSchemaDdl,
} from './schema.js';
import { SyncPgClient } from './sync-client.js';

/**
 * Open (and if necessary create) the Postgres schema backing one project.
 */
export function openPgDatabase(projectId: string): PgDatabase {
  const schema = schemaForProject(projectId);
  const cfg = getPgConfig();

  const client = new SyncPgClient({
    config: cfg as unknown as Record<string, unknown>,
    schema,
    searchPathExtra: 'public',
    callTimeoutMs: cfg.statement_timeout + 30_000,
  });
  const db = new PgDatabase(client);

  // pgvector lives in public and is shared by every project schema. On a
  // managed instance the app user may lack CREATE privilege on the extension;
  // if it is already installed that is fine, so only a genuinely missing
  // extension should stop startup.
  try {
    db.execRaw(BOOTSTRAP_DDL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not ensure the pgvector extension exists: ${msg}\n` +
        'Install it once as a superuser with:  CREATE EXTENSION vector;',
    );
  }

  db.execRaw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

  const dim = getEmbeddingDimension();
  db.execRaw(projectSchemaDdl(schema, dim));
  db.execRaw(embeddingDimFixupSql(schema, dim));

  return db;
}

/**
 * Project ids that already exist in Postgres. The SQLite backend discovers
 * projects by listing directories that contain a store.db; this is the
 * equivalent question asked of the database.
 */
export function listPgProjects(): string[] {
  const schema = schemaForProject('default');
  const cfg = getPgConfig();
  const client = new SyncPgClient({
    config: cfg as unknown as Record<string, unknown>,
    schema,
    searchPathExtra: 'public',
    callTimeoutMs: cfg.statement_timeout + 30_000,
  });
  try {
    const res = client.query(
      `SELECT n.nspname AS name
         FROM pg_namespace n
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'nodes'
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname`,
      [],
      'all',
      null,
    );
    return res.rows
      .map((r) => projectFromSchema(String(r.name)))
      .filter((p): p is string => Boolean(p));
  } finally {
    client.close();
  }
}

export { PgDatabase } from './database.js';
export { getDbBackend, schemaForProject } from './config.js';
