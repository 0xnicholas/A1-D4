/**
 * `@balsa/core/workflows` — workflow engine.
 *
 * The definition surface: `createStep` (id + IO schemas + optional resume/suspend schemas +
 * retries + execute), the `StepContext` bag every step executes with, and the mutable
 * `createWorkflow` builder whose seven operators (then / parallel / branch / foreach / dowhile /
 * dountil / sleep) each push one flat `{ type, … }` entry until `.commit()` freezes the
 * definition. Type safety rides a type-state: `then` is strict, parallel/branch infer keyed
 * objects. Suspend/resume snapshots speak the `WorkflowSnapshotStore` port (2 methods,
 * JSON-only) — the in-memory default lands with #51; the walker and run surface with #48.
 * Spec: `docs/architecture/workflows.md`.
 */
export { createStep } from './step.js';
export type { Step, StepConfig, StepContext } from './step.js';
export { createWorkflow } from './workflow.js';
export type { Workflow, WorkflowBuilder, WorkflowConfig } from './workflow.js';
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
