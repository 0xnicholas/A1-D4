import type { DynamicArgument } from '../agent/types.js';
import type { Step, StepContext } from './step.js';

/**
 * The flat entry list (`docs/architecture/workflows.md`「Workflow 与 builder」): every builder
 * operator pushes one `{ type, … }` entry, and the walker is a `for` loop over this array — there
 * is no DAG. The entries carry the definition's child steps; execution semantics live in the
 * walker (`walker.ts`), not here.
 *
 * Conditions and dynamic durations are authored against the current chain tip (typed at the
 * builder seam) and erased into these runtime entries; the walker calls them with the live
 * context.
 */

/**
 * A branch condition (`docs/architecture/workflows.md`「控制流算子」): the same parameter bag a
 * step's `execute` receives, read-only in spirit; branches are evaluated in definition order and
 * the first truthy one runs.
 */
export type BranchCondition<TInputData = unknown> = (
  ctx: StepContext<TInputData>,
) => boolean | Promise<boolean>;

/**
 * A loop condition: the branch-condition bag plus `iterationCount`, so a condition can cap the
 * loop by throwing or by counting (`docs/architecture/workflows.md`「控制流算子」).
 */
export type LoopCondition<TInputData = unknown> = (
  ctx: StepContext<TInputData> & { readonly iterationCount: number },
) => boolean | Promise<boolean>;

/**
 * A sleep duration: milliseconds, or a `DynamicArgument` resolver — the framework's dynamic
 * argument convention (`CONTEXT.md`「动态参数」), resolved per run against the request context so
 * the `signal` reaches it.
 */
export type SleepDuration = DynamicArgument<number>;

/** `.then(step)`: run the step; its output pipes to the next entry. */
export interface ThenEntry {
  readonly type: 'then';
  readonly step: Step;
}

/** `.parallel([a, b])`: run the steps concurrently (`Promise.all`), collect `{ [step.id]: output }`. */
export interface ParallelEntry {
  readonly type: 'parallel';
  readonly steps: readonly Step[];
}

/** One authored branch pair: `[condition, step]`. */
export type BranchPair = readonly [BranchCondition, Step];

/** `.branch([[cond, step], …])`: first truthy condition runs; the output is a keyed object with one value. */
export interface BranchEntry {
  readonly type: 'branch';
  readonly branches: readonly BranchPair[];
}

/** `.foreach(step, { concurrency })`: run the step over the input array; `concurrency` defaults to 1. */
export interface ForeachEntry {
  readonly type: 'foreach';
  readonly step: Step;
  /**
   * Concurrency cap (gate width), normalized at definition time — `1` when the options were
   * omitted or the given cap was not a finite number ≥ 1, floored to an integer otherwise.
   */
  readonly concurrency: number;
}

/** `.dowhile(step, cond)`: run while the condition holds; output = the last iteration's output. */
export interface DowhileEntry {
  readonly type: 'dowhile';
  readonly step: Step;
  readonly cond: LoopCondition;
}

/** `.dountil(step, cond)`: run until the condition holds; output = the last iteration's output. */
export interface DountilEntry {
  readonly type: 'dountil';
  readonly step: Step;
  readonly cond: LoopCondition;
}

/** `.sleep(ms | fn)`: in-process `setTimeout` + `AbortSignal`, not durable. */
export interface SleepEntry {
  readonly type: 'sleep';
  readonly duration: SleepDuration;
}

/** The flat definition list a committed workflow walks. */
export type WorkflowEntry =
  | ThenEntry
  | ParallelEntry
  | BranchEntry
  | ForeachEntry
  | DowhileEntry
  | DountilEntry
  | SleepEntry;
