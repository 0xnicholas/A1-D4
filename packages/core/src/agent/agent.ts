import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '../model/contract.js';
import { assertModelChain } from '../model/fallback.js';
import { assertModel } from '../model/resolve.js';
import type { Memory, MemoryThreadRef } from '../memory/index.js';
import type { Tracer } from '../observability/index.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { Tool } from '../tools/index.js';
import { toModelTools } from '../tools/to-model-tools.js';
import { resolveDynamicArgument } from './dynamic.js';
import { DEFAULT_MAX_STEPS, runAgentLoop } from './loop.js';
import type { AgentRunMemory, AgentTracing } from './loop.js';
import { runProcessInput } from './processors.js';
import type { Processor } from './processors.js';
import { createAgentStream } from './stream.js';
import { toStructuredResponseFormat } from './structured-output.js';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentMemoryOptions,
  AgentRunOptions,
  AgentStreamResult,
  DynamicArgument,
  ModelInput,
  RequestContext,
  StructuredOutputConfig,
} from './types.js';

/**
 * The framework's execution unit: the config surface wrapped into an object that can `generate()`
 * and `stream()`. Independent `new Agent(...)` is first-class; nothing else has to be instantiated
 * (ADR-0002 / ADR-0005).
 */
export class Agent {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions, static or resolved per request context. */
  readonly instructions: DynamicArgument<string>;
  /** The model(s) of every run — an instance, a fallback chain, or a resolver that picks either per run. */
  readonly model: ModelInput;
  /** Tool container (key = tool name) — a static container, a per-run resolver, or `undefined`. */
  readonly tools: DynamicArgument<Record<string, Tool>> | undefined;
  /** Description shown to an upstream model when composed as a tool (static or per-context). */
  readonly description: DynamicArgument<string> | undefined;
  /**
   * The memory subsystem instance of the agent's runs — static, or resolved per run like every
   * other field. The per-call `memory` option names the thread/resource; without one the run does
   * no memory I/O (`AgentConfig.memory`).
   */
  readonly memory: DynamicArgument<Memory> | undefined;
  /**
   * The observability seam, kept off the instance surface: a cross-cutting dependency the
   * composition root (or an explicit `new`) hands in, not a config field. `undefined`
   * = no span object is ever created for this agent's runs.
   */
  #tracer: Tracer | undefined;
  /**
   * The run's processors, in declaration order — the cross-cutting extension point, kept off the
   * instance surface like `tracer` (`AgentConfig.processors`). Empty = no processor runs.
   */
  #processors: readonly Processor[];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    // Resolution-time hard assertion (ADR-0004): a static model of the wrong specification version
    // — or not a language model at all — fails here, before any run, and so does a bad candidate
    // of a static fallback chain. A resolver's pick is asserted when the run resolves it
    // (`resolveModels`), so both paths fail before a model call.
    this.model = typeof config.model === 'function' ? config.model : assertModelField(config.model);
    this.tools = config.tools;
    this.description = config.description;
    this.memory = config.memory;
    this.#tracer = config.tracer;
    this.#processors = config.processors ?? [];
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
   *
   * `structuredOutput` asks for a structured answer: the model calls carry the schema as JSON
   * Schema and the run's terminal text must validate against it, strictly — the validated value is
   * the result's `object` (`docs/architecture/agent.md`「执行语义」).
   */
  stream<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): AgentStreamResult<StandardSchemaV1.InferOutput<TSchema>>;
  stream(input: string | ModelMessage[], options?: AgentRunOptions): AgentStreamResult;
  stream(input: string | ModelMessage[], options: AgentRunOptions = {}): AgentStreamResult {
    const model = this.model;
    const name = this.name;
    const instructions = this.instructions;
    const tools = this.tools;
    const memory = this.memory;
    const tracer = this.#tracer;
    const processors = this.#processors;
    return createAgentStream(async function* () {
      // The run's request context comes first: every dynamic field resolves against it, and the
      // tools of the run receive the very same object.
      const requestContext = toRequestContext(options);
      const [resolvedInstructions, resolvedModels, resolvedTools, resolvedMemory] =
        await Promise.all([
          resolveDynamicArgument(instructions, requestContext),
          resolveModels(model, requestContext),
          resolveDynamicArgument(tools, requestContext),
          resolveDynamicArgument(memory, requestContext),
        ]);
      const inputMessages = toInputMessages(input);
      const runMemory = toRunMemory(resolvedMemory, options.memory, inputMessages);
      // Message history is recalled once per run, before the input processors run (`memory.md`
      // 「消息历史」时机): the history is part of the prompt the model sees, and of what
      // `processInput` observes. A run with no memory identity recalls nothing.
      const history =
        runMemory === undefined
          ? []
          : await runMemory.memory.recall({ threadId: runMemory.threadId });
      // Call options are built per run — they are part of the run, not of creating the object.
      const { prompt, callOptions } = toCallOptions(
        resolvedInstructions,
        history,
        inputMessages,
        resolvedTools,
        options,
      );
      // The processors' input hook runs once per run, before the first model call: the prompt it
      // returns is what the model sees (and the run's span records as input).
      return yield* runAgentLoop({
        models: resolvedModels,
        agentName: name,
        prompt: await runProcessInput(processors, prompt, requestContext),
        callOptions,
        tools: resolvedTools ?? {},
        maxSteps: toMaxSteps(options.maxSteps),
        processors,
        requestContext,
        // The run's memory wiring: the loop saves once per step (the first save carries the run's
        // input messages). `undefined` = no memory I/O.
        memory: runMemory,
        tracing: toTracing(tracer, options),
        // The user's model call settings are recorded on the step span under this name.
        parameters: options.modelSettings,
        structuredOutput: options.structuredOutput,
      });
    });
  }

  /**
   * Runs the agent once and returns the terminal result — literally `stream()` awaited to its end.
   *
   * `generate()` and `stream()` share the single code path, so their terminal values always agree.
   */
  async generate<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): Promise<AgentGenerateResult<StandardSchemaV1.InferOutput<TSchema>>>;
  async generate(input: string | ModelMessage[], options?: AgentRunOptions): Promise<AgentGenerateResult>;
  async generate(
    input: string | ModelMessage[],
    options: AgentRunOptions = {},
  ): Promise<AgentGenerateResult> {
    const result = this.stream(input, options);
    const [text, object, toolCalls, toolResults, usage, finishReason, steps] = await Promise.all([
      result.text,
      result.object,
      result.toolCalls,
      result.toolResults,
      result.usage,
      result.finishReason,
      result.steps,
    ]);

    return { text, object, toolCalls, toolResults, usage, finishReason, steps };
  }
}

/**
 * The `model` field's static shapes (`ModelInput`): a model instance, or a fallback chain (an array
 * of instances). Asserted at construction time and returned unchanged — the agent holds the very
 * value it was given.
 */
function assertModelField(value: unknown): Model | readonly Model[] {
  return Array.isArray(value) ? assertModelChain(value) : assertModel(value);
}

/**
 * Resolves the run's model fallback chain and asserts every candidate against the model contract
 * (ADR-0004): a model of the wrong specification version — or not a language model at all — fails
 * here, before the run's first model call, whichever shape picked it. (A static field was already
 * asserted when the agent was built; asserting it again per run keeps both paths on one rule.)
 *
 * A single model is a one-element chain: the loop then walks a chain of one, which is the same
 * behavior as not having a fallback at all.
 */
async function resolveModels(model: ModelInput, ctx: RequestContext): Promise<readonly Model[]> {
  const resolved = await resolveDynamicArgument(model, ctx);
  return Array.isArray(resolved) ? assertModelChain(resolved) : [assertModel(resolved)];
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
  history: readonly ModelMessage[],
  inputMessages: readonly ModelMessage[],
  tools: Record<string, Tool> | undefined,
  options: AgentRunOptions,
): { prompt: ModelPrompt; callOptions: Omit<ModelCallOptions, 'prompt'> } {
  const callOptions: Omit<ModelCallOptions, 'prompt'> = { ...options.modelSettings };
  if (tools !== undefined && Object.keys(tools).length > 0) {
    callOptions.tools = toModelTools(tools);
  }
  // A structured run owns `responseFormat` on every model call: the schema tells the provider the
  // shape to answer in, so the run's terminal text can be validated (strict) instead of hoped for.
  // Written after the `modelSettings` spread like the other framework-owned fields.
  if (options.structuredOutput !== undefined) {
    callOptions.responseFormat = toStructuredResponseFormat(options.structuredOutput);
  }
  if (options.signal !== undefined) callOptions.abortSignal = options.signal;
  if (options.providerOptions !== undefined) callOptions.providerOptions = options.providerOptions;
  return { prompt: toPrompt(instructions, history, inputMessages), callOptions };
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
    structuredOutput: _structuredOutput,
    memory: _memory,
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
 *
 * Empty-string continuation ids mean "no trace", not a parent with an empty id: the tool context
 * encodes an untraced call as `traceId: ''` / `spanId: ''` (`NoOpSpan` / no tracer), and an as-tool
 * delegation passes them through verbatim — such a run starts its own trace instead of hanging off
 * a nonexistent parent (`docs/architecture/agent.md`「多 agent 组合」). An empty trace id voids the
 * whole pair (a parent outside a trace means nothing); an empty parent id only drops the parent.
 * A real parent id without any trace id is still left for the tracer to reject loudly.
 */
function toTracing(tracer: Tracer | undefined, options: AgentRunOptions): AgentTracing | undefined {
  if (tracer === undefined) return undefined;
  const traceId = options.traceId === '' ? undefined : options.traceId;
  const parentSpanId =
    options.traceId === '' || options.parentSpanId === '' ? undefined : options.parentSpanId;
  return {
    tracer,
    ...(traceId === undefined ? {} : { traceId }),
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(options.hideInput === undefined ? {} : { hideInput: options.hideInput }),
    ...(options.hideOutput === undefined ? {} : { hideOutput: options.hideOutput }),
  };
}

/** A signal that never aborts — the `signal` of runs that were started without one. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * Builds the run's prompt (`docs/architecture/agent.md`「执行语义」): the resolved instructions as
 * the system message, the recalled message history (empty without memory), then the run's own
 * input — the order the model sees and the input processors may rewrite.
 */
function toPrompt(
  instructions: string,
  history: readonly ModelMessage[],
  inputMessages: readonly ModelMessage[],
): ModelPrompt {
  return [{ role: 'system', content: instructions }, ...history, ...inputMessages];
}

/**
 * Normalizes the run's input to prompt messages: a string becomes one user text message (the exact
 * shape the prompt carries), an array is kept as given. These are also the messages the first
 * memory save persists alongside the first step's record — `memory.md`「消息历史」时机:首轮含用户
 * 输入消息。
 */
function toInputMessages(input: string | ModelMessage[]): ModelMessage[] {
  return typeof input === 'string'
    ? [{ role: 'user', content: [{ type: 'text', text: input }] }]
    : [...input];
}

/**
 * Resolves the run's memory wiring (`AgentConfig.memory` × the per-call `memory` option,
 * `docs/architecture/memory.md`「身份模型」): no instance and no option = a stateless run, no
 * instance but an option = a call-time error, instance plus option = the run's memory identity.
 * A `memory` option with either field missing is rejected the same way — the identity is explicit,
 * never defaulted.
 */
function toRunMemory(
  memory: Memory | undefined,
  option: AgentMemoryOptions | undefined,
  inputMessages: readonly ModelMessage[],
): AgentRunMemory | undefined {
  if (memory === undefined) {
    if (option !== undefined) {
      throw new Error(
        'The run passed a memory option, but the agent has no memory configured (AgentConfig.memory).',
      );
    }
    return undefined;
  }
  if (option === undefined) return undefined;
  const threadId = threadIdOf(option.thread);
  if (typeof option.resource !== 'string' || option.resource === '') {
    throw new Error(
      'The run memory option is missing its resource: pass memory: { thread, resource } with both fields.',
    );
  }
  return { memory, threadId, thread: option.thread, resource: option.resource, inputMessages };
}

/** The thread id of a per-call memory identity — the string form, or the `id` of the ref object. */
function threadIdOf(thread: MemoryThreadRef | undefined): string {
  const id = typeof thread === 'string' ? thread : thread?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      'The run memory option is missing its thread: pass memory: { thread, resource } with both fields.',
    );
  }
  return id;
}
