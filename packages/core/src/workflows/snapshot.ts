/**
 * The workflow snapshot shapes and the snapshot storage port (`docs/architecture/workflows.md`
 * 「suspend/resume 与快照」、「storage port」;ADR-0010). Shapes are spec-pinned and JSON-only: the
 * store receives serializable values — large data is referenced, never embedded.
 *
 * The port is the wiring slot `createWorkflow({ storage })` reserves: attach an adapter, or attach
 * nothing and the core's in-memory default (`in-memory-snapshot-store.ts`) keeps the run's
 * snapshots for this process only.
 */

/** The run status a snapshot carries. Terminal runs are the three-state machine; `running` only appears mid-run. */
export type WorkflowRunStatus = 'running' | 'success' | 'failed' | 'suspended';

/**
 * One step's recorded result inside a snapshot: status, output, boundary timestamps and the
 * suspend payload when the step suspended.
 */
export interface WorkflowStepResultSnapshot {
  readonly status: 'success' | 'failed' | 'suspended';
  /** The step's validated output; absent when it suspended or failed. */
  readonly output?: unknown;
  /** When the step started, milliseconds since epoch. */
  readonly startedAt?: number;
  /** When the step ended, milliseconds since epoch. */
  readonly endedAt?: number;
  /** The payload `suspend(payload)` carried; present only on a suspended step. */
  readonly suspendPayload?: unknown;
}

/**
 * One run's JSON-serializable state (`docs/architecture/workflows.md`「suspend/resume 与快照」):
 * the run identity, its status, the input it started with, the per-step results and the flat entry
 * position to re-enter from — the `startIdx` equivalent.
 */
export interface WorkflowRunSnapshot {
  /** Identity of the run this snapshot belongs to. */
  readonly runId: string;
  /** Run status at write time (`running` for step-boundary snapshots). */
  readonly status: WorkflowRunStatus;
  /** The run's start input (JSON-only; large data by reference). */
  readonly input: unknown;
  /** Per-step results, keyed by step id. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
  /** Position in the flat entry list to re-enter from on resume. */
  readonly position: number;
}

/**
 * The workflow snapshot storage port (`docs/architecture/workflows.md`「storage port」): two
 * methods, JSON-only snapshots. Core ships an in-memory default — a workflow without storage runs
 * purely in memory. Evolution is additive-only (ADR-0010): new capabilities arrive as optional
 * methods plus capability flags, never by changing these signatures.
 */
export interface WorkflowSnapshotStore {
  /** Fetch the latest snapshot of a run; `null` when the store has none. */
  load(runId: string): Promise<WorkflowRunSnapshot | null>;
  /** Write the run's snapshot, replacing the previous one. */
  save(runId: string, snapshot: WorkflowRunSnapshot): Promise<void>;
}
