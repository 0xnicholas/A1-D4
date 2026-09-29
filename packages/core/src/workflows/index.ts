/**
 * `@balsa/core/workflows` — workflow engine.
 *
 * The definition surface: `createStep` (id + IO schemas + optional resume/suspend schemas +
 * retries + execute), the `StepContext` bag every step executes with, and the mutable
 * `createWorkflow` builder whose seven operators (then / parallel / branch / foreach / dowhile /
 * dountil / sleep) each push one flat `{ type, … }` entry until `.commit()` freezes the
 * definition. Type safety rides a type-state: `then` is strict, parallel/branch infer keyed
 * objects.
 *
 * The run surface: a committed workflow's `createRun` gives a run identity, `start` returns the
 * output object whose `result` resolves the run's outcome envelope (or rejects when the run fails)
 * and whose `for await` walks the lifecycle events (run-start / step-start / step-end / run-end,
 * carrying the values that cross each boundary), and `resume({ step, resumeData? })` continues a run
 * that suspended. Start is lazy — the walker executes on the first read; resume is eager and resolves
 * with the same outcome envelope. The walker interprets the flat entry list in order: `then` pipes the previous output on, `parallel`
 * runs the steps concurrently and keys the outputs by step id, `branch` runs the first step whose
 * condition is truthy and keys the output the same way, `foreach` maps an array through one step
 * through a concurrency gate and collects an array, `dowhile` / `dountil` fold a step until their
 * condition stops holding, and `sleep` waits in process for a resolved duration. Step-level
 * `retries` retry a failing `execute` at a fixed interval. IO validation (start input + every
 * step's input + a resume's resumeData) is always on, with the schema's value replacing the raw
 * data.
 *
 * Suspend/resume: a step's `suspend(payload)` unwinds the run at a top-level `then` entry — the
 * step is recorded `suspended`, the run's JSON snapshot is written to the `WorkflowSnapshotStore`
 * (2 methods, JSON-only; the in-memory default ships with the core) and the outcome envelope reads
 * `suspended`. `resume` loads the snapshot, validates `resumeData` against the step's
 * `resumeSchema` and re-enters the walk from the snapshot's position, replaying the completed
 * entries from the records instead of re-running them; concurrent resumes of one run are
 * deduplicated in process. Snapshots are written at fixed points — every completed entry with
 * attached storage, plus suspend and the terminal state — never through hooks; a run with a tracer
 * writes the trace it was exported under into the snapshot, so a resumed segment continues the same
 * trace. A tracer attached to the definition opens `workflow-run` / `workflow-step` spans at the same
 * boundaries (run span: input = the validated trigger input, output = the outcome envelope; step
 * span: name = step id, one per execution), and an absent tracer means no span object is ever
 * created. Spec: `docs/architecture/workflows.md`.
 */
export { createStep } from './step.js';
export type { Step, StepConfig, StepContext } from './step.js';
export { createWorkflow } from './workflow.js';
export type { Workflow, WorkflowBuilder, WorkflowConfig } from './workflow.js';
export { createWorkflowRun } from './run.js';
export type {
  WorkflowCreateRunOptions,
  WorkflowResumeOptions,
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunOutput,
  WorkflowRunSuccessOutcome,
  WorkflowRunSuspendedOutcome,
  WorkflowStartOptions,
} from './run.js';
export { WorkflowValidationError } from './validate.js';
export { createInMemorySnapshotStore } from './in-memory-snapshot-store.js';
export type {
  BranchCondition,
  BranchEntry,
  BranchPair,
  DountilEntry,
  DowhileEntry,
  ForeachEntry,
  LoopCondition,
  ParallelEntry,
  SleepDuration,
  SleepEntry,
  ThenEntry,
  WorkflowEntry,
} from './entry.js';
export type {
  StepStatus,
  WorkflowEvent,
  WorkflowRunEndEvent,
  WorkflowRunStartEvent,
  WorkflowStepEndEvent,
  WorkflowStepStartEvent,
} from './events.js';
export type {
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshotStore,
  WorkflowStepResultSnapshot,
} from './snapshot.js';
export type {
  StandardJSONSchemaV1,
  StandardSchema,
  StandardSchemaV1,
  StandardTypedV1,
} from '../standard-schema.js';
