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
import type { Processor } from './processors.js';

/**
 * The five-field Agent surface (`docs/architecture/agent.md`): `name`, `instructions`, `model`,
 * optional `tools`, optional `description` — nothing beyond it.
 *
 * `tracer` is not a sixth definition field: it is the observability injection seam of
 * `docs/architecture/observability.md`「组合根分发」— a cross-cutting dependency the composition
 * root hands to the subsystem (`createApp({ tracer })`), which a standalone `new` may also pass
 * explicitly. Not attaching it leaves the whole observability subsystem at zero overhead.
 *
 * Every config field accepts a static value or a resolver (`DynamicArgument`), resolved again for
 * each run. The `memory` field lands with M2; widening a field is additive.
 */
export interface AgentConfig {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions for every run — a plain string (no message-union passthrough). */
  readonly instructions: DynamicArgument<string>;
  /**
   * The language model(s) to run — an instance, an array of instances forming a fallback chain
   * (`ModelInput`), or a resolver that picks either per request context. Any AI SDK provider
   * package instance satisfies the contract structurally; a wrong specification version fails
   * loudly when the field is resolved (at construction for a static value, at resolution time for
   * a resolver's pick).
   */
  readonly model: ModelInput;
  /** Tool container — the Record key is the tool name. Static, or resolved per request context. */
  readonly tools?: DynamicArgument<Record<string, Tool>>;
  /** Shown to an upstream model when the agent is composed as a tool (`resolveDynamicArgument`). */
  readonly description?: DynamicArgument<string>;
  /**
   * The tracer this agent reports to, when one is attached (the composition root distributes it;
   * a standalone `new` may pass it explicitly). Absent = no span is ever created for its runs.
   */
  readonly tracer?: Tracer | undefined;
  /**
   * The processors of this agent's runs — the cross-cutting extension point of
   * `docs/architecture/agent.md`「扩展点:Processor」(ADR-0005). Guardrails, evals, redaction and
   * rate limiting live here, never in Agent fields. Hooks run in declaration order, each seeing the
   * previous one's rewrite; absent = no processor runs.
   *
   * Not a definition field: like `tracer`, this is cross-cutting wiring the composition root (or an
   * explicit `new`) hands in — the attachment point of the extension point itself.
   */
  readonly processors?: readonly Processor[] | undefined;
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
 * The shape every Agent config field accepts (`docs/architecture/agent.md`「定义表面」): the value
 * itself, or a resolver that answers per request context — each run resolves its fields again, so a
 * per-call context changes behavior without rebuilding the agent.
 *
 * A `T` that is itself a function cannot be passed as a static value: function values are read as
 * resolvers. No config field has a function as its static value.
 */
export type DynamicArgument<T> = T | ((ctx: RequestContext) => T | Promise<T>);

/**
 * The `model` field's accepted shapes (`docs/architecture/model.md`「model 字段形状」): a model
 * instance satisfying the contract, an array of instances forming a fallback chain, or a resolver
 * that picks either per request context.
 *
 * A chain is tried in array order on every model call (`agent/loop.ts`): the call moves on to the
 * next candidate only while the current one has produced no chunk yet. A failure mid-stream
 * propagates — partial output has already reached the caller, and switching would splice two
 * models' answers together. When every candidate failed, the run fails with the original error if
 * there was only one, or with `ModelFallbackError` carrying the whole chain.
 */
export type ModelInput = DynamicArgument<Model | readonly Model[]>;

/**
 * Per-call execution options. The open bag below is the user's per-call request context
 * (`RequestContext`'s user properties): it is what dynamic arguments resolve against, and the very
 * same object is handed to tool contexts.
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
  /** Tool results reported for this step — provider-executed ones plus the framework-executed ones. */
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
