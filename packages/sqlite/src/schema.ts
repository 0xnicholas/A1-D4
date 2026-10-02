/**
 * The frozen v1 schema: six STRICT tables,
 * three indexes, nothing else — no triggers, no views, no `AUTOINCREMENT`.
 *
 * Migrations are forward-only and additive-only. There is no migration table: the ordered array
 * below is the only registry and `PRAGMA user_version` is the ledger it advances. Growth adds
 * tables / columns / indexes and never reshapes what exists (migration discipline).
 */
import type { DatabaseSync } from 'node:sqlite';

/** One forward migration: `up` runs once, inside the migration transaction, then `user_version = version`. */
export interface Migration {
  readonly version: number;
  readonly up: (db: DatabaseSync) => void;
}

/**
 * v1. Encoding nailed to the SQL (see the port modules for the JS side): `Date` → `INTEGER` unix ms;
 * optional fields absent → SQL NULL; JSON values → text (NULL and `'null'` stay distinct); the
 * snapshot payloads are whole-record JSON with a storage-side `updated_at` side column that serves
 * list ordering only — no `status` column, `listSnapshots({ status })` reads it out of the payload.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, metadata TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
        CREATE INDEX threads_by_resource ON threads (resource_id, updated_at DESC, id DESC);

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE INDEX messages_by_thread ON messages (thread_id, created_at DESC, id DESC);

        CREATE TABLE resources (
          id TEXT PRIMARY KEY, working_memory TEXT, metadata TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;

        CREATE TABLE workflow_snapshots (
          run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

        CREATE TABLE agent_run_snapshots (
          run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

        CREATE TABLE schedules (
          id TEXT PRIMARY KEY, next_fire_at INTEGER, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
          timezone TEXT, target TEXT NOT NULL, metadata TEXT) STRICT;
        CREATE INDEX schedules_by_next_fire ON schedules (next_fire_at, id);
      `);
    },
  },
];

/** The highest version this package knows — a database above it refuses to open (no downgrades). */
export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
