import type { RequestContext } from '../agent/types.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { WorkflowStepResultSnapshot } from './snapshot.js';
import { walk } from './walker.js';
import type { WorkflowDefinition } from './walker.js';

/**
 * The run surface (`docs/architecture/workflows.md`「Run」): `createRun({ runId? })` gives a run
 * identity, and `start({ inputData, requestContext?, signal? })` returns the output object — the
 * workflow's parallel implementation of the agent's mental model (a run whose terminal values are
 * awaitable promises on one object; the lifecycle event stream joins it with #52).
 *
 * This ticket lands the `result` terminal: it resolves the run's outcome envelope when the run
 * completes, and rejects when it fails. Start is lazy — the run executes on the first read of
 * `result`, so a run nobody consumes performs no work and cannot reject unhandled.
 */

/**
 * The run's outcome: the terminal value `out.result` resolves with. A failed run never reaches
 * here — it rejects with the error that failed it.
 *
 * `status` is the run's state-machine reading; this ticket lands `success` only, and the
 * `suspended` arm joins the union with #51 (`{ status: 'suspended', stepResults }`).
 */
export interface WorkflowRunOutcome<TOutput = unknown> {
  /** The run's terminal status — `success` in this version; `suspended` lands with #51. */
  readonly status: 'success';
  /** The workflow's terminal value: the last entry's output, or the start input when it has no entries. */
  readonly output: TOutput;
  /** Per-step records, keyed by step id — status, output and boundary timestamps. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
}

/** The `createRun` options. */
export interface WorkflowCreateRunOptions {
  /** Identity of the run (snapshots, spans and `requestContext.runId`); generated when omitted. */
  readonly runId?: string | undefined;
}

/** The `start` options. */
export interface WorkflowStartOptions<TInputData = unknown> {
  /** The run's start input, validated against the workflow's `inputSchema` (always on). */
  readonly inputData: TInputData;
  /** The user's per-call open bag (`RequestContext` convention); the framework writes `signal`/`runId` last. */
  readonly requestContext?: Readonly<Record<string, unknown>> | undefined;
  /** Cancels the run; propagated into every step's ctx. Cancellation fails the run (AbortError). */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The output object `start` returns: the run's terminal values, created lazily on first read. The
 * `for await` lifecycle event stream is part of this object's shape (the spec's double
 * consumption) and lands with #52.
 */
export interface WorkflowRunOutput<TOutput = unknown> {
  /**
   * The run's terminal value: resolves the outcome envelope on success; rejects with the run's
   * error when it fails (a step's own error, a validation error, or the abort reason). Reading it
   * starts the run.
   */
  readonly result: Promise<WorkflowRunOutcome<TOutput>>;
}

/**
 * One execution lifecycle of a committed workflow (`docs/architecture/workflows.md`「Run」):
 * `createRun` mints its identity, `start` begins the single execution. `resume` joins this surface
 * with #51.
 */
export interface WorkflowRun<TInputData = unknown, TOutput = unknown> {
  /** Identity of this run — correlation for snapshots, spans and the request context. */
  readonly runId: string;
  /** Starts the run once, returning its output object. */
  start(options: WorkflowStartOptions<TInputData>): WorkflowRunOutput<TOutput>;
}

/** A signal that never aborts — the `signal` of runs that were started without one. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * Creates a run of the given workflow: an identity now, an execution on `start`. `createRun` does
 * no I/O and validates no run id beyond its shape — the run only touches anything on first
 * consumption of its output object.
 */
export function createWorkflowRun<TInputSchema extends StandardSchema, TOutput = unknown>(
  workflow: WorkflowDefinition<TInputSchema>,
  options: WorkflowCreateRunOptions = {},
): WorkflowRun<StandardSchemaV1.InferInput<TInputSchema>, TOutput> {
  const runId = options.runId ?? crypto.randomUUID();
  if (typeof runId !== 'string' || runId === '') {
    throw new Error(`createRun: runId must be a non-empty string, got ${String(runId)}.`);
  }

  let started = false;
  return {
    runId,
    start(startOptions) {
      if (started) {
        throw new Error(
          `run "${runId}" was already started — a run is one execution; create another run to execute the workflow again.`,
        );
      }
      started = true;
      return createRunOutput<TOutput>(workflow, runId, startOptions);
    },
  };
}

/**
 * The output object of one run. Exactly one execution pass backs it (the single-path principle of
 * the agent's output object): the walker is drained by one pump, the terminal `result` settles
 * from that pass. The pump is also where #52 delivers the lifecycle events from the walker's
 * yields to the output object's iterator.
 */
function createRunOutput<TOutput>(
  workflow: WorkflowDefinition,
  runId: string,
  options: WorkflowStartOptions<unknown>,
): WorkflowRunOutput<TOutput> {
  let started = false;
  let resultPromise: Promise<WorkflowRunOutcome<TOutput>> | undefined;
  let outcome: WorkflowRunOutcome<TOutput> | undefined;
  let failure: { readonly error: unknown } | undefined;
  let settle: ((value: WorkflowRunOutcome<TOutput>) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;

  /** The run's request context: the user's per-call bag plus framework-written `signal`/`runId`. */
  const requestContext: RequestContext = {
    ...options.requestContext,
    signal: options.signal ?? NEVER_ABORTED,
    runId,
  };

  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    try {
      const walker = walk(workflow, {
        runId,
        inputData: options.inputData,
        requestContext,
        signal: requestContext.signal,
      });
      // Manual iteration: the outcome is the generator's return value. Every yielded lifecycle
      // event will be delivered to the output object's iterator here (#52).
      for (;;) {
        const next = await walker.next();
        if (next.done) {
          outcome = next.value as WorkflowRunOutcome<TOutput>;
          settle?.(outcome);
          return;
        }
      }
    } catch (error) {
      failure = { error };
      reject?.(error);
    }
  }

  return {
    get result(): Promise<WorkflowRunOutcome<TOutput>> {
      start();
      if (resultPromise !== undefined) return resultPromise;
      // Settling before the first read stores the outcome instead of creating a promise, so a run
      // whose `result` is never read cannot reject unhandled.
      resultPromise = new Promise<WorkflowRunOutcome<TOutput>>((onValue, onError) => {
        if (outcome !== undefined) onValue(outcome);
        else if (failure !== undefined) onError(failure.error);
        else {
          settle = onValue;
          reject = onError;
        }
      });
      return resultPromise;
    },
  };
}
