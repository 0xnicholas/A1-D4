import type { RequestContext } from '../agent/types.js';
import type { StandardSchema } from '../standard-schema.js';
import type { BranchEntry, ForeachEntry, ParallelEntry } from './entry.js';
import type { WorkflowStepResultSnapshot } from './snapshot.js';
import type { Step, StepContext } from './step.js';
import { validateRunInput, validateStepInput } from './validate.js';
import type { Workflow } from './workflow.js';
import type { WorkflowRunOutcome } from './run.js';

/**
 * The semantic kernel (`docs/architecture/workflows.md`「Workflow 与 builder」「Run」「控制流算子」):
 * a `for` loop over the workflow's flat entry list, interpreting entry by entry — there is no DAG.
 * Each entry receives the previous entry's output (the run's input for the first one) and its
 * output becomes the next entry's value: `then` pipes a step's output through, `parallel` runs
 * every step concurrently and keys the outputs by step id, `branch` runs the first step whose
 * condition is truthy and keys the output the same way, `foreach` maps an array through one step
 * and collects an array. The loop entries (dowhile / dountil) and sleep land with #50.
 *
 * The walker is an async generator: it currently completes with the run's outcome and yields
 * nothing — the lifecycle events (run-start / step-start / step-end / run-end) are delivered
 * through the yields, landing with #52. The `for` loop and its boundaries are the seam that ticket
 * slots into.
 */

/** What a run reads of its workflow: the identity, the start input schema and the frozen entries. */
export type WorkflowDefinition<TInputSchema extends StandardSchema = StandardSchema> = Pick<
  Workflow<TInputSchema>,
  'id' | 'inputSchema' | 'entries'
>;

/** One walk's outer state: the run's identity, its input and the accumulated step records. */
export interface WalkOptions {
  /** Identity of the run being walked. */
  readonly runId: string;
  /** The run's start input, `inputData` of the first entry. */
  readonly inputData: unknown;
  /** The run's request context — the same object every step receives. */
  readonly requestContext: RequestContext;
  /** Cancellation, checked before every entry and propagated into every step. */
  readonly signal: AbortSignal;
}

/** The walk's mutable state, threaded through the helpers below. */
interface WalkState extends WalkOptions {
  readonly workflow: WorkflowDefinition;
  /** Per-step records, keyed by step id — the run's stepResults, and the snapshot's future body. */
  readonly stepResults: Record<string, WorkflowStepResultSnapshot>;
}

/**
 * Walks a committed workflow: validates the run's start input, then interprets every entry in
 * order. Completes with the run's outcome; throws when the run fails at any boundary.
 */
export async function* walk(
  workflow: WorkflowDefinition,
  options: WalkOptions,
): AsyncGenerator<never, WorkflowRunOutcome, void> {
  const state: WalkState = { ...options, workflow, stepResults: {} };
  // Cancellation comes first at the start boundary: a run whose signal is already aborted does
  // nothing at all — not even validation.
  throwIfAborted(options.signal);
  // The run's start input is the first boundary: its validated value replaces the raw input
  // (defaults / transforms apply), and a rejection here means the run never starts.
  let value: unknown = await validateRunInput(workflow.id, workflow.inputSchema, options.inputData);

  for (const entry of workflow.entries) {
    throwIfAborted(options.signal);
    switch (entry.type) {
      case 'then':
        value = await runAndRecordStep(state, entry.step, value);
        break;
      case 'parallel':
        value = await runParallel(state, entry, value);
        break;
      case 'branch':
        value = await runBranch(state, entry, value);
        break;
      case 'foreach':
        value = await runForeach(state, entry, value);
        break;
      default:
        throw new Error(
          `workflow "${workflow.id}": the "${entry.type}" entry has no execution semantics yet`,
        );
    }
    // A step that ignored the abort at least cannot let the run succeed: the boundary after it
    // re-checks, so cancellation always lands the run in `failed` (AbortError).
    throwIfAborted(options.signal);
  }

  return { status: 'success', output: value, stepResults: state.stepResults };
}

/**
 * Fails the walk when the signal is aborted: the signal's own reason as the run's error (an
 * `AbortError` DOMException for a plain `abort()`), or an `AbortError` of our own when the aborter
 * left a non-Error reason. Cancellation is a failed run — never a `canceled` state of its own.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error
    ? reason
    : new DOMException('This operation was aborted', 'AbortError');
}

/** The recorded output of an already-run step; `undefined` when it has no recorded result. */
function getStepResult(state: WalkState, stepId: string): unknown {
  return state.stepResults[stepId]?.output;
}

/** Runs one step and records it: status, output and boundary timestamps, keyed by step id. */
async function runAndRecordStep(state: WalkState, step: Step, inputData: unknown): Promise<unknown> {
  const startedAt = Date.now();
  let output: unknown;
  try {
    output = await executeStep(state, step, inputData);
  } catch (error) {
    recordStep(state, step.id, startedAt, { status: 'failed' });
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
  result: { readonly status: 'success' | 'failed'; readonly output?: unknown },
): void {
  state.stepResults[stepId] = { ...result, startedAt, endedAt: Date.now() };
}

/**
 * Executes one step without recording it: the step boundary validation happens here (the upstream
 * value through this step's input schema), and the validated value is what `execute` receives.
 * `foreach` calls this per iteration, so N runs of one step id become one aggregate record instead
 * of N overwrites.
 */
async function executeStep(state: WalkState, step: Step, inputData: unknown): Promise<unknown> {
  const validated = await validateStepInput(state.workflow.id, step, inputData);
  return step.execute(stepContext(state, validated));
}

/** The context bag every step `execute` — and every branch condition — receives. */
function stepContext(state: WalkState, inputData: unknown): StepContext {
  return {
    inputData,
    runId: state.runId,
    signal: state.signal,
    requestContext: state.requestContext,
    getStepResult: (stepId) => getStepResult(state, stepId),
    resumeData: undefined,
    suspend: suspendNotImplemented,
  };
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
    entry.steps.map((step) => runAndRecordStep(state, step, inputData)),
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
    if (await condition(stepContext(state, inputData))) {
      return { [step.id]: await runAndRecordStep(state, step, inputData) };
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
 * iterations the id stays unrecorded — like any step reading itself.
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
        // stop pulling new indices right away.
        failed = true;
        throw error;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(entry.concurrency, inputData.length) }, worker));
  } catch (error) {
    recordStep(state, entry.step.id, startedAt, { status: 'failed' });
    throw error;
  }
  recordStep(state, entry.step.id, startedAt, { status: 'success', output: outputs });
  return outputs;
}

/**
 * The `suspend` a step's context carries before suspend/resume lands (#51): calling it is an
 * explicit error, never a silent no-op — the snapshot machine it needs does not exist yet.
 */
function suspendNotImplemented(): never {
  throw new Error('suspend() is not implemented yet');
}
