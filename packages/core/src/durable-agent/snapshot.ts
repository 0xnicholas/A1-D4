import type { ToolCallChunk } from '../model/chunks.js';
import type { ModelMessage } from '../model/contract.js';

/**
 * The durable run's snapshot shapes and their storage port (`docs/architecture/harness.md`
 * 「Durable agents」/「AgentRunSnapshotStore」;ADR-0010). Shapes are spec-pinned and JSON-only: the
 * store receives serializable values — large data is referenced, never embedded.
 *
 * Durable suspension happens at one boundary only — the approval gate of a tool-calling step — and
 * the store therefore holds one state, `suspended`. A run that resumed and completed writes no
 * terminal snapshot: the shape has no terminal status, and the application owns the entry's
 * lifecycle (dropping a snapshot it has consumed is the deployment side's call, exactly as
 * cross-process safety is).
 *
 * The port is the wiring slot `createDurableAgent({ storage })` reserves: attach an adapter, or
 * attach nothing and the core's in-memory default (`in-memory-snapshot-store.ts`) keeps the run's
 * snapshots for this process only.
 */

/**
 * What a suspended run held back at its suspension point — the wrapper's own state, persisted
 * alongside the message list (`harness.md`「挂起点」). It is what `resume` reads: the held calls
 * are the ones the loop executes (or answers) when the run continues, no model round trip spent
 * re-deriving them from the assistant message the prompt already ends with.
 */
export interface AgentRunSuspendPayload {
  /**
   * The calls the suspended step held back, in call order — the pending (framework-executed) calls
   * of the boundary, provider-executed ones excluded (they already carry their results in
   * `messages`). A resume either executes one or answers it with a pre-supplied result.
   */
  readonly toolCalls: readonly ToolCallChunk[];
  /**
   * Ids of the held calls whose execution the approval decision governs — the subset a resume's
   * `approved` decides. A gate that fired on the approval list holds its hits; a suspension
   * decided elsewhere (a caller's own `beforeToolCalls` hook) leaves the whole step's calls to the
   * decision. Held calls outside this list execute on either decision.
   */
  readonly awaitingApproval: readonly string[];
}

/**
 * One run's JSON-serializable state at its suspension point (`harness.md`「AgentRunSnapshotStore」):
 * the run identity (the key `resume(runId)` loads by), the message list the run stopped at — the
 * loop's prompt plus the suspended step's own raw assistant message (its text, its calls, any
 * provider-executed results) — the count of steps the run had completed, the suspension payload,
 * and the trace the run's spans were exported under, so a resume continues the same trace
 * (`docs/architecture/observability.md`:一次 HITL 交互 = 同 trace 多 span).
 * The shape is frozen: evolution of the port is additive-only (ADR-0010).
 */
export interface AgentRunSnapshot {
  /** Identity of the run (snapshots, spans and `resume`); minted by the wrapper per run. */
  readonly runId: string;
  /** The one state the store holds — a run that suspends, resumed or not, is `suspended` here. */
  readonly status: 'suspended';
  /** The run's message list at the boundary: prompt + the suspended step's raw assistant message. */
  readonly messages: readonly ModelMessage[];
  /** How many steps the run had completed when it suspended — where a resume continues numbering. */
  readonly stepCount: number;
  /** What the step held back (see `AgentRunSuspendPayload`). */
  readonly suspendPayload: AgentRunSuspendPayload;
  /**
   * The trace the run's spans were exported under (32-hex), written whenever a real span exists —
   * an untraced run, or one whose trace the sampler rejected, carries no id. A resume starts a new
   * `agent-run` span in this trace, so a suspension does not break the observation tree.
   */
  readonly traceId?: string;
}

/**
 * The durable run snapshot storage port (`harness.md`「AgentRunSnapshotStore」): two methods,
 * JSON-only snapshots, isomorphic to `WorkflowSnapshotStore`. Core ships an in-memory default — a
 * durable agent without storage keeps its snapshots for this process only. Evolution is
 * additive-only (ADR-0010): new capabilities arrive as optional methods plus capability flags
 * (the adapter family's `deleteSnapshot` / `listSuspended`), never by changing these signatures.
 * No CAS — durable does no multi-replica recovery; cross-process safety is the deployer's.
 */
export interface AgentRunSnapshotStore {
  /** Fetch the latest snapshot of a run; `null` when the store has none. */
  load(runId: string): Promise<AgentRunSnapshot | null>;
  /** Write the run's snapshot, replacing the previous one. */
  save(runId: string, snapshot: AgentRunSnapshot): Promise<void>;
}
