import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '../model/contract.js';
import { assertModel } from '../model/resolve.js';
import type { Tracer } from '../observability/index.js';
import type { Tool } from '../tools/index.js';
import { toModelTools } from '../tools/to-model-tools.js';
import { resolveDynamicArgument } from './dynamic.js';
import { DEFAULT_MAX_STEPS, runAgentLoop } from './loop.js';
import type { AgentTracing } from './loop.js';
import { createAgentStream } from './stream.js';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
  AgentStreamResult,
  DynamicArgument,
  ModelInput,
  RequestContext,
} from './types.js';

/**
 * The framework's execution unit: five config fields wrapped into an object that can `generate()`
 * and `stream()`. Independent `new Agent(...)` is first-class; nothing else has to be instantiated
 * (ADR-0002 / ADR-0005).
 */
export class Agent {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions, static or resolved per request context. */
  readonly instructions: DynamicArgument<string>;
  /** The model of every run — the instance itself, or a resolver that picks one per run. */
  readonly model: ModelInput;
  /** Tool container (key = tool name) — a static container, a per-run resolver, or `undefined`. */
  readonly tools: DynamicArgument<Record<string, Tool>> | undefined;
  /** Description shown to an upstream model when composed as a tool (static or per-context). */
  readonly description: DynamicArgument<string> | undefined;
  /**
   * The observability seam, kept off the instance surface: a cross-cutting dependency the
   * composition root (or an explicit `new`) hands in, not part of the five config fields. `undefined`
   * = no span object is ever created for this agent's runs.
   */
  #tracer: Tracer | undefined;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    // Resolution-time hard assertion (ADR-0004): a static model of the wrong specification version
    // — or not a language model at all — fails here, before any run. A resolver's pick is asserted
    // when the run resolves it (`resolveModel`), so both paths fail before a model call.
    this.model = typeof config.model === 'function' ? config.model : assertModel(config.model);
    this.tools = config.tools;
    this.description = config.description;
    this.#tracer = config.tracer;
  }

  /**
   * Runs the agent once and returns the output object: `for await` consumes the core's own chunk
   * protocol, while `text` / `toolCalls` / `usage` / `finishReason` / `steps` are awaitable
   * terminal values on the same object. The run starts on first consumption.
   *
   * `instructions` / `model` / `tools` are resolved against this run's request context before the
   * first model call (`AgentConfig` dynamic arguments) — a per-call context changes them without
   * rebuilding the agent. The resolution context is the very object tools receive as
   * `ctx.requestContext`. (`description` is not part of a run: as-tool composition resolves it at
   * wrapping time — `resolveDynamicArgument`.)
   *
   * The built-in loop executes the tool calls a step requests (in call order), feeds the results
   * back to the model and repeats until a step requests no tool call or `maxSteps` is reached;
   * per-call behavior is controlled through `AgentRunOptions` — see `docs/architecture/agent.md`
   *「Agent loop」.
   */
  stream(input: string | ModelMessage[], options: AgentRunOptions = {}): AgentStreamResult {
    const model = this.model;
    const name = this.name;
    const instructions = this.instructions;
    const tools = this.tools;
    const tracer = this.#tracer;
    return createAgentStream(async function* () {
      // The run's request context comes first: every dynamic field resolves against it, and the
      // tools of the run receive the very same object.
      const requestContext = toRequestContext(options);
      const [resolvedInstructions, resolvedModel, resolvedTools] = await Promise.all([
        resolveDynamicArgument(instructions, requestContext),
        resolveModel(model, requestContext),
        resolveDynamicArgument(tools, requestContext),
      ]);
      // Call options are built per run — they are part of the run, not of creating the object.
      const { prompt, callOptions } = toCallOptions(
        resolvedInstructions,
        input,
        resolvedTools,
        options,
      );
      yield* runAgentLoop({
        model: resolvedModel,
        agentName: name,
        prompt,
        callOptions,
        tools: resolvedTools ?? {},
        maxSteps: toMaxSteps(options.maxSteps),
        requestContext,
        tracing: toTracing(tracer, options),
        // The user's model call settings are recorded on the step span under this name.
        parameters: options.modelSettings,
      });
    });
  }

  /**
   * Runs the agent once and returns the terminal result — literally `stream()` awaited to its end.
   *
   * `generate()` and `stream()` share the single code path, so their terminal values always agree.
   */
  async generate(
    input: string | ModelMessage[],
    options: AgentRunOptions = {},
  ): Promise<AgentGenerateResult> {
    const result = this.stream(input, options);
    const [text, toolCalls, toolResults, usage, finishReason, steps] = await Promise.all([
      result.text,
      result.toolCalls,
      result.toolResults,
      result.usage,
      result.finishReason,
      result.steps,
    ]);

    return { text, toolCalls, toolResults, usage, finishReason, steps };
  }
}

/**
 * Resolves the run's model and asserts it against the model contract (ADR-0004): a model of the
 * wrong specification version — or not a language model at all — fails here, before the run's first
 * model call, whichever shape picked it. (A static model was already asserted when the agent was
 * built; asserting it again per run keeps both paths on one rule.)
 */
async function resolveModel(model: ModelInput, ctx: RequestContext): Promise<Model> {
  return assertModel(await resolveDynamicArgument(model, ctx));
}

/**
 * Builds the model call inputs: the agent's instructions plus the input become the initial prompt,
 * the tool container becomes the provider tool list, and the per-call passthroughs ride along.
 * Framework-owned fields (`prompt` / `abortSignal` / `providerOptions` / `tools`) are written after
 * the `modelSettings` spread, so settings cannot hijack them. An agent without tools sends no
 * `tools` field at all; the loop writes `prompt` for every step.
 */
function toCallOptions(
  instructions: string,
  input: string | ModelMessage[],
  tools: Record<string, Tool> | undefined,
  options: AgentRunOptions,
): { prompt: ModelPrompt; callOptions: Omit<ModelCallOptions, 'prompt'> } {
  const callOptions: Omit<ModelCallOptions, 'prompt'> = { ...options.modelSettings };
  if (tools !== undefined && Object.keys(tools).length > 0) {
    callOptions.tools = toModelTools(tools);
  }
  if (options.signal !== undefined) callOptions.abortSignal = options.signal;
  if (options.providerOptions !== undefined) callOptions.providerOptions = options.providerOptions;
  return { prompt: toPrompt(instructions, input), callOptions };
}

/**
 * The request context of one run (`docs/architecture/agent.md`「定义表面」): the user's per-call
 * properties plus framework-written `signal` / `runId`, which are written last so a per-call
 * property cannot hijack them. The framework-owned run options (`maxSteps` / `modelSettings` /
 * `providerOptions`) are execution controls, not context, and are left out of the bag. The run id is
 * generated per run; without a per-call `signal` the context carries a never-aborting one, so tools
 * always receive an `AbortSignal`.
 *
 * One object per run serves both readers: every dynamic argument resolves against it, and tools
 * receive it as `ctx.requestContext`.
 */
function toRequestContext(options: AgentRunOptions): RequestContext {
  const {
    modelSettings: _modelSettings,
    providerOptions: _providerOptions,
    maxSteps: _maxSteps,
    traceId: _traceId,
    parentSpanId: _parentSpanId,
    hideInput: _hideInput,
    hideOutput: _hideOutput,
    signal,
    ...bag
  } = options;
  return {
    ...bag,
    signal: signal ?? NEVER_ABORTED,
    runId: crypto.randomUUID(),
  };
}

/** The step cap of a run: `maxSteps` when given, 5 (the documented default) otherwise. */
function toMaxSteps(maxSteps: number | undefined): number {
  const resolved = maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`maxSteps must be a positive integer, got ${String(resolved)}.`);
  }
  return resolved;
}

/**
 * The observability wiring of one run: `undefined` without a tracer, so the loop's only branch is
 * one presence check. The trace continuation and hiding options only mean something with a tracer,
 * hence the clump — they cannot travel alone.
 */
function toTracing(tracer: Tracer | undefined, options: AgentRunOptions): AgentTracing | undefined {
  if (tracer === undefined) return undefined;
  return {
    tracer,
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
    ...(options.hideInput === undefined ? {} : { hideInput: options.hideInput }),
    ...(options.hideOutput === undefined ? {} : { hideOutput: options.hideOutput }),
  };
}

/** A signal that never aborts — the `signal` of runs that were started without one. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * Builds the model prompt: the agent's instructions as a system message, then the input — either
 * a single user text message (string form) or the caller's messages passed through untouched.
 */
function toPrompt(instructions: string, input: string | ModelMessage[]): ModelPrompt {
  const messages: ModelPrompt = [{ role: 'system', content: instructions }];
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] });
  } else {
    messages.push(...input);
  }
  return messages;
}
