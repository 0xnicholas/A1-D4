/**
 * The cross-process story, simulated with two storage instances on one file (the same thing two
 * processes do): writes on one connection are visible to the other, `compareAndSave` makes the
 * resume de-duplication race safe — the stale writer loses and writes nothing — and the busy
 * timeout holds a lock wait for its configured window before `SQLITE_BUSY` comes back unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowRunSnapshot } from '@oribos/core/workflows';
import { caught, fileStorage, messageOf, openStorage, rawConnection } from './helpers.js';

function snapshot(runId: string, marker: number): WorkflowRunSnapshot {
  return {
    runId,
    status: 'suspended',
    input: { marker },
    stepResults: {},
    position: 1,
  };
}

describe('two storages on one file', () => {
  it('sees each other’s writes through every port', async () => {
    const first = fileStorage();
    const second = openStorage({ path: first.path });
    second.init();

    await first.storage.memory.saveThread({
      id: 't',
      resourceId: 'r',
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
    await first.storage.agentRunSnapshots.save('run-1', {
      runId: 'run-1',
      status: 'suspended',
      messages: [],
      stepCount: 0,
      suspendPayload: { toolCalls: [], awaitingApproval: [] },
    });

    expect((await second.memory.getThreadById('t'))?.updatedAt.getTime()).toBe(2);
    expect((await second.agentRunSnapshots.load('run-1'))?.runId).toBe('run-1');
    expect((await second.agentRunSnapshots.listSuspended()).map((s) => s.runId)).toEqual([
      'run-1',
    ]);
  });

  it('lets exactly one compareAndSave win and makes the stale writer lose without writing', async () => {
    const first = fileStorage();
    const second = openStorage({ path: first.path });
    second.init();

    // Both instances try to claim the same fresh run: the conditional insert is the arbiter.
    expect(await first.storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 1), null)).toBe(true);
    expect(await second.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 2), null)).toBe(false);
    expect(await second.workflowSnapshots.load('run-1')).toEqual(snapshot('run-1', 1));

    // A load-then-CAS cycle: each side loads first, the second instance's expectation is still the
    // fresh-run state, and it wins; the first's earlier expectation is now stale and must lose —
    // no lost update either way.
    const staleExpectation = await first.storage.workflowSnapshots.load('run-1');
    const loaded = await second.workflowSnapshots.load('run-1');
    expect(await second.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 3), loaded)).toBe(true);

    expect(staleExpectation).toEqual(snapshot('run-1', 1));
    expect(await first.storage.workflowSnapshots.compareAndSave('run-1', snapshot('run-1', 4), staleExpectation)).toBe(false);
    expect(await first.storage.workflowSnapshots.load('run-1')).toEqual(snapshot('run-1', 3));
  });

  it('waits out the busy timeout when another connection holds the write lock, then surfaces SQLITE_BUSY', async () => {
    const { storage, path } = fileStorage({ busyTimeoutMs: 200 });
    const raw = rawConnection(path);
    raw.exec('BEGIN IMMEDIATE');

    const started = Date.now();
    const error = await caught(
      storage.memory.saveThread({
        id: 'blocked',
        resourceId: 'r',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    );
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(Error);
    expect(messageOf(error)).toMatch(/locked|busy/i);
    expect(elapsed).toBeGreaterThanOrEqual(100);

    raw.exec('ROLLBACK');
    await storage.memory.saveThread({
      id: 'after',
      resourceId: 'r',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect((await storage.memory.getThreadById('after'))?.id).toBe('after');
  });
});
