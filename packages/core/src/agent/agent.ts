import { normalizeStream } from '../model/normalize.js';
import { assertModel } from '../model/resolve.js';
import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '../model/contract.js';
import type { Tool } from '../tools/index.js';
import { createAgentStream } from './stream.js';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
  AgentStreamResult,
} from './types.js';

/**
 * The framework's execution unit: five config fields wrapped into an object that can `generate()`
 * and `stream()`. Independent `new Agent(...)` is first-class; nothing else has to be instantiated
 * (ADR-0002 / ADR-0005).
 */
export class Agent {
  /** Unique identity of the agent. */
  readonly name: string;
  /** System instructions for every run. */
  readonly instructions: string;
  /** The model instance, asserted against the model contract at construction time. */
  readonly model: Model;
  /** Tool container (key = tool name) — `undefined` when the agent has no tools. */
  readonly tools: Record<string, Tool> | undefined;
  /** Description shown to an upstream model when composed as a tool. */
  readonly description: string | undefined;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.instructions = config.instructions;
    // Resolution-time hard assertion (ADR-0004): a model of the wrong specification version —
    // or not a language model at all — fails here, not in the middle of a run.
    this.model = assertModel(config.model);
    this.tools = config.tools;
    this.description = config.description;
  }

  /**
   * Runs the agent once and returns the output object: `for await` consumes the core's own chunk
   * protocol, while `text` / `usage` / `finishReason` / `steps` are awaitable terminal values on
   * the same object. The run starts on first consumption.
   *
   * Tool calls are recorded on the step but not executed yet (the built-in loop lands with M1-07):
   * a tool-requesting step ends with `finishReason: 'tool-calls'`.
   */
  stream(input: string | ModelMessage[], options: AgentRunOptions = {}): AgentStreamResult {
    const model = this.model;
    const instructions = this.instructions;
    return createAgentStream(async function* () {
      // Call options are built per run — they are part of the run, not of creating the object.
      const callOptions = toCallOptions(instructions, input, options);
      const { stream } = await model.doStream(callOptions);
      yield* normalizeStream(stream);
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
    const [text, usage, finishReason, steps] = await Promise.all([
      result.text,
      result.usage,
      result.finishReason,
      result.steps,
    ]);

    return { text, usage, finishReason, steps };
  }
}

/**
 * Builds the model call options: the agent's instructions plus the input become the prompt, and
 * the per-call passthroughs ride along. Framework-owned fields (`prompt` / `abortSignal` /
 * `providerOptions`) are written after the `modelSettings` spread, so settings cannot hijack them.
 */
function toCallOptions(
  instructions: string,
  input: string | ModelMessage[],
  options: AgentRunOptions,
): ModelCallOptions {
  const callOptions: ModelCallOptions = {
    ...options.modelSettings,
    prompt: toPrompt(instructions, input),
  };
  if (options.signal !== undefined) callOptions.abortSignal = options.signal;
  if (options.providerOptions !== undefined) callOptions.providerOptions = options.providerOptions;
  return callOptions;
}

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
