import type {
  Chunk,
  FinishReason,
  ToolCallChunk,
  ToolResultChunk,
  Usage,
} from '../model/chunks.js';
import type { Model, ModelCallOptions, ModelProviderOptions } from '../model/contract.js';
import type { Tool } from '../tools/index.js';

/**
 * The five-field Agent surface (`docs/architecture/agent.md`): `name`, `instructions`, `model`,
 * optional `tools`, optional `description` — nothing beyond it.
 *
 * This is the static-value version of the final surface. Dynamic arguments
 * (`T | ((ctx: RequestContext) => T)`), the `ModelInput` fallback/function shapes, and the
 * `memory` field land with their own M1 tickets; widening a field is additive.
 */
export interface AgentConfig {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions for every run — a plain string (no message-union passthrough). */
  readonly instructions: string;
  /**
   * The language model instance to run. Any AI SDK provider package instance satisfies it
   * structurally; a wrong specification version fails loudly when the Agent is constructed.
   */
  readonly model: Model;
  /** Tool container — the Record key is the tool name. Static for now (M1-10 dynamicizes it). */
  readonly tools?: Record<string, Tool>;
  /** Shown to an upstream model when the agent is composed as a tool. */
  readonly description?: string;
}

/**
 * The model-call settings a run may forward: everything the provider spec's call options accept
 * except the fields the framework owns — `prompt` (built from instructions + input),
 * `abortSignal` (from the run's `signal`), `providerOptions` (its own run option), and
 * `tools` / `toolChoice` / `responseFormat` (owned by their features).
 */
export type ModelSettings = Omit<
  ModelCallOptions,
  'prompt' | 'abortSignal' | 'providerOptions' | 'tools' | 'toolChoice' | 'responseFormat'
>;

/**
 * Per-call execution options. The open bag below is the user's per-call request context
 * (`RequestContext`'s user properties); M1-10 (#31) plumbs it into dynamic-argument resolution
 * and tool contexts.
 */
export interface AgentRunOptions {
  /** Passthrough bag for the model call (temperature, maxOutputTokens, …). */
  readonly modelSettings?: ModelSettings;
  /** Provider-specific options, forwarded to the model call untouched. */
  readonly providerOptions?: ModelProviderOptions;
  /** Cancels the run — propagated to the model call. */
  readonly signal?: AbortSignal;
  /** User per-call request context properties. */
  readonly [key: string]: unknown;
}

/**
 * One step of a run: a single model call and the chunks the chunk protocol carried for it
 * (`docs/architecture/agent.md`「steps[]」). The step's tool calls are recorded as the protocol
 * saw them; executing them and feeding results back is the built-in loop (M1-07, #28) — until
 * then a tool-requesting step only carries its `toolCalls` (and any provider-executed result).
 */
export interface AgentStep {
  /** The text the step produced, concatenated across its text deltas. */
  readonly text: string;
  /** Tool calls the model requested in this step, with their inputs parsed to JSON. */
  readonly toolCalls: readonly ToolCallChunk[];
  /** Tool results reported for this step (provider-executed ones so far). */
  readonly toolResults: readonly ToolResultChunk[];
  /** Token usage the model reported for this step. */
  readonly usage: Usage;
}

/**
 * The output object returned by `stream()`: one run, two consumption styles, one chunk pass
 * (`docs/architecture/agent.md`「输出对象」).
 *
 * - `for await (const chunk of result)` yields the core's own chunk protocol — never an AI SDK
 *   stream format (ADR-0004). The chunk stream is single-consumption; leaving the loop early
 *   (`break`) does not cancel the run, the terminal values still settle (cancellation is the
 *   per-call `signal`'s job).
 * - The terminal promises resolve with the run's final values. Reading one starts the run if it
 *   has not started yet; terminal values that are never read are never created, so a consumer
 *   that only iterates cannot be hit by unhandled rejections.
 *
 * The remaining getters the Agent spec enumerates land with their features: the run-level
 * `toolCalls` / `toolResults` with the built-in loop (M1-07, #28) and `object` with
 * `structuredOutput` (M1-13, #34). Widening the surface is additive.
 */
export interface AgentStreamResult extends AsyncIterable<Chunk> {
  /** Text of the run's final step (intermediate steps' text is in `steps`). */
  readonly text: Promise<string>;
  /** Per-step records: text, tool calls, tool results and usage of each model call. */
  readonly steps: Promise<readonly AgentStep[]>;
  /** Usage accumulated over the whole run. */
  readonly usage: Promise<Usage>;
  /** Why the last step stopped — the run's terminal reason. */
  readonly finishReason: Promise<FinishReason>;
}

/** The terminal result of `generate()`: `stream()`'s awaited terminal values. */
export interface AgentGenerateResult {
  /** Text of the run's final step (intermediate steps' text is in `steps`). */
  readonly text: string;
  /** Usage accumulated over the whole run. */
  readonly usage: Usage;
  /** Why the model stopped: `'stop'` / `'length'` / `'tool-calls'` / `'error'`. */
  readonly finishReason: FinishReason;
  /** Per-step records: text, tool calls, tool results and usage of each model call. */
  readonly steps: readonly AgentStep[];
}
