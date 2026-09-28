import type { Chunk, FinishChunk, ToolCallChunk, ToolResultChunk } from '../model/chunks.js';
import type {
  JsonValue,
  Model,
  ModelCallOptions,
  ModelMessage,
  ModelPrompt,
  ModelTextPart,
  ModelToolCallPart,
  ModelToolResultOutput,
  ModelToolResultPart,
} from '../model/contract.js';
import { normalizeStream } from '../model/normalize.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { Tool, ToolContext } from '../tools/index.js';
import { missingFinishError } from './stream.js';
import type { RequestContext } from './types.js';

/** How many model calls one run may make when the caller pins no `maxSteps` (`agent.md`「执行语义」). */
export const DEFAULT_MAX_STEPS = 5;

/** Everything the built-in loop needs for one run. */
export interface AgentLoopOptions {
  /** The model instance of this run (already asserted against the model contract). */
  readonly model: Model;
  /** The run's initial prompt (instructions + input); the loop extends it with each round trip. */
  readonly prompt: ModelPrompt;
  /** Model call options without `prompt` — the loop writes the prompt of every step. */
  readonly callOptions: Omit<ModelCallOptions, 'prompt'>;
  /** The agent's tool container: key = tool name. */
  readonly tools: Record<string, Tool>;
  /** The step cap (≥ 1). */
  readonly maxSteps: number;
  /** The run's request context — framework-written `signal` / `runId` plus the user's bag. */
  readonly requestContext: RequestContext;
}

/**
 * The built-in agent loop (`docs/architecture/agent.md`「Agent loop」), as a generator over the
 * core's chunk protocol.
 *
 * One step at a time: call the model, yield its chunks, then — if the step asked for client-side
 * tools — execute them in call order and yield one `tool-result` chunk per call. The step is then
 * appended to the prompt in the vendor's own shape (assistant message with the step's text, its
 * tool calls and any provider-executed results; tool message with the framework-executed results)
 * and the next step begins. The loop stops when a step requests no client-side tool call, or when
 * `maxSteps` is reached; if the cap ends a run whose last step still asked for tools, that step's
 * `finish` chunk is reported as `'tool-calls'` — the terminal reason for a cap-truncated run
 * (`chunks.ts`).
 *
 * Errors never abort a run (`docs/architecture/tools.md`「校验与错误语义」): input validation
 * failures, `execute` throws, output validation failures and calls to tools the container does not
 * hold all become an `isError` tool result fed back to the model, which decides whether to recover
 * or give up.
 *
 * Provider-executed tool calls are not executed again: a call whose `toolCallId` already has a
 * result in the step (the provider executed it) is skipped.
 */
export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<Chunk> {
  const { model, callOptions, tools, maxSteps, requestContext } = options;
  const prompt: ModelMessage[] = [...options.prompt];

  for (let step = 0; step < maxSteps; step += 1) {
    const { stream } = await model.doStream({ ...callOptions, prompt });
    const stepText: string[] = [];
    const toolCalls: ToolCallChunk[] = [];
    /** Tool call ids that already have a result in this step (provider-executed). */
    const answered = new Set<string>();
    /** Results the provider executed itself, in stream order — echoed in the step's prompt message. */
    const providerResults: ToolResultChunk[] = [];
    let finish: FinishChunk | undefined;

    for await (const chunk of normalizeStream(stream)) {
      switch (chunk.type) {
        case 'text-delta':
          stepText.push(chunk.textDelta);
          yield chunk;
          break;
        case 'tool-call':
          toolCalls.push(chunk);
          yield chunk;
          break;
        case 'tool-result':
          // A result already in the step's stream is provider-executed: it is echoed in the
          // assistant message and never executed by the framework.
          answered.add(chunk.toolCallId);
          providerResults.push(chunk);
          yield chunk;
          break;
        case 'finish':
          // The step ends here, but the decision needs the whole step: yield it below.
          finish = chunk;
          break;
      }
    }

    if (finish === undefined) {
      // A step's model stream without a finish part is a contract violation; failing here also
      // covers later steps, which must not settle the run on a previous step's finish chunk.
      throw missingFinishError();
    }

    const pending = toolCalls.filter((call) => !answered.has(call.toolCallId));
    const lastStep = step + 1 >= maxSteps;
    // The step boundary comes before the framework-executed results: consumers see the model's
    // finish, then the results that answer the step's calls (results belong to that step).
    yield pending.length > 0 && lastStep ? { ...finish, finishReason: 'tool-calls' } : finish;

    if (pending.length === 0) return;

    const results: ToolResultChunk[] = [];
    for (const call of pending) {
      const result = await executeToolCall(tools, call, requestContext);
      results.push(result);
      yield result;
    }

    if (lastStep) return;

    prompt.push(toAssistantMessage(stepText.join(''), toolCalls, providerResults));
    prompt.push({ role: 'tool', content: results.map(toModelToolResultPart) });
  }
}

/**
 * Runs one tool call under the normalized error semantics of `docs/architecture/tools.md`「校验与错误语义」:
 * never throws, always answers the call.
 *
 * Input validation runs before `execute` (the validated value is what the tool receives); output
 * validation runs after it (side effects already happened — repeat protection is the tool's
 * idempotency job, keyed by `toolCallId`). A tool without `inputSchema` is argument-less and gets
 * `undefined`; a tool without `outputSchema` returns whatever it returns.
 */
async function executeToolCall(
  tools: Record<string, Tool>,
  call: ToolCallChunk,
  requestContext: RequestContext,
): Promise<ToolResultChunk> {
  const tool = tools[call.toolName];
  if (tool === undefined) {
    return errorResult(call, `Unknown tool '${call.toolName}': it is not in the agent's tool container.`);
  }

  let input: unknown;
  if (tool.inputSchema !== undefined) {
    const validation = await validate(tool.inputSchema, call.input);
    if ('message' in validation) {
      return errorResult(call, `Invalid input for tool '${call.toolName}': ${validation.message}`);
    }
    input = validation.value;
  }

  let output: unknown;
  try {
    output = await tool.execute(input, toolContext(call, requestContext));
  } catch (error) {
    return errorResult(call, `Tool '${call.toolName}' failed: ${messageOf(error)}`);
  }

  if (tool.outputSchema !== undefined) {
    const validation = await validate(tool.outputSchema, output);
    if ('message' in validation) {
      return errorResult(
        call,
        `Tool '${call.toolName}' returned an invalid output: ${validation.message}`,
      );
    }
    output = validation.value;
  }

  return toolResult(call, output, false);
}

/**
 * The six-piece context of a tool call (`docs/architecture/tools.md`「执行上下文」). Trace ids are
 * empty strings until the observability auto-instrumentation lands (M1-09); `toolCallId` is the
 * provider's real id.
 */
function toolContext(call: ToolCallChunk, requestContext: RequestContext): ToolContext {
  return {
    signal: requestContext.signal,
    runId: requestContext.runId,
    toolCallId: call.toolCallId,
    requestContext,
    traceId: '',
    spanId: '',
  };
}

function errorResult(call: ToolCallChunk, message: string): ToolResultChunk {
  return toolResult(call, message, true);
}

function toolResult(call: ToolCallChunk, output: unknown, isError: boolean): ToolResultChunk {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output,
    isError,
  };
}

/** Runs a Standard Schema validation, turning a throwing vendor into an issue message. */
async function validate(
  schema: StandardSchema,
  value: unknown,
): Promise<{ readonly value: unknown } | { readonly message: string }> {
  try {
    const result = await schema['~standard'].validate(value);
    if (result.issues === undefined) return { value: result.value };
    return { message: formatIssues(result.issues) };
  } catch (error) {
    return { message: messageOf(error) };
  }
}

/** One readable line per issue, path first: `city: expected string, received number`. */
function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues.map(formatIssue).join('; ');
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = issue.path?.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
  return path === undefined || path === '' ? issue.message : `${path}: ${issue.message}`;
}

/**
 * The assistant message of a finished step, appended to the prompt before the next model call: the
 * step's text (when it produced any), its tool calls, and the results the provider executed itself.
 * Framework-executed results are not here — they follow in the `tool` message. Echoing
 * provider-executed results inside the assistant message keeps every tool call paired with a
 * result in the vendor prompt shape (the AI SDK builds its response messages the same way).
 */
function toAssistantMessage(
  text: string,
  toolCalls: readonly ToolCallChunk[],
  providerResults: readonly ToolResultChunk[],
): ModelMessage {
  const content: Array<ModelTextPart | ModelToolCallPart | ModelToolResultPart> = [];
  if (text !== '') content.push({ type: 'text', text });
  for (const call of toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  for (const result of providerResults) content.push(toModelToolResultPart(result));
  return { role: 'assistant', content };
}

function toModelToolResultPart(result: ToolResultChunk): ModelToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    output: toModelToolResultOutput(result),
  };
}

/**
 * Maps a `tool-result` chunk onto the vendor prompt's result output (the same shape the AI SDK
 * produces): errors are `error-text`, string outputs are `text`, everything else is `json`.
 *
 * `json` values are run through a JSON round trip so the prompt only ever carries real JSON values
 * (`undefined` and non-serializable values become `null`) — providers stringify this shape.
 */
function toModelToolResultOutput(result: ToolResultChunk): ModelToolResultOutput {
  if (result.isError) return { type: 'error-text', value: messageOf(result.output) };
  if (typeof result.output === 'string') return { type: 'text', value: result.output };
  return { type: 'json', value: toJsonValue(result.output) };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : (JSON.parse(serialized) as JsonValue);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
