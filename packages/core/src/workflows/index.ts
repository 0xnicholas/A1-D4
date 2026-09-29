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
 * The run surface: a committed workflow's `createRun` gives a run identity, and `start` returns
 * the output object whose `result` resolves the run's outcome envelope (or rejects when the run
 * fails). Start is lazy — the walker executes on the first read. The walker interprets the flat
 * entry list in order: `then` pipes the previous output on, `parallel` runs the steps concurrently
 * and keys the outputs by step id, `branch` runs the first step whose condition is truthy and keys
 * the output the same way, `foreach` maps an array through one step through a concurrency gate and
 * collects an array, `dowhile` / `dountil` fold a step until their condition stops holding, and
 * `sleep` waits in process for a resolved duration. Step-level `retries` retry a failing `execute`
 * at a fixed interval. IO validation (start input + every
 * step's input) is always on, with the schema's value replacing the raw data. Suspend/resume
 * snapshots speak the `WorkflowSnapshotStore` port (2 methods, JSON-only) — the in-memory default
 * lands with #51. Spec: `docs/architecture/workflows.md`.
 */
export { createStep } from './step.js';
export type { Step, StepConfig, StepContext } from './step.js';
export { createWorkflow } from './workflow.js';
export type { Workflow, WorkflowBuilder, WorkflowConfig } from './workflow.js';
export { createWorkflowRun } from './run.js';
export type {
  WorkflowCreateRunOptions,
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunOutput,
  WorkflowStartOptions,
} from './run.js';
export { WorkflowValidationError } from './validate.js';
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
