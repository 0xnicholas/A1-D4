import type { FinishReason, Usage } from '../model/chunks.js';
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

/** The terminal result of `generate()`. */
export interface AgentGenerateResult {
  /** The text the model produced, concatenated across text deltas. */
  readonly text: string;
  /** Token usage of the model call. */
  readonly usage: Usage;
  /** Why the model stopped: `'stop'` / `'length'` / `'tool-calls'` / `'error'`. */
  readonly finishReason: FinishReason;
}
