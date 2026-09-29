/**
 * Balsa workflow-approval example — one expense report, one approval gate.
 *
 * A scripted, non-interactive run drives one workflow over a real OpenAI model and shows the M3
 * orchestration surface end to end: the operator builder freezing into a flat entry list, the
 * for-loop walker interpreting it, lifecycle events and records side by side, an agent wrapped into
 * a step, and the suspend → snapshot → resume axis that makes a run wait for a human.
 *
 * The acts:
 *
 * 1. **Start** — three front entries run (a `foreach` checking the line items against the per-item
 *    cap through a concurrency gate, a `parallel` running two audits at once, a `branch` picking the
 *    review lane), the agent drafts the approval memo, and the gate step suspends. The run lands
 *    `suspended`; the engine writes a JSON snapshot to the attached store. The act consumes the
 *    run's lifecycle event stream while it happens, then reads the settled envelope.
 * 2. **The snapshot** — what a resume needs: the store's write log (one `running` snapshot per
 *    completed entry, one `suspended` on the signal) and the persisted `{ runId, status, input,
 *    stepResults, position }` itself, with the gate's review question in it.
 * 3. **Resume** — a *fresh* run object over the same runId loads the snapshot, validates the
 *    reviewer's decision against the gate's `resumeSchema`, and re-enters the walk at the recorded
 *    position: the gate re-executes with the decision, the final entry runs, and the workflow
 *    returns its receipt. This is the engine's durable primitive (`load → re-enter`); swapping the
 *    in-memory store for a persistent adapter is what makes it a cross-process story.
 *
 * The script asserts its own payoff: a run that does not suspend at the gate, an empty memo, or a
 * resume that does not reach the receipt exits non-zero instead of printing a happy face.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsa/example-workflow-approval start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsa/example-workflow-approval start
 */
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsa/core';
import { consoleExporter, createTracer } from '@balsa/core/observability';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
} from '@balsa/core/workflows';
import type {
  StepContext,
  WorkflowEntry,
  WorkflowEvent,
  WorkflowSnapshotStore,
} from '@balsa/core/workflows';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** Per-item cap: anything above it needs a policy exception. */
const ITEM_CAP = 700;
/** Report budget: anything above it needs manager sign-off. */
const BUDGET_LIMIT = 2_000;

/** The scripted report: three items, $2,150 — over budget, with one item over the cap. */
const REPORT = [
  { description: 'Flights — Lisbon offsite, economy', amount: 640 },
  { description: 'Hotel — 3 nights, team rate', amount: 1_180 },
  { description: 'Team dinner — 8 people', amount: 330 },
];
/** What the three items add up to — the resumed receipt must replay this from the snapshot. */
const REPORT_TOTAL = 2_150;

// Schemas are Standard Schema dual interfaces (zod@4 speaks them): the engine validates every
// boundary with them — the start input, each step's input, and a resume's resumeData (ADR-0003) —
// and the schema's parsed value *replaces* the raw data.
const expenseItem = z.object({ description: z.string(), amount: z.number() });
const expenseReport = z.array(expenseItem);
/** What `check-item` stamps on each item: over the cap means flagged for policy review. */
const checkedItem = expenseItem.extend({ flagged: z.boolean() });
const checkedReport = z.array(checkedItem);
/** The two concurrent audits on the checked report. */
const policyCheckOut = z.object({
  flagged: z.array(z.string()),
  policy: z.enum(['clean', 'flag']),
});
const budgetCheckOut = z.object({
  total: z.number(),
  budget: z.enum(['within', 'over']),
});
/** What a `parallel` block hands downstream: its arms' outputs keyed by step id. */
const audits = z.object({ 'policy-check': policyCheckOut, 'budget-check': budgetCheckOut });
/** What a branch arm picks. */
const lane = z.object({ lane: z.enum(['auto', 'manager']), reason: z.string() });
/** What a `branch` block hands downstream: the chosen arm's output keyed by arm id (one key set). */
const laneSelection = z.object({ 'route-auto': lane.optional(), 'route-manager': lane.optional() });
/** The briefing the memo needs, assembled once the branch answer is known. */
const briefing = z.object({
  lane: z.enum(['auto', 'manager']),
  reason: z.string(),
  total: z.number(),
  items: checkedReport,
});
const memoOut = z.object({ memo: z.string() });
const gatePayload = z.object({ question: z.string(), memo: z.string() });
const gateResume = z.object({ approved: z.boolean(), note: z.string().optional() });
const decision = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() });
/** The workflow's terminal value: the decided memo, stamped as a receipt. */
const receipt = z.object({
  decision: z.enum(['approved', 'rejected']),
  memo: z.string(),
  total: z.number(),
  note: z.string().optional(),
});

// The composition root is the optional thin assembly point (ADR-0002): one tracer is assembled
// here and handed to the agent built through the app. The workflow takes the same tracer through
// its own `tracer` seam — the composition root has no workflow slot yet (docs/ROADMAP.md M4/M5).
const tracer = createTracer({ exporters: [consoleExporter()] });

const app = createApp({ tracer });

// The model instance comes straight from an AI SDK provider package; no adapter (ADR-0004).
const agent = app.agent({
  name: 'memo-writer',
  instructions:
    'You write short expense approval memos for a finance team: at most two sentences of summary, ' +
    "then exactly one final line starting with 'Recommendation:'. Plain text, no markdown.",
  model: openai.chat('gpt-4o-mini'),
});

/** The prompt the memo step hands the model — the briefing, rendered for it. */
function memoPrompt(input: z.infer<typeof briefing>): string {
  const items = input.items
    .map((item) => `- ${item.description}: $${item.amount}${item.flagged ? ' (flagged)' : ''}`)
    .join('\n');
  return [
    `Expense report for the ${input.lane} lane. Route rationale: ${input.reason}.`,
    `Items:\n${items}`,
    `Total: $${input.total}.`,
  ].join('\n');
}

/**
 * The store is a port: any object with `load` / `save` (`WorkflowSnapshotStore`, JSON-only). This
 * one decorates the core's in-memory default with a write log, so the engine's persistence ritual
 * is visible — one `running` snapshot per completed entry, one `suspended` on the signal, one
 * terminal. A real deployment swaps the in-memory default for a persistent adapter.
 */
function recordingStore(): { readonly store: WorkflowSnapshotStore; readonly writes: string[] } {
  const inner = createInMemorySnapshotStore();
  const writes: string[] = [];
  return {
    writes,
    store: {
      load: (id) => inner.load(id),
      save: (id, snapshot) => {
        writes.push(`${snapshot.status.padEnd(9)} position=${snapshot.position}`);
        return inner.save(id, snapshot);
      },
    },
  };
}

const { store, writes } = recordingStore();

/**
 * Reads a recorded step output back as its step's schema says it: `getStepResult` hands out the raw
 * JSON record, the schema re-narrows it. This is the framework's cross-step sharing — there is no
 * state blackboard.
 */
function recorded<T>(ctx: Pick<StepContext, 'getStepResult'>, stepId: string, schema: z.ZodType<T>): T {
  return schema.parse(ctx.getStepResult(stepId));
}

// ── Entries 1–3: the front — foreach, parallel, branch ─────────────────────────────────────────

/** Entry 1 — `foreach`: check each item against the per-item cap, flagging the over-cap ones. */
const checkItem = createStep({
  id: 'check-item',
  inputSchema: expenseItem,
  outputSchema: checkedItem,
  execute: ({ inputData }) => ({ ...inputData, flagged: inputData.amount > ITEM_CAP }),
});

/** Entry 2a — `parallel` arm: policy audit over the checked items. */
const policyCheck = createStep({
  id: 'policy-check',
  inputSchema: checkedReport,
  outputSchema: policyCheckOut,
  execute: ({ inputData }): z.infer<typeof policyCheckOut> => {
    const flagged = inputData.filter((item) => item.flagged).map((item) => item.description);
    return { flagged, policy: flagged.length === 0 ? 'clean' : 'flag' };
  },
});

/** Entry 2b — `parallel` arm: budget audit over the same items. Both arms see the same tip. */
const budgetCheck = createStep({
  id: 'budget-check',
  inputSchema: checkedReport,
  outputSchema: budgetCheckOut,
  execute: ({ inputData }): z.infer<typeof budgetCheckOut> => {
    const total = inputData.reduce((sum, item) => sum + item.amount, 0);
    return { total, budget: total > BUDGET_LIMIT ? 'over' : 'within' };
  },
});

/** Entry 3a — `branch` arm: the manager lane (over budget or flagged items). */
const routeManager = createStep({
  id: 'route-manager',
  inputSchema: audits,
  outputSchema: lane,
  execute: ({ inputData }): z.infer<typeof lane> => ({
    lane: 'manager',
    reason:
      inputData['budget-check'].budget === 'over'
        ? `total $${inputData['budget-check'].total} is over the $${BUDGET_LIMIT} budget`
        : `${inputData['policy-check'].flagged.length} item(s) need a policy exception`,
  }),
});

/** Entry 3b — `branch` arm: the auto lane. Both arms share their IO schemas by contract. */
const routeAuto = createStep({
  id: 'route-auto',
  inputSchema: audits,
  outputSchema: lane,
  execute: (): z.infer<typeof lane> => ({ lane: 'auto', reason: 'within budget, no flagged items' }),
});

// ── Entries 4–7: the main axis — agent step, approval gate, receipt ────────────────────────────

/** Entry 4 — collapse the branch's one-of keyed answer into the briefing the memo needs. */
const pickLane = createStep({
  id: 'pick-lane',
  inputSchema: laneSelection,
  outputSchema: briefing,
  execute: (ctx) => {
    const picked = ctx.inputData['route-manager'] ?? ctx.inputData['route-auto'];
    if (picked === undefined) {
      throw new Error('branch matched no lane — the condition table must cover every request');
    }
    const items = recorded(ctx, 'check-item', checkedReport);
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    return { lane: picked.lane, reason: picked.reason, total, items };
  },
});

/**
 * Entry 5 — the agent, wrapped into a step by hand. The wrapper is one line by design
 * (`docs/architecture/workflows.md`「定义表面」): there is no `createStep(agent)` overload — a step
 * that calls the agent is just a step whose `execute` returns what the model produced.
 */
const draftMemo = createStep({
  id: 'draft-memo',
  inputSchema: briefing,
  outputSchema: memoOut,
  execute: async ({ inputData }) => ({
    memo: (await agent.generate(memoPrompt(inputData))).text.trim(),
  }),
});

/**
 * Entry 6 — the approval gate. First pass: no `resumeData`, so the step suspends the run and the
 * engine unwinds with a JSON snapshot (position = this entry). Second pass: a resume supplied the
 * reviewer's decision, validated against `resumeSchema` before `execute` ever sees it.
 */
const approvalGate = createStep({
  id: 'approval-gate',
  inputSchema: memoOut,
  outputSchema: decision,
  resumeSchema: gateResume,
  suspendSchema: gatePayload,
  execute: (ctx): z.infer<typeof decision> => {
    // suspend() throws the suspend control signal and never comes back — the `return` is what the
    // control flow reads as.
    if (ctx.resumeData === undefined) {
      return ctx.suspend({ question: 'Approve the memo below?', memo: ctx.inputData.memo });
    }
    return { decision: ctx.resumeData.approved ? 'approved' : 'rejected', note: ctx.resumeData.note };
  },
});

/** Entry 7 — the resumed walk continues here: stamp the decided memo with its total. */
const finalize = createStep({
  id: 'finalize',
  inputSchema: decision,
  outputSchema: receipt,
  execute: (ctx) => {
    const { memo } = recorded(ctx, 'draft-memo', memoOut);
    const { total } = recorded(ctx, 'pick-lane', briefing);
    return { decision: ctx.inputData.decision, memo, total, note: ctx.inputData.note };
  },
});

/**
 * The definition. Each operator pushes one flat `{ type, … }` entry; `.commit()` freezes the list
 * — execution is a `for` loop over it, not a DAG.
 */
const workflow = createWorkflow({
  id: 'expense-approval',
  inputSchema: expenseReport,
  outputSchema: receipt,
  tracer,
  storage: store,
})
  .foreach(checkItem, { concurrency: 2 })
  .parallel([policyCheck, budgetCheck])
  .branch([
    [
      (ctx) => ctx.inputData['budget-check'].budget === 'over' || ctx.inputData['policy-check'].policy === 'flag',
      routeManager,
    ],
    [() => true, routeAuto],
  ])
  .then(pickLane)
  .then(draftMemo)
  .then(approvalGate)
  .then(finalize)
  .commit();

// ── The scripted session ───────────────────────────────────────────────────────────────────────

/** A narration header between acts of the scripted session. */
function act(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

/** One line of the flat entry list: what the walker will interpret, in order. */
function entrySummary(entry: WorkflowEntry): string {
  switch (entry.type) {
    case 'then':
      return `then      ${entry.step.id}`;
    case 'parallel':
      return `parallel  [${entry.steps.map((step) => step.id).join(', ')}]`;
    case 'branch':
      return `branch    [${entry.branches.map(([, step]) => step.id).join(' | ')}]`;
    case 'foreach':
      return `foreach   ${entry.step.id} (concurrency ${entry.concurrency})`;
    case 'dowhile':
      return `dowhile   ${entry.step.id}`;
    case 'dountil':
      return `dountil   ${entry.step.id}`;
    case 'sleep':
      return `sleep     ${String(entry.duration)}`;
  }
}

/** JSON with a hard cap, for one-line event printouts. */
function clip(value: unknown, max = 64): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One compact line per lifecycle event — the execution view (a `foreach` iteration and a `parallel`
 * arm each cross their step's boundary; the snapshot records stay aggregated by block).
 */
function eventLine(event: WorkflowEvent): string {
  switch (event.type) {
    case 'run-start':
      return `[event] run-start  ${event.workflowId}  input: ${clip(event.input)}`;
    case 'step-start':
      return `[event] step-start ${event.stepId}  ${clip(event.input)}`;
    case 'step-end':
      return `[event] step-end   ${event.stepId}  ${event.status}${event.output === undefined ? '' : `  ${clip(event.output)}`}`;
    case 'run-end':
      return `[event] run-end    ${event.status}${event.output === undefined ? '' : `  ${clip(event.output)}`}`;
  }
}

/** Reads a string field off an unknown JSON value — step outputs and suspend payloads arrive as JSON. */
function stringField(value: unknown, field: string): string {
  if (typeof value === 'object' && value !== null && field in value) {
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

const runId = 'expense-2026-0417';

console.log('workflow-approval — one expense report, one approval gate.');
console.log(`\nDefinition '${workflow.id}' — ${workflow.entries.length} flat entries:`);
for (const [index, entry] of workflow.entries.entries()) {
  console.log(`  ${index}  ${entrySummary(entry)}`);
}

act('Act 1 — start: the front runs, the memo is drafted, the gate suspends');
// `start` returns the output object: `for await` walks the lifecycle events as they happen and
// `result` settles on the outcome envelope — one execution, two consumptions.
const run = workflow.createRun({ runId });
const out = run.start({ inputData: REPORT });
for await (const event of out) {
  console.log(eventLine(event));
}
const firstSegment = await out.result;

// The gate is the example's axis: a run that walked past it (a broken condition, a changed
// definition) has no snapshot to resume and no story to tell — say so, don't print a happy face.
if (firstSegment.status !== 'suspended' || firstSegment.stepId !== 'approval-gate') {
  const where = firstSegment.status === 'suspended' ? `'${firstSegment.stepId}'` : `'${firstSegment.status}'`;
  console.error(`Expected the run to suspend at 'approval-gate', but it stopped at ${where}.`);
  process.exit(1);
}
const memo = stringField(firstSegment.stepResults['draft-memo']?.output, 'memo').trim();
if (memo === '') {
  console.error(
    'The draft memo came back empty — the workflow has nothing to gate on. Re-run the example.',
  );
  process.exit(1);
}

console.log(`\nRun '${runId}' suspended at '${firstSegment.stepId}'. The reviewer is asked:`);
const question = stringField(firstSegment.stepResults['approval-gate']?.suspendPayload, 'question');
console.log(`  "${question}"`);
console.log(`\nDraft memo:\n${memo}`);

act('Act 2 — the snapshot: what a resume needs');
console.log(`Store writes so far (${writes.length}):`);
for (const write of writes) console.log(`  ${write}`);

// The engine persists the run at fixed moments — every completed entry, the suspend signal, the
// terminal state — and never through hooks. `load` returns the JSON-only state a resume re-enters
// from: the run identity, status, validated start input, per-step records and the flat-entry
// position of the suspended step.
const snapshot = await store.load(runId);
if (snapshot === null || snapshot.status !== 'suspended') {
  console.error(`Expected a suspended snapshot for '${runId}', got ${snapshot === null ? 'none' : snapshot.status}.`);
  process.exit(1);
}
console.log(`\nstore.load('${runId}') — one JSON value:`);
console.log(`  status       ${snapshot.status}`);
console.log(`  position     ${snapshot.position}   ← the gate entry: resume re-enters here`);
console.log(`  input        ${clip(snapshot.input, 120)}`);
console.log(`  traceId      ${snapshot.traceId ?? '(untraced)'}   ← the resumed segment continues this trace`);
console.log('  stepResults  (records aggregate by entry; a foreach or parallel block is one record)');
for (const [stepId, record] of Object.entries(snapshot.stepResults)) {
  console.log(`    ${stepId.padEnd(14)} ${record.status}`);
}
const gatePayloadInSnapshot = snapshot.stepResults['approval-gate']?.suspendPayload;
console.log(`\n  stepResults['approval-gate'].suspendPayload =`);
console.log(`    ${JSON.stringify(gatePayloadInSnapshot, null, 2).replaceAll('\n', '\n    ')}`);

act('Act 3 — resume: a fresh run object over the same runId continues the walk');
// The durable path in miniature: nothing in memory from the starting run object is needed — the
// store holds the whole state. `resume` loads the snapshot, validates `resumeData` against the
// gate's `resumeSchema`, and re-enters the same for-loop at the recorded position. The resumed
// segment reports through this promise, not through the start-time event stream.
const writesBeforeResume = writes.length;
const continuation = workflow.createRun({ runId });
const outcome = await continuation.resume({
  step: 'approval-gate',
  resumeData: { approved: true, note: 'Approved — the hotel rate is within the offsite allowance.' },
});

if (outcome.status !== 'success') {
  console.error(`Expected the resumed run to succeed, but it ended '${outcome.status}'.`);
  process.exit(1);
}
// The receipt's numbers are the replay payoff: `finalize` reads `pick-lane`'s and `draft-memo`'s
// records back out of the resumed walk, so a broken snapshot replay shows up right here.
if (outcome.output.total !== REPORT_TOTAL || outcome.output.decision !== 'approved') {
  console.error(
    `Expected a receipt of $${REPORT_TOTAL} marked 'approved', got ${JSON.stringify(outcome.output)}.`,
  );
  process.exit(1);
}

console.log(`Store writes after resume (${writes.length - writesBeforeResume}):`);
for (const write of writes.slice(writesBeforeResume)) console.log(`  ${write}`);
console.log(`\nRun '${runId}' — receipt:`);
console.log(JSON.stringify(outcome.output, null, 2));

console.log(
  `\nDone — the gate re-ran with the decision, the walk continued to 'finalize', and the run ` +
    `reached 'success' without replaying a single completed entry.`,
);
