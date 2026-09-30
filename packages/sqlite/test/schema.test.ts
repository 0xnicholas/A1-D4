/**
 * The frozen v1 schema, pinned through the documented escape hatch (a raw second connection on the
 * same path): six STRICT tables with exactly the spec's columns, the three indexes, the `messages`
 * foreign key with `ON DELETE CASCADE`, and `PRAGMA user_version` as the migration ledger. Also the
 * two migration discipline rules: re-init on a migrated file is a no-op (data survives), and a
 * database whose `user_version` is ahead of this package refuses to open.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { caught, fileStorage, messageOf, openStorage, rawConnection } from './helpers.js';

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** Columns per table, in declaration order — the spec's v1 shape. */
const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  threads: ['id', 'resource_id', 'title', 'metadata', 'created_at', 'updated_at'],
  messages: ['id', 'thread_id', 'resource_id', 'created_at', 'payload'],
  resources: ['id', 'working_memory', 'metadata', 'created_at', 'updated_at'],
  workflow_snapshots: ['run_id', 'payload', 'updated_at'],
  agent_run_snapshots: ['run_id', 'payload', 'updated_at'],
  schedules: ['id', 'next_fire_at', 'enabled', 'timezone', 'target', 'metadata'],
};

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('SQLite schema', () => {
  it('creates exactly the six STRICT tables with the spec columns', () => {
    const { path } = fileStorage();
    const raw = rawConnection(path);

    expect(tableNames(raw)).toEqual(Object.keys(EXPECTED_COLUMNS).sort());

    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const info = raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[];
      expect(
        info.map((row) => row.name),
        `${table} columns`,
      ).toEqual([...columns]);
      const strict = raw
        .prepare('SELECT strict FROM pragma_table_list WHERE name = ?')
        .get(table) as { strict: number };
      expect(strict.strict, `${table} STRICT`).toBe(1);
    }
  });

  it('creates the three indexes and the messages cascade foreign key', () => {
    const { path } = fileStorage();
    const raw = rawConnection(path);

    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      'messages_by_thread',
      'schedules_by_next_fire',
      'threads_by_resource',
    ]);

    const foreignKeys = raw.prepare('PRAGMA foreign_key_list(messages)').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(foreignKeys).toEqual([
      { id: 0, seq: 0, table: 'threads', from: 'thread_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
    ]);
  });

  it('records user_version = 1 and keeps it there on a later init of the same file', async () => {
    const first = fileStorage();
    const rawBefore = rawConnection(first.path);
    expect((rawBefore.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    await first.storage.memory.saveThread({
      id: 'persisted',
      resourceId: 'r',
      createdAt: new Date(10),
      updatedAt: new Date(20),
    });
    first.storage.close();

    const second = openStorage({ path: first.path });
    second.init();
    expect((await second.memory.getThreadById('persisted'))?.createdAt.getTime()).toBe(10);

    const rawAfter = rawConnection(first.path);
    expect((rawAfter.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
  });

  it('refuses a database whose user_version is newer than this package supports', () => {
    const { path } = fileStorage();
    const raw = rawConnection(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const storage = openStorage({ path });
    expect(() => storage.init()).toThrow(/user_version 99.*newer|downgrades are not supported/);
  });

  it('leaves the storage uninitialized after a failed init — ports still ask for init()', async () => {
    const { path } = fileStorage();
    const raw = rawConnection(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const storage = openStorage({ path });
    expect(() => storage.init()).toThrow();
    expect(messageOf(await caught(storage.memory.getThreadById('t')))).toContain('call init() first');
  });
});
