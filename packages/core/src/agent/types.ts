import type {
  Chunk,
  FinishReason,
  ToolCallChunk,
  ToolResultChunk,
  Usage,
} from '../model/chunks.js';
import type { Model, ModelCallOptions, ModelProviderOptions } from '../model/contract.js';
import type { Tracer } from '../observability/index.js';
import type { Tool } from '../tools/index.js';

/**
 * The five-field Agent surface (`docs/architecture/agent.md`): `name`, `instructions`, `model`,
 * optional `tools`, optional `description` — nothing beyond it.
 *
 * `tracer` is not a sixth definition field: it is the observability injection seam of
 * `docs/architecture/observability.md`「组合根分发」— a cross-cutting dependency the composition
 * root hands to the subsystem (`createApp({ tracer })`), which a standalone `new` may also pass
 * explicitly. Not attaching it leaves the whole observability subsystem at zero overhead.
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
  /**
   * The tracer this agent reports to, when one is attached (the composition root distributes it;
   * a standalone `new` may pass it explicitly). Absent = no span is ever created for its runs.
   */
  readonly tracer?: Tracer | undefined;
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
 * The context of one run, resolved per call (`docs/architecture/agent.md`「定义表面」): the
 * framework writes `signal` and `runId`, everything else is the user's per-call open bag. A plain
 * object — no `Map` class, no generic context parameter.
 *
 * Dynamic argument resolution and tool `ctx.requestContext` both read the same object; the
 * framework-written fields come last, so a per-call property cannot hijack them.
 */
export interface RequestContext {
  /** Cancellation of this run — the per-call `signal`, or a never-aborting signal when none was passed. */
  readonly signal: AbortSignal;
  /** Identity of this run (generated per run). */
  readonly runId: string;
  /** User per-call properties, passed through untouched. */
  readonly [key: string]: unknown;
}

/**
 * Per-call execution options. The open bag below is the user's per-call request context
 * (`RequestContext`'s user properties); M1-10 (#31) plumbs it into dynamic-argument resolution.
 */
export interface AgentRunOptions {
  /** Passthrough bag for the model call (temperature, maxOutputTokens, …). */
  readonly modelSettings?: ModelSettings;
  /** Provider-specific options, forwarded to the model call untouched. */
  readonly providerOptions?: ModelProviderOptions;
  /** Cancels the run — propagated to the model call, the tool loop and every tool context. */
  readonly signal?: AbortSignal;
  /**
   * The step cap: how many model calls one run may make (`docs/architecture/agent.md`「Agent
   * loop」). When the cap is reached while the model still asks for tools, the terminal
   * `finishReason` is `'tool-calls'`. Defaults to 5.
   */
  readonly maxSteps?: number;
  /**
   * The trace to continue: the run's `agent-run` span attaches to a trace started elsewhere (an
   * incoming `traceparent`, a parent run — as-tool composition reads it from the tool context).
   * Absent = the run starts a fresh trace. Only meaningful with an attached tracer.
   */
  readonly traceId?: string | undefined;
  /**
   * The parent span inside the continued trace; requires `traceId` (the tracer rejects one without
   * the other). Absent = the run's `agent-run` span hangs directly under the continued trace.
   */
  readonly parentSpanId?: string | undefined;
  /**
   * Erase `input` from every exported event of this run's trace, overriding the tracer-level
   * default for this run. Trace-level: decided on the run's root span, inherited by its children.
   */
  readonly hideInput?: boolean | undefined;
  /** Erase `output` from every exported event of this run's trace (see `hideInput`). */
  readonly hideOutput?: boolean | undefined;
  /** User per-call request context properties. */
  readonly [key: string]: unknown;
}

/**
 * One step of a run: a single model call and the chunks the chunk protocol carried for it
 * (`docs/architecture/agent.md`「steps[]」). The step's tool calls are recorded as the protocol
 * saw them; the built-in loop executes the client-side ones and appends their results to this same
 * step (results belong to the step whose calls they answer, even though they arrive after its
 * `finish` chunk).
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
 * The remaining getter the Agent spec enumerates lands with its feature: `object` with
 * `structuredOutput` (M1-13, #34). Widening the surface is additive.
 */
export interface AgentStreamResult extends AsyncIterable<Chunk> {
  /** Text of the run's final step (intermediate steps' text is in `steps`). */
  readonly text: Promise<string>;
  /** Tool calls the model requested over the whole run — `steps` flattened, in step order. */
  readonly toolCalls: Promise<readonly ToolCallChunk[]>;
  /** Tool results recorded over the whole run (framework- and provider-executed) — `steps` flattened. */
  readonly toolResults: Promise<readonly ToolResultChunk[]>;
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
  /** Tool calls the model requested over the whole run — `steps` flattened, in step order. */
  readonly toolCalls: readonly ToolCallChunk[];
  /** Tool results recorded over the whole run (framework- and provider-executed) — `steps` flattened. */
  readonly toolResults: readonly ToolResultChunk[];
  /** Usage accumulated over the whole run. */
  readonly usage: Usage;
  /** Why the model stopped: `'stop'` / `'length'` / `'tool-calls'` / `'error'`. */
  readonly finishReason: FinishReason;
  /** Per-step records: text, tool calls, tool results and usage of each model call. */
  readonly steps: readonly AgentStep[];
}
