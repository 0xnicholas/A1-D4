import type { RequestContext } from '../agent/types.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { WorkflowEvent } from './events.js';
import { createInMemorySnapshotStore } from './in-memory-snapshot-store.js';
import type { WorkflowSnapshotStore, WorkflowStepResultSnapshot } from './snapshot.js';
import type { Step } from './step.js';
import { walk } from './walker.js';
import type { WalkTraceContinuation, WorkflowDefinition } from './walker.js';

/**
 * The run surface (the run lifecycle, its streaming events, and suspend/resume with snapshots):
 * `createRun({ runId? })` gives a run identity, `start({ inputData, requestContext?, signal? })`
 * returns the output object, and `resume({ step, resumeData? })` re-enters a suspended run. This is
 * the workflow's parallel implementation of the agent's mental model: one execution backs both
 * consumptions — `result` awaits the terminal outcome, `for await` walks the lifecycle events
 * (run-start / step-start / step-end / run-end) — so mixing the two always describes the same run.
 *
 * `start` is lazy — the run executes on the first read of `result` or the first `next()` of the
 * event stream, so a run nobody consumes performs no work and cannot reject unhandled. `resume` is
 * eager: it loads the snapshot right away and resolves with the run's outcome (a failed resume
 * rejects with the error that failed it).
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
  /**
   * The trace the run's first segment continues, for a run that hangs under a trace started
   * elsewhere (an incoming `traceparent`, a parent run) — the agent's run options' convention
   * (external trace continuation). Empty strings mean "no trace": an
   * empty `traceId` voids the pair, an empty `parentSpanId` only drops the parent. A resumed
   * segment continues the trace its snapshot pinned, never this pair.
   */
  readonly traceId?: string | undefined;
  /** The parent span inside that trace; requires `traceId` (the tracer rejects one without it). */
  readonly parentSpanId?: string | undefined;
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
 * The output object `start` returns (the run lifecycle and its streaming events): the run's
 * terminal values and its lifecycle event stream, backed by one execution. `await out.result`
 * resolves the outcome envelope on success or suspension (rejects when the run fails); `for await`
 * walks the run / step boundary events as they happen. Reading either starts the run.
 */
export interface WorkflowRunOutput<TOutput = unknown> extends AsyncIterable<WorkflowEvent> {
  /**
   * The run's terminal value: resolves the outcome envelope on success or suspension; rejects with
   * the run's error when it fails (a step's own error, a validation error, or the abort reason).
   * Reading it starts the run.
   */
  readonly result: Promise<WorkflowRunOutcome<TOutput>>;
}

/**
 * One execution lifecycle of a committed workflow (the run lifecycle):
 * `createRun` mints its identity, `start` begins the single execution, and `resume` continues a run
 * that suspended — the run it was started on, or (the durable path) a fresh run object over the same
 * `runId` and store. A run executes once: `start` refuses a second call, and `resume` continues the
 * same execution as often as the run suspends again.
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
 * The in-process resume lock (suspend/resume and snapshots): one resume
 * per run at a time. A concurrent resume of the same run joins the one in flight instead of loading
 * the same suspended snapshot twice; the lock clears when that resume settles, so a run that
 * suspended again can be resumed again. Cross-process safety is the store's concern (CAS is the
 * adapter's optional extension), not the core's.
 */
const resumeLocks = new Map<string, Promise<WorkflowRunOutcome>>();

/**
 * Creates a run of the given workflow: an identity now, an execution on `start`. `createRun` does
 * no I/O and validates no run id beyond its shape — the run only touches anything on first
 * consumption of its output object (or on `resume`).
 */
export function createWorkflowRun<TInputSchema extends StandardSchema, TOutput = unknown>(
  workflow: WorkflowDefinition<TInputSchema>,
  createOptions: WorkflowCreateRunOptions = {},
): WorkflowRun<StandardSchemaV1.InferInput<TInputSchema>, TOutput> {
  const runId = createOptions.runId ?? crypto.randomUUID();
  if (typeof runId !== 'string' || runId === '') {
    throw new Error(`createRun: runId must be a non-empty string, got ${String(runId)}.`);
  }

  let started = false;
  let startOptions: WorkflowStartOptions<unknown> | undefined;
  let defaultStore: WorkflowSnapshotStore | undefined;
  /**
   * The run's snapshot wiring, resolved on first use: the attached store, or the in-memory default
   * (a run that never suspends never creates one). The default lives with this run object, so
   * in-memory snapshots are resumable by the object that made them; a fresh run object — the
   * durable path — needs a real store attached.
   */
  const persistence = (): SnapshotPersistence => ({
    store: workflow.storage ?? (defaultStore ??= createInMemorySnapshotStore()),
    // Entry boundaries are only worth persisting with a real store: the in-memory default dies
    // with the process, so the per-entry writes would serve nobody.
    persistStepBoundaries: workflow.storage !== undefined,
  });

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
      return createRunOutput<TOutput>(workflow, runId, options, persistence(), {
        traceId: createOptions.traceId,
        parentSpanId: createOptions.parentSpanId,
      });
    },
    resume(resumeOptions) {
      // Resuming consumes the run's one lifecycle just like starting does: a run cannot be resumed
      // and then started.
      started = true;
      return resumeRun<TOutput>(workflow, runId, resumeOptions, startOptions, persistence());
    },
  };
}

/** Where a run's walk reads and writes snapshots, and whether it writes one per completed entry. */
interface SnapshotPersistence {
  /** The attached store, or the run's in-memory default. */
  readonly store: WorkflowSnapshotStore;
  /** True only with a real store attached — the in-memory default buys no crash recovery. */
  readonly persistStepBoundaries: boolean;
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
  persistence: SnapshotPersistence,
): Promise<WorkflowRunOutcome<TOutput>> {
  const inFlight = resumeLocks.get(runId);
  if (inFlight !== undefined) return inFlight as Promise<WorkflowRunOutcome<TOutput>>;

  const running = resumeSnapshot<TOutput>(workflow, runId, options, startOptions, persistence);
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
  persistence: SnapshotPersistence,
): Promise<WorkflowRunOutcome<TOutput>> {
  const stepId = typeof options.step === 'string' ? options.step : options.step.id;
  const snapshot = await persistence.store.load(runId);
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
    storage: persistence.store,
    persistStepBoundaries: persistence.persistStepBoundaries,
    // The target check (is the run suspended at this step?) and the structural check (does the
    // position still hold that step's `then` entry?) belong to the walker's `enterResume`, which
    // holds the snapshot's records and the definition side by side.
    resume: {
      stepId,
      resumeData: options.resumeData,
      position: snapshot.position,
      stepResults: snapshot.stepResults,
      // The block's iteration site when the run suspended inside a block (#54): the walk re-enters
      // that block from it. A snapshot without one is the earlier top-level `then` shape.
      ...(snapshot.iterationSite === undefined ? {} : { iterationSite: snapshot.iterationSite }),
      // The resumed segment continues the trace the suspended run was exported under.
      ...(snapshot.traceId === undefined ? {} : { traceId: snapshot.traceId }),
    },
  });
  return (await walker) as WorkflowRunOutcome<TOutput>;
}

/**
 * The output object of one run. Exactly one execution pass backs it (the single-path principle of
 * the agent's output object): `result` settles from that pass, and the lifecycle events the walker
 * emits are handed to the iterator or buffered for it. A consumer that leaves the loop early stops
 * the buffering but not the run — the terminal outcome still settles from the same pass.
 */
function createRunOutput<TOutput>(
  workflow: WorkflowDefinition,
  runId: string,
  options: WorkflowStartOptions<unknown>,
  persistence: SnapshotPersistence,
  trace: WalkTraceContinuation,
): WorkflowRunOutput<TOutput> {
  let started = false;
  let settled = false;
  let abandoned = false;
  let resultPromise: Promise<WorkflowRunOutcome<TOutput>> | undefined;
  let outcome: WorkflowRunOutcome<TOutput> | undefined;
  let failure: { readonly error: unknown } | undefined;
  let settle: ((value: WorkflowRunOutcome<TOutput>) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  /** Lifecycle events produced but not read yet, in boundary order. */
  const buffered: WorkflowEvent[] = [];
  /** Iterators parked in `next()`, waiting for the next event. */
  const waiting: WaitForEvent[] = [];

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
      outcome = (await walk(workflow, {
        runId,
        inputData: options.inputData,
        requestContext,
        signal: requestContext.signal,
        storage: persistence.store,
        persistStepBoundaries: persistence.persistStepBoundaries,
        emit: deliver,
        trace,
      })) as WorkflowRunOutcome<TOutput>;
      settled = true;
      for (const waiter of waiting.splice(0)) waiter.resolve(DONE_EVENTS);
      settle?.(outcome);
    } catch (error) {
      failure = { error };
      settled = true;
      for (const waiter of waiting.splice(0)) waiter.reject(error);
      reject?.(error);
    }
  }

  /** Hand one lifecycle event to the waiting iterator, or buffer it until one asks. */
  function deliver(event: WorkflowEvent): void {
    if (abandoned) return; // The consumer left; nothing will read this buffer again.
    const waiter = waiting.shift();
    if (waiter === undefined) {
      buffered.push(event);
      return;
    }
    waiter.resolve({ value: event, done: false });
  }

  const iterator: AsyncIterator<WorkflowEvent> = {
    next(): Promise<IteratorResult<WorkflowEvent>> {
      start();
      if (abandoned) return Promise.resolve(DONE_EVENTS);
      // Buffered events first: a failed run still delivers everything it produced before failing.
      const event = buffered.shift();
      if (event !== undefined) return Promise.resolve({ value: event, done: false });
      if (failure !== undefined) return Promise.reject(failure.error);
      if (settled) return Promise.resolve(DONE_EVENTS);
      return new Promise<IteratorResult<WorkflowEvent>>((resolve, rejectEvent) => {
        waiting.push({ resolve, reject: rejectEvent });
      });
    },
    return(): Promise<IteratorResult<WorkflowEvent>> {
      abandoned = true;
      buffered.length = 0;
      return Promise.resolve(DONE_EVENTS);
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
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

interface WaitForEvent {
  resolve(result: IteratorResult<WorkflowEvent>): void;
  reject(error: unknown): void;
}

const DONE_EVENTS: IteratorResult<WorkflowEvent> = { value: undefined, done: true };
