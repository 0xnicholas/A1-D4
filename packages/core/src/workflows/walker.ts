import { resolveDynamicArgument } from '../agent/dynamic.js';
import type { RequestContext } from '../agent/types.js';
import type { StandardSchema } from '../standard-schema.js';
import { abortableSleep, throwIfAborted } from './abort.js';
import type {
  BranchEntry,
  DountilEntry,
  DowhileEntry,
  ForeachEntry,
  ParallelEntry,
  SleepEntry,
  WorkflowEntry,
} from './entry.js';
import type {
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshotStore,
  WorkflowStepResultSnapshot,
} from './snapshot.js';
import type { Step, StepContext } from './step.js';
import { isSuspendSignal, SuspendSignal } from './suspend.js';
import { validateResumeData, validateRunInput, validateStepInput } from './validate.js';
import type { Workflow } from './workflow.js';
import type { WorkflowRunOutcome } from './run.js';
import { executeWithRetries } from './retry.js';

/**
 * The semantic kernel (`docs/architecture/workflows.md`「Workflow 与 builder」「Run」「控制流算子」
 * 「suspend/resume 与快照」): a `for` loop over the workflow's flat entry list, interpreting entry by
 * entry — there is no DAG. Each entry receives the previous entry's output (the run's input for the
 * first one) and its output becomes the next entry's value: `then` pipes a step's output through,
 * `parallel` runs every step concurrently and keys the outputs by step id, `branch` runs the first
 * step whose condition is truthy and keys the output the same way, `foreach` maps an array through
 * one step and collects an array, `dowhile` / `dountil` fold a step until their condition stops
 * holding, and `sleep` waits in process for a resolved duration.
 *
 * Running is also suspending: a step's `suspend(payload)` throws the control signal up to this loop,
 * which records the step as `suspended`, writes the run's snapshot and returns the `suspended`
 * outcome — the run unwinds, and `run.resume` re-enters this same loop from the snapshot's
 * `position`. Snapshots are written at fixed points, never through hooks: after every completed entry
 * when storage is attached, at a suspend, and at the terminal state.
 *
 * The walker is an async generator: it currently completes with the run's outcome and yields
 * nothing — the lifecycle events (run-start / step-start / step-end / run-end) are delivered
 * through the yields, landing with #52.
 */

/** What a run reads of its workflow: the identity, the start input schema, the storage slot and the frozen entries. */
export type WorkflowDefinition<TInputSchema extends StandardSchema = StandardSchema> = Pick<
  Workflow<TInputSchema>,
  'id' | 'inputSchema' | 'entries'
> & {
  /** Snapshot store attached to the definition; absent = the run keeps its snapshots in memory. */
  readonly storage?: WorkflowSnapshotStore | undefined;
};

/**
 * The point a resumed walk re-enters from (`docs/architecture/workflows.md`「suspend/resume 与快照」):
 * what the snapshot says about the suspension — the suspended step, its raw `resumeData` (validated
 * here, at the third IO boundary), the entry position (`startIdx` equivalent) and the records the
 * completed part of the run left behind.
 */
export interface WalkResumePoint {
  /** The suspended step the run comes back to. */
  readonly stepId: string;
  /** The caller's resume data; validated against the step's `resumeSchema` before anything runs. */
  readonly resumeData: unknown;
  /** The entry index to re-enter the loop from. */
  readonly position: number;
  /** The snapshot's per-step records: the tip is rebuilt from them, never by re-running entries. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
}

/** One walk's outer state: the run's identity, its input, the store it writes and the records it keeps. */
export interface WalkOptions {
  /** Identity of the run being walked. */
  readonly runId: string;
  /** The run's start input, `inputData` of the first entry. */
  readonly inputData: unknown;
  /** The run's request context — the same object every step receives. */
  readonly requestContext: RequestContext;
  /** Cancellation, checked before every entry and propagated into every step. */
  readonly signal: AbortSignal;
  /** The snapshot store the walk writes to: the attached one, or the run's in-memory default. */
  readonly storage: WorkflowSnapshotStore;
  /**
   * Whether a snapshot follows every completed entry (`running`, `position` = the next entry).
   * Only worth writing when a real store is attached — an in-memory store dies with the process.
   */
  readonly persistStepBoundaries: boolean;
  /** Present on a resumed walk: re-enter at this point instead of starting from the run input. */
  readonly resume?: WalkResumePoint | undefined;
}

/**
 * The walk's mutable state, threaded through the helpers below: the definition and run identity the
 * helpers need, the write policy, and the record table the walk carries (seeded from a resumed
 * snapshot when there is one).
 */
interface WalkState {
  readonly workflow: WorkflowDefinition;
  /** Identity of the run being walked — snapshots and errors carry it. */
  readonly runId: string;
  /** The run's request context — the same object every step receives. */
  readonly requestContext: RequestContext;
  /** Cancellation, checked before every entry and propagated into every step. */
  readonly signal: AbortSignal;
  /** The snapshot store the walk writes to: the attached one, or the run's in-memory default. */
  readonly storage: WorkflowSnapshotStore;
  /** Whether a `running` snapshot follows every completed entry (only worth it with a real store). */
  readonly persistStepBoundaries: boolean;
  /** Per-step records, keyed by step id — the run's stepResults, and the snapshot's body. */
  readonly stepResults: Record<string, WorkflowStepResultSnapshot>;
  /** The run input as it entered the walk: the validated value (defaults / transforms applied). */
  input: unknown;
  /** The step that receives `resumeData` on this walk; cleared once its entry has run. */
  resumingStepId: string | undefined;
  /** The validated resume data for `resumingStepId`. */
  resumeData: unknown;
}

/**
 * Walks a committed workflow: validates the walk's entry boundary (the run's start input on a first
 * pass; the snapshot's resume point and `resumeData` on a resume), then interprets every entry in
 * order. Completes with the run's outcome — `success`, or `suspended` when a step raised the suspend
 * signal; throws when the run fails at any boundary.
 */
export async function* walk(
  workflow: WorkflowDefinition,
  options: WalkOptions,
): AsyncGenerator<never, WorkflowRunOutcome, void> {
  const state: WalkState = {
    workflow,
    runId: options.runId,
    requestContext: options.requestContext,
    signal: options.signal,
    storage: options.storage,
    persistStepBoundaries: options.persistStepBoundaries,
    // A resumed walk continues the suspended run's records: prior steps stay visible to
    // `getStepResult`, and the resumed step replaces its own `suspended` record when it completes.
    stepResults: options.resume === undefined ? {} : { ...options.resume.stepResults },
    input: options.inputData,
    resumingStepId: undefined,
    resumeData: undefined,
  };

  // Cancellation comes first at the start boundary: a run whose signal is already aborted does
  // nothing at all — not even validation, and not even a snapshot write.
  throwIfAborted(options.signal);

  // These two boundaries — the start input, and a resume's position / target / resumeData — sit
  // outside the failure path below: a rejected start means the run never began, and a rejected
  // resume must leave the suspended snapshot untouched so a corrected resume can still find it.
  let value: unknown;
  let position: number;
  if (options.resume === undefined) {
    // The run's start input is the first boundary: its validated value replaces the raw input
    // (defaults / transforms apply), and a rejection here means the run never starts.
    value = await validateRunInput(workflow.id, workflow.inputSchema, options.inputData);
    state.input = value;
    position = 0;
  } else {
    ({ value, position } = await enterResume(state, options.resume));
  }

  try {
    for (; position < workflow.entries.length; position += 1) {
      const entry = workflow.entries[position]!;
      throwIfAborted(options.signal);
      try {
        value = await runEntry(state, entry, value);
      } catch (error) {
        if (!isSuspendSignal(error)) throw error;
        if (entry.type !== 'then' || entry.step.id !== error.stepId) {
          throw unsupportedSuspend(workflow.id, entry, error);
        }
        // The step's record was written `suspended` by `runAndRecordStep`; the snapshot pins the
        // entry to re-enter from (its input is rebuilt from the records around it, never stored),
        // and the run hands its caller the suspended outcome.
        await persist(state, 'suspended', position);
        return { status: 'suspended', stepId: error.stepId, stepResults: state.stepResults };
      }
      // The resumed step has run: resumeData belongs to that step alone, later entries see a
      // normal pass (`undefined`).
      state.resumingStepId = undefined;
      state.resumeData = undefined;
      // A step that ignored the abort at least cannot let the run succeed: the boundary after it
      // re-checks, so cancellation always lands the run in `failed` (AbortError).
      throwIfAborted(options.signal);
      if (state.persistStepBoundaries) await persist(state, 'running', position + 1);
    }
  } catch (error) {
    // The run failed: fix the terminal state for the store, but never let a store failure replace
    // the run's own error — that error is the truth the caller was promised.
    try {
      await persist(state, 'failed', position);
    } catch {
      // Best effort only: the store is failing too, and the run's error still surfaces below.
    }
    throw error;
  }

  await persist(state, 'success', workflow.entries.length);
  return { status: 'success', output: value, stepResults: state.stepResults };
}

/**
 * Interprets one entry: the dispatch the walk's `for` loop runs (`docs/architecture/workflows.md`
 * 「控制流算子」). `sleep` consumes and produces nothing, so it hands the tip straight back.
 */
async function runEntry(state: WalkState, entry: WorkflowEntry, value: unknown): Promise<unknown> {
  switch (entry.type) {
    case 'then':
      // The one entry whose suspend the run can act on: a `then` step's suspend records the step
      // and suspends the run (every other entry shape drops the record — see `runAndRecordStep`).
      return runAndRecordStep(state, entry.step, value, true);
    case 'parallel':
      return runParallel(state, entry, value);
    case 'branch':
      return runBranch(state, entry, value);
    case 'foreach':
      return runForeach(state, entry, value);
    case 'dowhile':
    case 'dountil':
      return runLoop(state, entry, value);
    case 'sleep':
      await runSleep(state, entry);
      return value;
    default: {
      // Every entry type of the spec is handled above; this guards a hand-built definition whose
      // entries were cast past the types (`createWorkflowRun` takes a definition directly).
      const { type } = entry as { readonly type: string };
      throw new Error(`workflow "${state.workflow.id}": unknown workflow entry type "${type}"`);
    }
  }
}

/**
 * Written at every fixed persistence point (`docs/architecture/workflows.md`「suspend/resume 与
 * 快照」): a fresh table each time — records are replaced, never mutated, so a shallow copy is
 * enough — with the run's validated input and the entry position to re-enter from.
 */
async function persist(state: WalkState, status: WorkflowRunStatus, position: number): Promise<void> {
  const snapshot: WorkflowRunSnapshot = {
    runId: state.runId,
    status,
    input: state.input,
    stepResults: { ...state.stepResults },
    position,
  };
  await state.storage.save(state.runId, snapshot);
}

/**
 * Prepares a resumed walk: checks the snapshot's resume point against the definition, validates the
 * `resumeData` (the third fixed IO boundary) and rebuilds the tip value by replaying the completed
 * entries from the snapshot's records — nothing re-executes, and the conditions of the entries the
 * run already passed are not evaluated again.
 */
async function enterResume(
  state: WalkState,
  resume: WalkResumePoint,
): Promise<{ readonly value: unknown; readonly position: number }> {
  const { workflow } = state;
  // The target first: the snapshot must be suspended at the step `resume` names. Naming a
  // different step is a caller bug, and the snapshot knows which step is waiting — say so.
  if (state.stepResults[resume.stepId]?.status !== 'suspended') {
    const suspended = Object.entries(state.stepResults).find(
      ([, record]) => record.status === 'suspended',
    );
    if (suspended !== undefined) {
      throw new Error(
        `run "${state.runId}" suspended at step "${suspended[0]}" — resume() was asked for step "${resume.stepId}".`,
      );
    }
    throw new Error(
      `workflow "${workflow.id}": the snapshot has no suspended record for step "${resume.stepId}" — it cannot be resumed`,
    );
  }
  const entry = workflow.entries[resume.position];
  if (entry === undefined) {
    throw new Error(
      `workflow "${workflow.id}": the snapshot's position ${resume.position} is outside the entry list — the definition and the snapshot do not match`,
    );
  }
  if (entry.type !== 'then' || entry.step.id !== resume.stepId) {
    throw new Error(
      `workflow "${workflow.id}": step "${resume.stepId}" cannot be resumed from position ${resume.position} — suspend/resume supports a step in a top-level then entry only`,
    );
  }
  state.resumeData = await validateResumeData(workflow.id, entry.step, resume.resumeData);
  state.resumingStepId = resume.stepId;
  return { value: replayEntries(state, resume.position), position: resume.position };
}

/**
 * Rebuilds the tip value entering entry `until` from the snapshot's records — the completed entries
 * of a suspended run, interpreted without executing anything. Sleeps pass the value through, so they
 * replay to their predecessor's value.
 */
function replayEntries(state: WalkState, until: number): unknown {
  let value = state.input;
  for (let index = 0; index < until; index += 1) {
    value = replayEntry(state, state.workflow.entries[index]!, value);
  }
  return value;
}

/** One completed entry's output, reconstructed from its step records — pure bookkeeping, no execution. */
function replayEntry(state: WalkState, entry: WorkflowEntry, value: unknown): unknown {
  switch (entry.type) {
    case 'then':
      return recordedOutput(state, entry.step.id);
    case 'parallel':
      return Object.fromEntries(
        entry.steps.map((step) => [step.id, recordedOutput(state, step.id)] as const),
      );
    case 'branch': {
      // The executed arm is the first one with a record, in definition order; no record at all
      // means no condition was truthy and the block produced `{}`. Records are keyed by step id, so
      // an id reused across entries is inherently ambiguous — the same reading as `getStepResult`.
      const executed = entry.branches.find(([, step]) => state.stepResults[step.id] !== undefined);
      return executed === undefined ? {} : { [executed[1].id]: recordedOutput(state, executed[1].id) };
    }
    case 'foreach':
    case 'dowhile':
    case 'dountil':
      return recordedOutput(state, entry.step.id);
    case 'sleep':
      return value;
    default: {
      const { type } = entry as { readonly type: string };
      throw new Error(
        `workflow "${state.workflow.id}": the snapshot cannot be replayed — entry type "${type}" has no recorded output`,
      );
    }
  }
}

/** The recorded output of a completed step; a snapshot that misses it cannot be replayed. */
function recordedOutput(state: WalkState, stepId: string): unknown {
  const record = state.stepResults[stepId];
  if (record?.status !== 'success') {
    throw new Error(
      `workflow "${state.workflow.id}": the snapshot has no completed record for step "${stepId}" — it cannot be replayed from its position`,
    );
  }
  return record.output;
}

/**
 * The explicit failure a suspend raised outside a resumable entry means (v1): the snapshot shape has
 * `stepResults` + `position` only, and `position` is the entry index — a block's iteration site
 * (which iteration, how many collected, how many in flight) has no representation there. So a
 * `parallel` block, a `branch` arm, a `foreach` run and the loop bodies cannot be resumed from; the
 * signal becomes a plain error naming the block and the step, and the run fails loud instead of
 * suspending into a snapshot nothing can resume. Iteration-site semantics are a separate ticket.
 */
function unsupportedSuspend(workflowId: string, entry: WorkflowEntry, signal: SuspendSignal): Error {
  return new Error(
    `workflow "${workflowId}": suspend() was called by step "${signal.stepId}" inside a ${entry.type} block — suspend/resume supports a step in a top-level then entry only (a block's iteration site is not resumable yet)`,
  );
}

/** The recorded output of an already-run step; `undefined` when it has no recorded result. */
function getStepResult(state: WalkState, stepId: string): unknown {
  return state.stepResults[stepId]?.output;
}

/**
 * Runs one step and records it: status, output and boundary timestamps, keyed by step id.
 * `recordsSuspend` says whether a suspend signal becomes this step's recorded result — true only for
 * a step in a top-level `then` entry, the one shape `resume` can re-enter. A step that suspends
 * inside a block leaves no record: the run cannot suspend there (the walker fails it loudly), and
 * no snapshot may claim a `suspended` step on a failed run.
 */
async function runAndRecordStep(
  state: WalkState,
  step: Step,
  inputData: unknown,
  recordsSuspend: boolean,
): Promise<unknown> {
  const startedAt = Date.now();
  let output: unknown;
  try {
    output = await executeStep(state, step, inputData);
  } catch (error) {
    // A suspend is not a failure: the step is recorded `suspended` with its payload (never
    // `failed`) where the run can suspend, and the signal keeps travelling to the entry loop.
    if (isSuspendSignal(error)) {
      if (recordsSuspend) {
        recordStep(state, step.id, startedAt, {
          status: 'suspended',
          suspendPayload: error.payload,
        });
      }
    } else {
      recordStep(state, step.id, startedAt, { status: 'failed' });
    }
    throw error;
  }
  recordStep(state, step.id, startedAt, { status: 'success', output });
  return output;
}

/** Records one step result under its id: the status, the output when there is one, the timestamps. */
function recordStep(
  state: WalkState,
  stepId: string,
  startedAt: number,
  result:
    | { readonly status: 'success'; readonly output: unknown }
    | { readonly status: 'failed' }
    | { readonly status: 'suspended'; readonly suspendPayload: unknown },
): void {
  state.stepResults[stepId] = { ...result, startedAt, endedAt: Date.now() };
}

/**
 * Executes one step without recording it: the step boundary validation happens here (the upstream
 * value through this step's input schema), and the validated value is what `execute` receives —
 * validated once, then retried as a whole on failure (`step.retries`, the fixed-interval policy of
 * `retry.ts`). `foreach` and the loops call this per iteration, so N runs of one step id become one
 * aggregate record instead of N overwrites.
 */
async function executeStep(state: WalkState, step: Step, inputData: unknown): Promise<unknown> {
  const validated = await validateStepInput(state.workflow.id, step, inputData);
  return executeWithRetries(
    async () => step.execute(stepContext(state, step, validated)),
    step.retries ?? 0,
    state.signal,
  );
}

/**
 * The context bag every step `execute` receives — and every condition, which gets the same bag minus
 * the step's own powers: no step means no `suspend` (a condition cannot suspend a run) and no
 * `resumeData` (resuming is the step's business).
 */
function stepContext(state: WalkState, step: Step | undefined, inputData: unknown): StepContext {
  // The erased `StepContext` types `resumeData` as `undefined` (the real type lives on the step's
  // own `createStep` call site); the walker hands the validated value to the resumed step itself.
  const resumeData = (
    step !== undefined && step.id === state.resumingStepId ? state.resumeData : undefined
  ) as undefined;
  return {
    inputData,
    runId: state.runId,
    signal: state.signal,
    requestContext: state.requestContext,
    getStepResult: (stepId) => getStepResult(state, stepId),
    resumeData,
    suspend:
      step === undefined
        ? suspendOutsideStep
        : (payload: unknown): never => {
            throw new SuspendSignal(step.id, payload);
          },
  };
}

/** Conditions are read-only in spirit: they receive the bag, but they cannot suspend the walk. */
function suspendOutsideStep(): never {
  throw new Error(
    'suspend() is not available in a branch or loop condition — only a step can suspend a run',
  );
}

/**
 * `.parallel([a, b])` (`docs/architecture/workflows.md`「控制流算子」): every step receives the same
 * value (the previous entry's output) and runs concurrently — `Promise.all`, no concurrency cap.
 * The block is a synchronization point: it completes only once every step has; the first rejection
 * fails the whole block (steps already in flight keep running, as with `Promise.all`). Output =
 * `{ [step.id]: output }`, keyed in definition order.
 *
 * Each step records its own result under its id, so `getStepResult` finds them downstream; the
 * keyed object itself only flows on as the next entry's value (entries have no id of their own).
 */
async function runParallel(
  state: WalkState,
  entry: ParallelEntry,
  inputData: unknown,
): Promise<Record<string, unknown>> {
  const outputs = await Promise.all(
    entry.steps.map((step) => runAndRecordStep(state, step, inputData, false)),
  );
  return Object.fromEntries(entry.steps.map((step, index) => [step.id, outputs[index]] as const));
}

/**
 * `.branch([[cond, step], …])` (`docs/architecture/workflows.md`「控制流算子」): conditions are
 * evaluated in definition order with the same context bag a step receives (`inputData` = the
 * previous entry's output), and the first truthy one runs its step — later conditions are not
 * evaluated at all. Output = a keyed object whose only key is the executed step's id; when no
 * condition is truthy the output is `{}` (the tip value is consumed by the block, never passed
 * through). Branch arms are expected to share their IO schemas; each arm still validates the tip
 * value at its own step boundary.
 */
async function runBranch(
  state: WalkState,
  entry: BranchEntry,
  inputData: unknown,
): Promise<Record<string, unknown>> {
  for (const [condition, step] of entry.branches) {
    if (await condition(stepContext(state, undefined, inputData))) {
      return { [step.id]: await runAndRecordStep(state, step, inputData, false) };
    }
  }
  return {};
}

/**
 * `.foreach(step, { concurrency })` (`docs/architecture/workflows.md`「控制流算子」): the previous
 * entry's output must be an array; every element is one iteration of the same step (validated at
 * the step boundary like any other input) and the outputs are collected in index order.
 * `concurrency` (resolved at definition time, an integer ≥ 1) is the gate width: `1` runs the
 * iterations one after another, `>1` keeps exactly that many in flight and starts the next element
 * as soon as a slot frees — a self-written streaming gate, never a batch of `Promise.all`s. The
 * block is a synchronization point; the first failing iteration fails it and no further iteration
 * is started (in-flight ones finish), as with `Promise.all`.
 *
 * The step's record is the collected array, written when the block completes (iterations do not
 * record per run): `getStepResult(step.id)` returns the block's output, and inside its own
 * iterations the id stays unrecorded — like any step reading itself. A suspend raised by an
 * iteration unwinds the block and is not a step failure: it leaves no record at all (the walker
 * fails the run — a block's iteration site is not resumable).
 */
async function runForeach(state: WalkState, entry: ForeachEntry, inputData: unknown): Promise<unknown[]> {
  if (!Array.isArray(inputData)) {
    throw new Error(
      `workflow "${state.workflow.id}": the input of the foreach step "${entry.step.id}" must be an array (the previous entry's output), got ${inputData === null ? 'null' : typeof inputData}`,
    );
  }

  const startedAt = Date.now();
  const outputs = new Array<unknown>(inputData.length);
  let failed = false;
  let nextIndex = 0;
  /** One gate slot: pulls the next unconsumed index whenever it frees up, until the block fails. */
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < inputData.length) {
      const index = nextIndex++;
      try {
        outputs[index] = await executeStep(state, entry.step, inputData[index]);
      } catch (error) {
        // Flag the failure here, before it travels through `Promise.all`: sibling slots see it and
        // stop pulling new indices right away (a suspend unwinds the block the same way).
        failed = true;
        throw error;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(entry.concurrency, inputData.length) }, worker));
  } catch (error) {
    if (!isSuspendSignal(error)) {
      recordStep(state, entry.step.id, startedAt, { status: 'failed' });
    }
    throw error;
  }
  recordStep(state, entry.step.id, startedAt, { status: 'success', output: outputs });
  return outputs;
}

/**
 * `.dowhile(step, cond)` / `.dountil(step, cond)` (`docs/architecture/workflows.md`「控制流算子」):
 * the same loop with two condition checkpoints — `dowhile` checks **before** every iteration
 * (a condition false at `iterationCount: 0` runs the step zero times, the tip passing through
 * untouched), `dountil` checks **after** every iteration (the step always runs at least once).
 * Either way the condition sees the value that iteration consumed / produced — the previous entry's
 * output first, the previous iteration's output afterwards — together with `iterationCount`, the
 * number of iterations already completed.
 *
 * The step's output feeds its own input on the next iteration (validated at the boundary like any
 * other input), so the loop is a fold until the condition stops holding. Output = the last
 * iteration's output; the block records one result under the step id, written when the loop
 * completes (like `foreach`: the block has no id of its own, and reading the step id from inside is
 * unrecorded). A suspend raised by an iteration unwinds the block without a record — the iteration
 * site is not resumable, and it is not a step failure either.
 *
 * Throwing from the condition is the maximum-iteration gate: the error fails the run verbatim.
 * `iterationCount` counts completed iterations, so `if (iterationCount >= n) throw` caps the loop
 * at `n` iterations.
 */
async function runLoop(
  state: WalkState,
  entry: DowhileEntry | DountilEntry,
  inputData: unknown,
): Promise<unknown> {
  const startedAt = Date.now();
  let value = inputData;
  let iterationCount = 0;
  try {
    for (;;) {
      if (
        entry.type === 'dowhile' &&
        !(await loopConditionHolds(state, entry, value, iterationCount))
      ) {
        break;
      }
      value = await executeStep(state, entry.step, value);
      iterationCount += 1;
      if (
        entry.type === 'dountil' &&
        (await loopConditionHolds(state, entry, value, iterationCount))
      ) {
        break;
      }
    }
  } catch (error) {
    if (!isSuspendSignal(error)) {
      recordStep(state, entry.step.id, startedAt, { status: 'failed' });
    }
    throw error;
  }
  recordStep(state, entry.step.id, startedAt, { status: 'success', output: value });
  return value;
}

/**
 * Evaluates a loop condition: cancellation first (never hand an aborted run's loop another
 * evaluation), then the condition with the step context bag plus `iterationCount`.
 */
async function loopConditionHolds(
  state: WalkState,
  entry: DowhileEntry | DountilEntry,
  inputData: unknown,
  iterationCount: number,
): Promise<boolean> {
  throwIfAborted(state.signal);
  return entry.cond({ ...stepContext(state, undefined, inputData), iterationCount });
}

/**
 * `.sleep(ms | fn)` (`docs/architecture/workflows.md`「控制流算子」「错误、重试与状态机」): an
 * in-process wait, cut short by the run's signal. The run keeps its `running` reading while it
 * waits — the framework has no `waiting` state — and the wait is not durable: a dying process drops
 * it. The tip passes through untouched and nothing is recorded: a sleep is a delay, not a step.
 *
 * The duration is a `DynamicArgument` (`CONTEXT.md`「动态参数」): milliseconds, or a resolver the
 * run calls with its `RequestContext` (`signal` / `runId` reachable, the agent config fields'
 * convention) — not a step context, since a delay consumes and produces no value. It must be a
 * finite number of milliseconds; anything else is a broken computation and fails the run loudly. A
 * negative one — a deadline already in the past — means "no wait".
 */
async function runSleep(state: WalkState, entry: SleepEntry): Promise<void> {
  const duration = await resolveDynamicArgument(entry.duration, state.requestContext);
  if (!Number.isFinite(duration)) {
    throw new Error(
      `workflow "${state.workflow.id}": the sleep duration must be a finite number of milliseconds, got ${String(duration)}`,
    );
  }
  await abortableSleep(Math.max(0, duration), state.signal);
}
