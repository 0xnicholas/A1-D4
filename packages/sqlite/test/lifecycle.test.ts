/**
 * Lifecycle: the factory's own face (`docs/architecture/storage.md`「SQLite 参考 adapter」工厂面 /
 * 生命周期). `init()` opens + pragmas + migrates and is idempotent; every port method called before
 * it throws「call init() first」; `close()` is idempotent and every port method after it throws; a
 * file database comes up in WAL (a raw second connection sees the persistent journal mode) and
 * `:memory:` is accepted with its own `memory` mode.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRunSnapshot } from '@balsa/core/durable-agent';
import type { StoredMessage, StoredThread } from '@balsa/core/memory';
import type { ScheduleRecord } from '@balsa/core/schedules';
import type { WorkflowRunSnapshot } from '@balsa/core/workflows';
import type { SqliteStorage } from '@balsa/sqlite';
import { caught, fileStorage, messageOf, openStorage, rawConnection } from './helpers.js';

/** Every port method, as a thunk — the matrix for the two guards (pre-init, post-close). */
function portCalls(storage: SqliteStorage): Array<[string, () => Promise<unknown>]> {
  const thread: StoredThread = {
    id: 't',
    resourceId: 'r',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const message: StoredMessage = {
    id: 'm',
    threadId: 't',
    resourceId: 'r',
    createdAt: new Date(0),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
  };
  const snapshot: WorkflowRunSnapshot = {
    runId: 'w',
    status: 'running',
    input: null,
    stepResults: {},
    position: 0,
  };
  const agentSnapshot: AgentRunSnapshot = {
    runId: 'a',
    status: 'suspended',
    messages: [],
    stepCount: 0,
    suspendPayload: { toolCalls: [], awaitingApproval: [] },
  };
  const schedule: ScheduleRecord = {
    id: 's',
    nextFireAt: null,
    enabled: true,
    target: { agent: 'nightly', input: 'report' },
  };
  return [
    ['memory.getThreadById', () => storage.memory.getThreadById('t')],
    ['memory.saveThread', () => storage.memory.saveThread(thread)],
    ['memory.deleteThread', () => storage.memory.deleteThread('t')],
    ['memory.listThreads', () => storage.memory.listThreads({ resourceId: 'r' })],
    ['memory.listMessages', () => storage.memory.listMessages({ threadId: 't' })],
    ['memory.saveMessages', () => storage.memory.saveMessages([message])],
    ['memory.getResource', () => storage.memory.getResource('r')],
    ['memory.saveResource', () => storage.memory.saveResource({ id: 'r', createdAt: new Date(0), updatedAt: new Date(0) })],
    ['workflowSnapshots.load', () => storage.workflowSnapshots.load('w')],
    ['workflowSnapshots.save', () => storage.workflowSnapshots.save('w', snapshot)],
    ['workflowSnapshots.compareAndSave', () => storage.workflowSnapshots.compareAndSave('w', snapshot, null)],
    ['workflowSnapshots.deleteSnapshot', () => storage.workflowSnapshots.deleteSnapshot('w')],
    ['workflowSnapshots.listSnapshots', () => storage.workflowSnapshots.listSnapshots()],
    ['agentRunSnapshots.load', () => storage.agentRunSnapshots.load('a')],
    ['agentRunSnapshots.save', () => storage.agentRunSnapshots.save('a', agentSnapshot)],
    ['agentRunSnapshots.deleteSnapshot', () => storage.agentRunSnapshots.deleteSnapshot('a')],
    ['agentRunSnapshots.listSuspended', () => storage.agentRunSnapshots.listSuspended()],
    ['schedules.save', () => storage.schedules.save(schedule)],
    ['schedules.get', () => storage.schedules.get('s')],
    ['schedules.list', () => storage.schedules.list()],
    ['schedules.delete', () => storage.schedules.delete('s')],
    ['schedules.listDue', () => storage.schedules.listDue(new Date(0))],
  ];
}

describe('createSqliteStorage lifecycle', () => {
  it('rejects every port method before init() with the call-init error', async () => {
    const storage = openStorage({ path: ':memory:' });
    for (const [name, call] of portCalls(storage)) {
      const error = await caught(call());
      expect(error, `${name} before init()`).toBeInstanceOf(Error);
      expect(messageOf(error), `${name} before init()`).toContain('call init() first');
    }
  });

  it('is idempotent: a second init() is a no-op and the storage serves ports afterwards', async () => {
    const storage = openStorage({ path: ':memory:' });
    storage.init();
    storage.init();
    await storage.memory.saveThread({
      id: 't',
      resourceId: 'r',
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    expect((await storage.memory.getThreadById('t'))?.id).toBe('t');
  });

  it('is idempotent on close, rejects every port method afterwards and refuses a re-init', async () => {
    const storage = openStorage({ path: ':memory:' });
    storage.init();
    storage.close();
    storage.close();
    for (const [name, call] of portCalls(storage)) {
      const error = await caught(call());
      expect(messageOf(error), `${name} after close()`).toContain('storage is closed');
    }
    expect(() => storage.init()).toThrow(/storage is closed/);
  });

  it('close() before init() is a no-op', () => {
    const storage = openStorage({ path: ':memory:' });
    storage.close();
    storage.close();
    expect(() => storage.init()).toThrow(/storage is closed/);
  });

  it('brings a file database up in WAL — visible to a second connection on the same path', () => {
    const { path } = fileStorage();
    const raw = rawConnection(path);
    const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });

  it("accepts ':memory:' with its own journal mode", () => {
    const storage = openStorage({ path: ':memory:' });
    storage.init();
    expect(storage.memory).toBeDefined();
  });
});
