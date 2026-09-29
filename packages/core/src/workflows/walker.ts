import type { RequestContext } from '../agent/types.js';
import type { StandardSchema } from '../standard-schema.js';
import type { WorkflowStepResultSnapshot } from './snapshot.js';
import type { Step } from './step.js';
import { validateRunInput, validateStepInput } from './validate.js';
import type { Workflow } from './workflow.js';
import type { WorkflowRunOutcome } from './run.js';

/**
 * The semantic kernel (`docs/architecture/workflows.md`「Workflow 与 builder」「Run」): a `for` loop
 * over the workflow's flat entry list, interpreting entry by entry — there is no DAG. Each `then`
 * step receives the previous value (the run's input for the first entry) as `inputData`, and its
 * output becomes the next entry's value.
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
    if (entry.type !== 'then') {
      throw new Error(
        `workflow "${workflow.id}": the "${entry.type}" entry has no execution semantics yet`,
      );
    }
    value = await runStep(state, entry.step, value);
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

/** Runs one step: the input value it is handed, its record's timestamps and the framework context. */
async function runStep(state: WalkState, step: Step, inputData: unknown): Promise<unknown> {
  const startedAt = Date.now();
  let output: unknown;
  try {
    // The step boundary: the upstream output is validated by this step's input schema, and the
    // validated value is what `execute` receives. A rejection fails this step, and the run.
    const validated = await validateStepInput(state.workflow.id, step, inputData);
    output = await step.execute({
      inputData: validated,
      runId: state.runId,
      signal: state.signal,
      requestContext: state.requestContext,
      getStepResult: (stepId) => getStepResult(state, stepId),
      resumeData: undefined,
      suspend: suspendNotImplemented,
    });
  } catch (error) {
    state.stepResults[step.id] = { status: 'failed', startedAt, endedAt: Date.now() };
    throw error;
  }
  state.stepResults[step.id] = { status: 'success', output, startedAt, endedAt: Date.now() };
  return output;
}

/**
 * The `suspend` a step's context carries before suspend/resume lands (#51): calling it is an
 * explicit error, never a silent no-op — the snapshot machine it needs does not exist yet.
 */
function suspendNotImplemented(): never {
  throw new Error('suspend() is not implemented yet');
}
