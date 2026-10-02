/**
 * Balsa sqlite-resume example — a durable run that outlives the process that made it.
 *
 * One script, two processes, one SQLite file (`@balsats/sqlite`). The parent re-execs itself as a
 * **worker**: the worker builds the refund desk, the model asks for the gated `issueRefund`, the
 * run suspends and its loop snapshot lands in SQLite — then the worker exits, and with it every
 * in-process trace of the run. The parent opens its **own connection** to the same file and shows
 * the four ports across the process boundary:
 *
 * 1. **The worker suspends** — `durable.stream()` settles `'suspended'`, nothing executed, and the
 *    run's identity goes to stdout as one machine-readable line before the process ends.
 * 2. **A new process sees everything** — `listSuspended()` finds the run the dead process left
 *    behind; `load()` returns the JSON-only snapshot a resume re-enters from; the message history
 *    the worker's run saved is in SQLite too (the app's `storage.memory` slot).
 * 3. **The parent resumes** — `resume(runId, { approved: true })` loads the snapshot from the file,
 *    replays the held call (this process's ledger moves), and the run finishes on the model's
 *    report. The consumed snapshot is then dropped — retention cleanup is the application's.
 * 4. **The negative space, asserted** — resuming a run with no snapshot rejects; a second
 *    connection's `compareAndSave` loses to the winner and writes nothing (the cross-process
 *    resume de-duplication premise); a due schedule fires out of the same file.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsats/example-sqlite-resume start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsats/example-sqlite-resume start
 *
 * The database file defaults to a fresh temp directory; set `BALSA_SQLITE_EXAMPLE_DB` to keep it.
 * The script self-asserts (`node:assert/strict`): any violated payoff exits 1.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsats/core';
import { createTool } from '@balsats/core/tools';
import { createSqliteStorage } from '@balsats/sqlite';
import type { SqliteStorage } from '@balsats/sqlite';
import type { DurableAgent } from '@balsats/core/durable-agent';
import type { AgentMemoryOptions } from '@balsats/core/agent';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** The customer request both processes work on, and the thread its history lives in. */
const REQUEST =
  'Customer message: "You charged me twice for order A-4471 — please refund the $129 overcharge."';
const THREAD: AgentMemoryOptions = { thread: 'refund-A-4471', resource: 'customer-4471' };

/** The worker's machine-readable hand-off on stdout; narration goes to stderr so stdout stays clean. */
const RESULT_PREFIX = 'SQLITE_RESUME_RESULT=';

/** The SQLite file: the parent picks one, the worker is handed it. */
function databasePath(): string {
  const fromEnv = process.env.BALSA_SQLITE_EXAMPLE_DB;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(mkdtempSync(join(tmpdir(), 'balsa-sqlite-resume-')), 'balsa.db');
}

/** The gated tool's ledger — what "money moves" means in this example. */
function issueRefundTool(ledger: number[]) {
  return createTool({
    description:
      'Issue a refund for an order. Money leaves the account and cannot be recalled — this call ' +
      'requires a human approval before it executes.',
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    execute: ({ orderId, amount }) => {
      ledger.push(amount);
      return { refunded: true, orderId, amount };
    },
  });
}

/** The whole composition root, built fresh in each process: the same file, two connections. */
function desk(storage: SqliteStorage, ledger: number[]): { durable: DurableAgent } {
  const app = createApp({
    // The composition root distributes the SQLite-backed memory slot; the durable wrapper takes
    // the snapshot store (the `storage.durableAgent` slot), so suspend/resume persists to the file.
    storage: {
      memory: storage.memory,
      durableAgent: storage.agentRunSnapshots,
      schedules: storage.schedules,
    },
  });
  const agent = app.agent({
    name: 'refund-desk',
    instructions:
      'You are the refund desk. When asked for a refund, call issueRefund with the order id and ' +
      'the amount, then report the outcome in one short sentence.',
    model: openai.chat('gpt-4o-mini'),
    tools: { issueRefund: issueRefundTool(ledger) },
  });
  return { durable: app.durableAgent({ agent, approval: { tools: ['issueRefund'] } }) };
}

// ── Worker: run to the suspension, hand the run id over, exit ────────────────────────────────────

async function worker(): Promise<void> {
  const path = process.env.BALSA_SQLITE_EXAMPLE_DB;
  assert.ok(path !== undefined && path !== '', 'the worker needs BALSA_SQLITE_EXAMPLE_DB');
  const storage = createSqliteStorage({ path });
  storage.init();
  try {
    const ledger: number[] = [];
    const { durable } = desk(storage, ledger);

    const run = durable.stream(REQUEST, { memory: THREAD });
    for await (const _chunk of run) {
      // Drain the run's own stream; the terminal values below are what this process waits on.
    }
    const finishReason = await run.finishReason;
    const suspendPayload = await run.suspendPayload;

    assert.equal(finishReason, 'suspended', 'the gate must suspend the run');
    assert.ok(suspendPayload !== undefined, 'a suspended run carries its suspend payload');
    assert.ok(suspendPayload.awaitingApproval.length > 0, 'the held call awaits the decision');
    assert.deepEqual(ledger, [], 'nothing executes while the run is suspended');

    process.stdout.write(
      `${RESULT_PREFIX}${JSON.stringify({
        runId: run.runId,
        held: suspendPayload.toolCalls.map((call) => call.toolName),
      })}\n`,
    );
  } finally {
    storage.close();
  }
}

// ── Parent: the worker runs, then a brand-new process picks the run up ────────────────────────────

async function parent(): Promise<void> {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  console.log(`sqlite-resume — one durable run, two processes, one file:\n  ${path}`);

  console.log('\n──────── Act 1 — the worker process runs the desk and suspends ────────');
  const worker = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, BALSA_SQLITE_EXAMPLE_ROLE: 'worker', BALSA_SQLITE_EXAMPLE_DB: path },
      encoding: 'utf8',
    },
  );
  assert.equal(worker.status, 0, `worker exited ${worker.status}:\n${worker.stderr}`);
  const resultLine = worker.stdout.split('\n').find((line) => line.startsWith(RESULT_PREFIX));
  assert.ok(resultLine !== undefined, `worker printed no result line:\n${worker.stdout}`);
  const handOff = JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as {
    runId: string;
    held: string[];
  };
  console.log(`  worker exited; the held call [${handOff.held.join(', ')}] never ran there.`);
  console.log(`  runId ${handOff.runId}  ← all that survives the process is what this id names`);

  console.log('\n──────── Act 2 — a new process opens the same file ────────');
  const storage = createSqliteStorage({ path });
  storage.init();
  try {
    const suspended = await storage.agentRunSnapshots.listSuspended();
    assert.deepEqual(
      suspended.map((snapshot) => snapshot.runId),
      [handOff.runId],
      'listSuspended() must find the run the dead process left',
    );
    const snapshot = await storage.agentRunSnapshots.load(handOff.runId);
    assert.ok(snapshot !== null, 'the snapshot is in the file, not in memory');
    assert.equal(snapshot.status, 'suspended');
    assert.ok(snapshot.messages.length >= 1, 'the snapshot carries the conversation the run stopped at');

    // A suspended step never completed, and memory saves once per completed step — so at this
    // point the run's state is the snapshot, and the message history is still empty. The history
    // lands in the same file when the resumed step completes (Act 3).
    const historyBefore = await storage.memory.listMessages({ threadId: 'refund-A-4471' });
    assert.equal(historyBefore.length, 0, 'a suspended step writes no message history');
    console.log(
      `  listSuspended() → ${suspended.length} run;  load('${handOff.runId}') → stepCount ` +
        `${snapshot.stepCount}, ${snapshot.suspendPayload.toolCalls.length} held call(s), ` +
        `${snapshot.messages.length} snapshot message(s)`,
    );
    console.log('  message history  → 0 (the run stopped before a step completed)');

    console.log('\n──────── Act 3 — resume in this process: the held call executes here ────────');
    const ledger: number[] = [];
    const { durable } = desk(storage, ledger);
    const outcome = await durable.resume(handOff.runId, { approved: true, memory: THREAD });
    assert.equal(outcome.finishReason, 'stop', 'the resumed run must finish');
    assert.deepEqual(ledger, [129], 'the approved refund executes — in this process');
    console.log(`  resume(approved: true) → '${outcome.finishReason}';  ledger ${JSON.stringify(ledger)}`);
    console.log(`  desk reply: ${outcome.text.trim()}`);

    // The step completed this time, so its memory save ran — through the same SQLite file.
    const history = await storage.memory.listMessages({ threadId: 'refund-A-4471', order: 'asc' });
    assert.ok(history.length >= 2, 'the completed step settled its history in the file');
    console.log(
      `  memory history   → ${history.length} message(s) for thread 'refund-A-4471' ` +
        '← the completed step saved them',
    );

    await storage.agentRunSnapshots.deleteSnapshot(handOff.runId);
    assert.equal(await storage.agentRunSnapshots.load(handOff.runId), null);
    console.log('  deleteSnapshot() → the consumed snapshot is gone (retention is the application\'s)');

    console.log('\n──────── Act 4 — the negative space, asserted ────────');
    await assert.rejects(
      () => durable.resume('missing-run', { approved: true }),
      /has no snapshot/,
      'resuming a run the store never saw must reject',
    );
    console.log('  resume(missing-run) → rejected, as it must');

    // The cross-process resume de-duplication premise: two connections claim one run, exactly one
    // compareAndSave wins and the loser writes nothing (the caller supplies `expected` from load).
    const other = createSqliteStorage({ path });
    other.init();
    try {
      const claim = { runId: 'run-42', status: 'running', input: null, stepResults: {}, position: 0 } as const;
      const first = await storage.workflowSnapshots.compareAndSave('run-42', claim, null);
      const second = await other.workflowSnapshots.compareAndSave(
        'run-42',
        { ...claim, position: 7 },
        null,
      );
      assert.equal(first, true, 'the first claimant wins');
      assert.equal(second, false, 'the second claimant loses and writes nothing');
      assert.deepEqual(await other.workflowSnapshots.load('run-42'), claim, 'the loser left no trace');
      await storage.workflowSnapshots.deleteSnapshot('run-42');
      console.log(`  compareAndSave race → ${first} / ${second}; the loser wrote nothing`);
    } finally {
      other.close();
    }

    await storage.schedules.save({
      id: 'refund-follow-up',
      // Due immediately: the example's stand-in for "the host re-anchors records from its own
      // schedule definitions" — the `next` function stays in the host, only the record lands here.
      nextFireAt: Date.now() - 1,
      enabled: true,
      target: { agent: 'refund-desk', input: 'Check that the refund settled.' },
      metadata: { orderId: 'A-4471' },
    });
    const due = await storage.schedules.listDue(new Date());
    assert.deepEqual(due.map((record) => record.id), ['refund-follow-up']);
    console.log(`  schedules.listDue() → [${due.map((record) => record.id).join(', ')}]`);

    console.log(
      '\n✓ Cross-process suspend/resume on @balsats/sqlite: the snapshot, the history and the ' +
        'schedule all outlived the process that wrote them.',
    );
  } finally {
    storage.close();
  }
}

if (process.env.BALSA_SQLITE_EXAMPLE_ROLE === 'worker') {
  await worker();
} else {
  await parent();
}
