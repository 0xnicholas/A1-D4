/**
 * Helpers for the SQLite adapter tests: `:memory:` storages for the fast default, file-backed
 * storages rooted in a fresh temp directory for everything WAL / cross-connection, and raw second
 * connections (the spec's documented escape hatch — a host opens its own connection on the same
 * path for raw SQL) for schema-level assertions. No external service, no network.
 *
 * Every resource created here is torn down LIFO after the test: open connections first, temp
 * directories last (WAL leaves `-wal` / `-shm` files behind, so the close must precede the rm).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createSqliteStorage } from '@balsa/sqlite';
import type { SqliteStorage, SqliteStorageOptions } from '@balsa/sqlite';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Creates a storage, registers its close, and leaves it **uninitialized** (for lifecycle tests). */
export function openStorage(options: SqliteStorageOptions): SqliteStorage {
  const storage = createSqliteStorage(options);
  cleanups.push(() => storage.close());
  return storage;
}

/** An initialized `:memory:` storage — every connection is its own database, the test default. */
export function memoryStorage(busyTimeoutMs?: number): SqliteStorage {
  const storage = openStorage(
    busyTimeoutMs === undefined ? { path: ':memory:' } : { path: ':memory:', busyTimeoutMs },
  );
  storage.init();
  return storage;
}

export interface FileStorage {
  /** An initialized storage on `<dir>/<name>`. */
  readonly storage: SqliteStorage;
  /** The database file path — what a second process (or a raw connection) opens. */
  readonly path: string;
  /** The temp directory holding the database file. */
  readonly dir: string;
}

/** An initialized file-backed storage in a fresh temp directory, removed after the test. */
export function fileStorage(options: { name?: string; busyTimeoutMs?: number } = {}): FileStorage {
  const dir = mkdtempSync(join(tmpdir(), 'balsa-sqlite-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, options.name ?? 'balsa.db');
  const storage = openStorage(
    options.busyTimeoutMs === undefined ? { path } : { path, busyTimeoutMs: options.busyTimeoutMs },
  );
  storage.init();
  return { storage, path, dir };
}

/** A raw connection on `path` (created if absent), closed after the test. Not initialized. */
export function rawConnection(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // A test may close it early; the teardown stays a no-op then.
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  });
  return db;
}

/** Awaits a call and returns whatever it rejects with — `undefined` when it resolves. */
export const caught = (call: unknown): Promise<unknown> =>
  Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error,
  );

/** Message of a caught rejection, for a readable assertion failure. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
