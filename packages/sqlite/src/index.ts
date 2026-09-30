/**
 * `@balsa/sqlite` — the first-party SQLite reference adapter (`docs/architecture/storage.md`
 * 「SQLite 参考 adapter(M5 设计冻结)」). One factory, one embedded file, all four storage ports:
 * `memory` / `workflowSnapshots` / `agentRunSnapshots` / `schedules`, each a port the core defines
 * and this package implements — the core's types are untouched and every declared port extension is
 * implemented here (the package exports the extended interfaces).
 *
 * The driver is Node's built-in `node:sqlite` (`>=22.13.0`, the flag-free floor ADR-0002 M5 froze):
 * zero dependencies, zero install weight, fully synchronous under the promise-shaped ports. One
 * connection per storage instance, never exposed — for raw SQL, open your own connection on the
 * same path (WAL makes that safe). `init()` (open + pragmas + migrations) and `close()` are
 * idempotent; the underlying driver is synchronous, so they are plain `void` methods — `await
 * storage.init()` from older docs still resolves immediately. Port methods throw until `init()` ran
 * and again after `close()`; the core never calls either (`storage.md`「连接生命周期」).
 *
 * Cross-process use: one file, WAL, busy timeout — writers serialize, readers don't block. Resume
 * de-duplication across processes rests on the caller using `compareAndSave`; the adapter keeps no
 * lease / claim / retry layer and lets `SQLITE_BUSY` out unchanged.
 */
import type { WorkingMemoryStore } from '@balsa/core/memory';
import type { ScheduleStore } from '@balsa/core/schedules';
import { createLifecycle, DEFAULT_BUSY_TIMEOUT_MS } from './connection.js';
import { createMemoryStore } from './memory.js';
import { createScheduleStore } from './schedules.js';
import { createAgentRunSnapshotStore, createWorkflowSnapshotStore } from './snapshots.js';
import type { SqliteAgentRunSnapshotStore, SqliteWorkflowSnapshotStore } from './snapshots.js';

export type {
  SqliteAgentRunSnapshotStore,
  SqliteWorkflowSnapshotStore,
} from './snapshots.js';

/** The factory options: a file path (or `':memory:'`) and an optional busy timeout override. */
export interface SqliteStorageOptions {
  /** File path or `':memory:'`, handed to `DatabaseSync` as-is; one connection per instance. */
  readonly path: string;
  /** Busy timeout in milliseconds (how long a lock waits); absent = 5 000. */
  readonly busyTimeoutMs?: number;
}

/**
 * The storage object: the four port faces plus the adapter-owned lifecycle. `memory` is a
 * `WorkingMemoryStore` — the conditional resource pair is implemented, so core's
 * `supportsWorkingMemory` detects working-memory support; the two snapshot faces carry their
 * extended interfaces (`compareAndSave` / `deleteSnapshot` / `listSnapshots` / `listSuspended`).
 */
export interface SqliteStorage {
  readonly memory: WorkingMemoryStore;
  readonly workflowSnapshots: SqliteWorkflowSnapshotStore;
  readonly agentRunSnapshots: SqliteAgentRunSnapshotStore;
  readonly schedules: ScheduleStore;
  /** Idempotent: open + pragmas (`WAL` / `synchronous=NORMAL` / `foreign_keys=ON` / busy timeout) + migrations. */
  init(): void;
  /** Idempotent: close the connection; a no-op before `init()`, refused afterwards. */
  close(): void;
}

/**
 * Creates one storage instance over `path`. Nothing touches the file until `init()`.
 *
 * ```ts
 * const storage = createSqliteStorage({ path: 'balsa.db', busyTimeoutMs: 5_000 })
 * storage.memory              // WorkingMemoryStore
 * storage.workflowSnapshots   // WorkflowSnapshotStore + compareAndSave / deleteSnapshot / listSnapshots
 * storage.agentRunSnapshots   // AgentRunSnapshotStore + deleteSnapshot / listSuspended
 * storage.schedules           // ScheduleStore
 * await storage.init()
 * await storage.close()
 * ```
 */
export function createSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  if (typeof options.path !== 'string' || options.path === '') {
    throw new TypeError('createSqliteStorage: path must be a non-empty string');
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(
      `createSqliteStorage: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`,
    );
  }
  const lifecycle = createLifecycle(options.path, busyTimeoutMs);
  return {
    memory: createMemoryStore(lifecycle),
    workflowSnapshots: createWorkflowSnapshotStore(lifecycle),
    agentRunSnapshots: createAgentRunSnapshotStore(lifecycle),
    schedules: createScheduleStore(lifecycle),
    init: lifecycle.init,
    close: lifecycle.close,
  };
}
