import type { RequestContext } from '../agent/types.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import { createInMemorySnapshotStore } from './in-memory-snapshot-store.js';
import type {
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
  WorkflowStepResultSnapshot,
} from './snapshot.js';
import type { Step } from './step.js';
import { walk } from './walker.js';
import type { WorkflowDefinition } from './walker.js';

/**
 * The run surface (`docs/architecture/workflows.md`「Run」「suspend/resume 与快照」):
 * `createRun({ runId? })` gives a run identity, `start({ inputData, requestContext?, signal? })`
 * returns the output object, and `resume({ step, resumeData? })` re-enters a suspended run. This is
 * the workflow's parallel implementation of the agent's mental model (terminal values awaitable on
 * one object; the lifecycle event stream joins `start`'s output object with #52).
 *
 * `start` is lazy — the run executes on the first read of `result`, so a run nobody consumes
 * performs no work and cannot reject unhandled. `resume` is eager: it loads the snapshot right away
 * and resolves with the run's outcome (a failed resume rejects with the error that failed it).
 */

/** The outcome of a run that completed: the workflow's terminal value and the per-step records. */
export interface WorkflowRunSuccessOutcome<TOutput = unknown> {
  /** The run's terminal status. */
  readonly status: 'success';
  /** The workflow's terminal value: the last entry's output, or the start input when it has no entries. */
  readonly output: TOutput;
  /** Per-step records, keyed by step id — status, output and boundary timestamps. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
}

/**
 * The outcome of a run that suspended: a step called `suspend(payload)` and the run unwound.
 * `stepId` names that step — the step `resume` must target; the payload it carried lives in
 * `stepResults[stepId].suspendPayload`.
 */
export interface WorkflowRunSuspendedOutcome {
  /** The run's terminal status. */
  readonly status: 'suspended';
  /** The step that suspended — whose `resumeSchema` a resume's `resumeData` is validated against. */
  readonly stepId: string;
  /** Per-step records, keyed by step id — the suspended step's record carries its `suspendPayload`. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
}

/**
 * The run's outcome: the terminal value `out.result` resolves with (`resume` resolves with the same
 * envelope). A failed run never reaches here — it rejects with the error that failed it.
 */
export type WorkflowRunOutcome<TOutput = unknown> =
  | WorkflowRunSuccessOutcome<TOutput>
  | WorkflowRunSuspendedOutcome;

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

/** The `resume` options. */
export interface WorkflowResumeOptions {
  /** The run's suspended step: the step object, or its id — only the id matters. */
  readonly step: Step | string;
  /**
   * What the suspended step comes back with; validated against that step's `resumeSchema` (the
   * third fixed IO boundary). Absent for a step that declares no `resumeSchema`.
   */
  readonly resumeData?: unknown;
  /** Cancels the resumed segment; defaults to the run's start signal when there was one. */
  readonly signal?: AbortSignal | undefined;
  /** The resumed segment's open bag, laid over the start call's bag; framework writes `signal`/`runId`. */
  readonly requestContext?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The output object `start` returns: the run's terminal values, created lazily on first read. The
 * `for await` lifecycle event stream is part of this object's shape (the spec's double
 * consumption) and lands with #52.
 */
export interface WorkflowRunOutput<TOutput = unknown> {
  /**
   * The run's terminal value: resolves the outcome envelope on success or suspension; rejects with
   * the run's error when it fails (a step's own error, a validation error, or the abort reason).
   * Reading it starts the run.
   */
  readonly result: Promise<WorkflowRunOutcome<TOutput>>;
}

/**
 * One execution lifecycle of a committed workflow (`docs/architecture/workflows.md`「Run」):
 * `createRun` mints its identity, `start` begins the single execution, and `resume` continues a run
 * that suspended. Starting and resuming are mutually exclusive — a resumed run was not started here
 * (the durable path: a fresh run object over the same `runId` and store).
 */
export interface WorkflowRun<TInputData = unknown, TOutput = unknown> {
  /** Identity of this run — correlation for snapshots, spans and the request context. */
  readonly runId: string;
  /** Starts the run once, returning its output object. */
  start(options: WorkflowStartOptions<TInputData>): WorkflowRunOutput<TOutput>;
  /**
   * Resumes a suspended run: loads its snapshot, validates `resumeData` against the suspended step's
   * `resumeSchema`, and re-enters the walk from the snapshot's position. Concurrent resumes of one
   * run are deduplicated: the later call joins the one in flight.
   */
  resume(options: WorkflowResumeOptions): Promise<WorkflowRunOutcome<TOutput>>;
}

/** A signal that never aborts — the `signal` of runs that were started without one. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * The in-process resume lock (`docs/architecture/workflows.md`「suspend/resume 与快照」): one resume
 * per run at a time. A concurrent resume of the same run joins the one in flight instead of loading
 * the same suspended snapshot twice; the lock clears when that resume settles, so a run that
 * suspended again can be resumed again. Cross-process safety is the store's concern (CAS is the
 * adapter's optional extension, `docs/architecture/storage.md`), not the core's.
 */
const resumeLocks = new Map<string, Promise<WorkflowRunOutcome>>();

/**
 * Creates a run of the given workflow: an identity now, an execution on `start`. `createRun` does
 * no I/O and validates no run id beyond its shape — the run only touches anything on first
 * consumption of its output object (or on `resume`).
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
  let startOptions: WorkflowStartOptions<unknown> | undefined;
  // Without attached storage the run still snapshots — in memory, for this run alone (the default
  // store is created on first use, so a run that never suspends pays nothing).
  let defaultStorage: WorkflowSnapshotStore | undefined;
  const storage = (): WorkflowSnapshotStore =>
    workflow.storage ?? (defaultStorage ??= createInMemorySnapshotStore());

  return {
    runId,
    start(options) {
      if (started) {
        throw new Error(
          `run "${runId}" was already started — a run is one execution; create another run to execute the workflow again.`,
        );
      }
      started = true;
      startOptions = options;
      return createRunOutput<TOutput>(workflow, runId, options, storage());
    },
    resume(resumeOptions) {
      // Resuming consumes the run's one lifecycle just like starting does: a run cannot be resumed
      // and then started.
      started = true;
      return resumeRun<TOutput>(workflow, runId, resumeOptions, startOptions, storage());
    },
  };
}

/**
 * One resume, deduplicated by run id: everything on the path — loading the snapshot, checking it,
 * validating the resume data, re-entering the walk — runs inside the lock, so two callers asking at
 * once get one resume and one outcome.
 */
function resumeRun<TOutput>(
  workflow: WorkflowDefinition,
  runId: string,
  options: WorkflowResumeOptions,
  startOptions: WorkflowStartOptions<unknown> | undefined,
  storage: WorkflowSnapshotStore,
): Promise<WorkflowRunOutcome<TOutput>> {
  const inFlight = resumeLocks.get(runId);
  if (inFlight !== undefined) return inFlight as Promise<WorkflowRunOutcome<TOutput>>;

  const running = resumeSnapshot<TOutput>(workflow, runId, options, startOptions, storage);
  let locked: Promise<WorkflowRunOutcome<TOutput>> | undefined;
  locked = running.finally(() => {
    if (locked !== undefined && resumeLocks.get(runId) === locked) resumeLocks.delete(runId);
  });
  resumeLocks.set(runId, locked);
  return locked;
}

/** One run's resume: the load → check → validate → re-enter path of the spec's resume section. */
async function resumeSnapshot<TOutput>(
  workflow: WorkflowDefinition,
  runId: string,
  options: WorkflowResumeOptions,
  startOptions: WorkflowStartOptions<unknown> | undefined,
  storage: WorkflowSnapshotStore,
): Promise<WorkflowRunOutcome<TOutput>> {
  const stepId = typeof options.step === 'string' ? options.step : options.step.id;
  const snapshot = await storage.load(runId);
  if (snapshot === null) {
    throw new Error(
      `run "${runId}" has no snapshot — resume() needs a run that suspended in this store (a workflow without storage keeps its snapshots in process memory, for the run object that made them).`,
    );
  }
  if (snapshot.status !== 'suspended') {
    throw new Error(
      `run "${runId}" is ${snapshot.status}, not suspended — only a suspended run can be resumed.`,
    );
  }
  const suspended = suspendedStepId(workflow.id, snapshot);
  if (suspended !== stepId) {
    throw new Error(
      `run "${runId}" suspended at step "${suspended}" — resume() was asked for step "${stepId}".`,
    );
  }

  const signal = options.signal ?? startOptions?.signal ?? NEVER_ABORTED;
  const requestContext: RequestContext = {
    ...startOptions?.requestContext,
    ...options.requestContext,
    signal,
    runId,
  };
  const walker = walk(workflow, {
    runId,
    // The snapshot's input is the validated start input: the start boundary does not run again on a
    // resume (the only boundary a resume crosses is `resumeData`).
    inputData: snapshot.input,
    requestContext,
    signal,
    storage,
    persistStepBoundaries: workflow.storage !== undefined,
    resume: {
      stepId,
      resumeData: options.resumeData,
      position: snapshot.position,
      stepResults: snapshot.stepResults,
    },
  });
  return (await drain(walker)) as WorkflowRunOutcome<TOutput>;
}

/**
 * The step a snapshot is suspended at: its one record marked `suspended` (a snapshot without
 * exactly one is corrupted or foreign — it cannot be resumed).
 */
function suspendedStepId(workflowId: string, snapshot: WorkflowRunSnapshot): string {
  const suspended = Object.entries(snapshot.stepResults).filter(
    ([, record]) => record.status === 'suspended',
  );
  const [first] = suspended;
  if (first === undefined || suspended.length > 1) {
    throw new Error(
      `workflow "${workflowId}": the snapshot of run "${snapshot.runId}" is not suspended at exactly one step — it cannot be resumed`,
    );
  }
  return first[0];
}

/** Drains a walk to its outcome: one pump owns the generator (`start` and `resume` share it). */
async function drain(
  walker: AsyncGenerator<never, WorkflowRunOutcome, void>,
): Promise<WorkflowRunOutcome> {
  for (;;) {
    const next = await walker.next();
    if (next.done) return next.value;
  }
}

/**
 * The output object of one run. Exactly one execution pass backs it (the single-path principle of
 * the agent's output object): the walker is drained by one pump, the terminal `result` settles from
 * that pass. The pump is also where #52 delivers the lifecycle events from the walker's yields to
 * the output object's iterator.
 */
function createRunOutput<TOutput>(
  workflow: WorkflowDefinition,
  runId: string,
  options: WorkflowStartOptions<unknown>,
  storage: WorkflowSnapshotStore,
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
        storage,
        persistStepBoundaries: workflow.storage !== undefined,
      });
      outcome = (await drain(walker)) as WorkflowRunOutcome<TOutput>;
      settle?.(outcome);
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
