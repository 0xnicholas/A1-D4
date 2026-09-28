import type { FinishChunk } from '../model/chunks.js';
import { normalizeStream } from '../model/normalize.js';
import { ModelContractError, assertModel } from '../model/resolve.js';
import type { Model, ModelCallOptions, ModelMessage, ModelPrompt } from '../model/contract.js';
import type { Tool } from '../tools/index.js';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
} from './types.js';

/**
 * The framework's execution unit: five config fields wrapped into an object that can
 * `generate()` (and, from M1-05 on, `stream()`). Independent `new Agent(...)` is first-class;
 * nothing else has to be instantiated (ADR-0002 / ADR-0005).
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
   * Runs the agent once and returns the terminal result.
   *
   * The model is consumed through its streaming interface and normalized into the core's own
   * chunk protocol — `stream()` (M1-05) will expose that same flow.
   *
   * Tool calls are not executed yet (the built-in loop lands with M1-07): a tool-requesting step
   * returns `finishReason: 'tool-calls'` with its `tool-call` chunks dropped.
   */
  async generate(
    input: string | ModelMessage[],
    options: AgentRunOptions = {},
  ): Promise<AgentGenerateResult> {
    const callOptions: ModelCallOptions = {
      ...options.modelSettings,
      prompt: toPrompt(this.instructions, input),
    };
    if (options.signal !== undefined) callOptions.abortSignal = options.signal;
    if (options.providerOptions !== undefined) callOptions.providerOptions = options.providerOptions;

    const { stream } = await this.model.doStream(callOptions);

    let text = '';
    let finish: FinishChunk | undefined;
    for await (const chunk of normalizeStream(stream)) {
      if (chunk.type === 'text-delta') {
        text += chunk.textDelta;
      } else if (chunk.type === 'finish') {
        finish = chunk;
      }
    }

    if (finish === undefined) {
      throw new ModelContractError(
        'The model stream ended without a finish part, so finishReason and usage are unknown. ' +
          'The model does not implement the streaming contract of the AI SDK provider specification.',
      );
    }

    return { text, usage: finish.usage, finishReason: finish.finishReason };
  }
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
