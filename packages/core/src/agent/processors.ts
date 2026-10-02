import type { ToolCallChunk } from '../model/chunks.js';
import type { ModelPrompt } from '../model/contract.js';
import type { AgentStep, RequestContext } from './types.js';

/**
 * The Processor surface (the Processor extension point, ADR-0005): the Agent's
 * only cross-cutting extension point. Guardrails, evals, redaction, rate limiting and the like are
 * processors — never fields of the Agent class.
 *
 * One processor declares up to three hooks, all optional; the ones it declares run in declaration
 * order, each receiving the previous one's output (`AgentConfig.processors`). A hook may be
 * synchronous or asynchronous, and returning nothing keeps the current value:
 *
 * - `processInput` — once per run, before the first model call: `{ messages }` replaces the run's
 *   prompt (instructions plus input), which is what the model then sees.
 * - `processOutputStep` — once per completed step, after that step's tools have run: `{ step }`
 *   replaces the step record. The replacement is the run's authoritative record — it lands in the
 *   output object's `steps` / `text` / `usage`, in the run span's output, and is what the next
 *   prompt (and memory) is built from. The chunk stream and the step span stay the
 *   model's own output: chunk-level rewriting is cut from v1 (`processOutputStream`-style hooks
 *   keep their seat).
 * - `processError` — when a provider call or a tool's `execute` fails: `{ error }` replaces the
 *   error. A replaced provider error becomes the run's error; a replaced tool error is the error
 *   the model sees in the error tool result. No abort/retry mechanics — a cancelled model call
 *   surfaces its own reason untouched, never as a `processError` event.
 *
 * Processor failures are the run's failure: an error thrown by a hook propagates out of the run and
 * is not offered to `processError` (a processor is not the place to handle another processor's
 * bug).
 */
export interface Processor {
  /** Run start, once: rewrite the initial prompt, or observe it untouched. */
  processInput?(
    args: ProcessInputArgs,
  ): ProcessInputResult | void | Promise<ProcessInputResult | void>;
  /** After each completed step: rewrite its record, or observe it untouched. */
  processOutputStep?(
    args: ProcessOutputStepArgs,
  ): ProcessOutputStepResult | void | Promise<ProcessOutputStepResult | void>;
  /** On a provider or tool error: replace the error, or observe it untouched. */
  processError?(args: ProcessErrorArgs): ProcessErrorResult | void | Promise<ProcessErrorResult | void>;
}

/** What `processInput` sees: the run's prompt as built from the resolved instructions plus input. */
export interface ProcessInputArgs {
  /**
   * The run's initial prompt — a system message with the resolved `instructions`, then the input
   * messages (`string` input becomes one user text message). What the model sees is the prompt
   * this hook chain returns: `processInput` runs after dynamic resolution, before the first call.
   */
  readonly messages: ModelPrompt;
  /** The run's request context — the same object dynamic arguments resolved against. */
  readonly requestContext: RequestContext;
}

/** The replacement `processInput` may return. */
export interface ProcessInputResult {
  /** The prompt from here on. */
  readonly messages: ModelPrompt;
}

/** What `processOutputStep` sees: the step's record once the step is complete. */
export interface ProcessOutputStepArgs {
  /** The completed step: text, tool calls, tool results (provider- and framework-executed), usage. */
  readonly step: AgentStep;
  /** Position of the step in the run, 0-based. */
  readonly stepIndex: number;
  /** The run's request context. */
  readonly requestContext: RequestContext;
}

/** The replacement `processOutputStep` may return. */
export interface ProcessOutputStepResult {
  /** The step record from here on — the run's authoritative record of this step. */
  readonly step: AgentStep;
}

/**
 * Where a failure happened — the part of `ProcessErrorArgs` that is not the error itself. The loop
 * names the site when it raises the error; `processError` receives it unchanged.
 */
export interface FailureSite {
  /**
   * Which boundary failed: `'model'` is a provider call that ended the step (chain exhausted,
   * mid-stream failure, contract violation); `'tool'` is a tool boundary failure — an `execute`
   * throw, or a failed input/output validation / unknown tool.
   */
  readonly source: 'model' | 'tool';
  /** Position of the step the failure happened in, 0-based. */
  readonly stepIndex: number;
  /** The call whose tool boundary failed — present exactly when `source` is `'tool'`. */
  readonly toolCall?: ToolCallChunk | undefined;
}

/** What `processError` sees: the failure and where it happened. */
export interface ProcessErrorArgs extends FailureSite {
  /** The failure — the original error object, untouched, until a processor replaces it. */
  readonly error: unknown;
  /** The run's request context. */
  readonly requestContext: RequestContext;
}

/** The replacement `processError` may return. */
export interface ProcessErrorResult {
  /**
   * The error from here on: the run's error when the source is `'model'`, the error the model sees
   * in the error tool result when the source is `'tool'`.
   */
  readonly error: unknown;
}

/**
 * Runs `processInput` across the processors in declaration order, threading the prompt through:
 * each hook sees the previous one's rewrite. Returns the final prompt (the original when no hook
 * touched it).
 */
export function runProcessInput(
  processors: readonly Processor[],
  messages: ModelPrompt,
  requestContext: RequestContext,
): Promise<ModelPrompt> {
  return thread(
    processors,
    messages,
    (processor, current) => processor.processInput?.({ messages: current, requestContext }),
    (result) => result.messages,
  );
}

/**
 * Runs `processOutputStep` across the processors in declaration order, threading the record
 * through: each hook sees the previous one's rewrite. Returns the final record — the run's
 * authoritative one (`steps`, `text`, `usage`, run span, next prompt).
 */
export function runProcessOutputStep(
  processors: readonly Processor[],
  step: AgentStep,
  stepIndex: number,
  requestContext: RequestContext,
): Promise<AgentStep> {
  return thread(
    processors,
    step,
    (processor, current) =>
      processor.processOutputStep?.({ step: current, stepIndex, requestContext }),
    (result) => result.step,
  );
}

/**
 * Runs `processError` across the processors in declaration order, threading the error through:
 * each hook sees the previous one's replacement. Returns the final error — the run's error, or the
 * error of the tool result being built.
 */
export function runProcessError(
  processors: readonly Processor[],
  error: unknown,
  site: FailureSite,
  requestContext: RequestContext,
): Promise<unknown> {
  return thread(
    processors,
    error,
    (processor, current) => processor.processError?.({ ...site, error: current, requestContext }),
    (result) => result.error,
  );
}

/**
 * The shared shape of the three hook pipelines: one value threaded through the processors in
 * declaration order — a hook returning a replacement feeds it to the next processor, `void` or an
 * absent hook keeps the current value.
 */
async function thread<TValue, TResult>(
  processors: readonly Processor[],
  value: TValue,
  hook: (
    processor: Processor,
    value: TValue,
  ) => TResult | void | Promise<TResult | void> | undefined,
  extract: (result: TResult) => TValue,
): Promise<TValue> {
  let current = value;
  for (const processor of processors) {
    const result = await hook(processor, current);
    if (result !== undefined) current = extract(result);
  }
  return current;
}
