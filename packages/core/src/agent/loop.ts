import type { Chunk, FinishChunk, FinishReason, ToolCallChunk, ToolResultChunk, Usage } from '../model/chunks.js';
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
import { modelChainExhausted } from '../model/fallback.js';
import type { ModelFallbackFailure } from '../model/fallback.js';
import { normalizeStream } from '../model/normalize.js';
import { AGENT_RUN_SPAN, AGENT_STEP_SPAN, TOOL_CALL_SPAN } from '../observability/index.js';
import type { Span, Tracer } from '../observability/index.js';
import { formatIssues, messageOf, validateSchema } from '../standard-schema-runtime.js';
import type { Tool, ToolContext } from '../tools/index.js';
import { missingFinishError } from './stream.js';
import { runProcessError, runProcessOutputStep } from './processors.js';
import type { Processor } from './processors.js';
import { toStructuredObject } from './structured-output.js';
import type { AgentGenerateResult, AgentStep, RequestContext, StructuredOutputConfig } from './types.js';

/** How many model calls one run may make when the caller pins no `maxSteps` (`agent.md`「执行语义」). */
export const DEFAULT_MAX_STEPS = 5;

/** Everything the built-in loop needs for one run. */
export interface AgentLoopOptions {
  /**
   * The run's fallback chain, in array order — at least one candidate (a run with a single model is
   * a one-element chain). Every model call walks it: a candidate is abandoned for the next one only
   * when it fails before producing a chunk (`docs/architecture/model.md`「model 字段形状」).
   */
  readonly models: readonly Model[];
  /** The run's initial prompt (instructions + input); the loop extends it with each round trip. */
  readonly prompt: ModelPrompt;
  /** Model call options without `prompt` — the loop writes the prompt of every step. */
  readonly callOptions: Omit<ModelCallOptions, 'prompt'>;
  /** The agent's tool container: key = tool name. */
  readonly tools: Record<string, Tool>;
  /** The step cap (≥ 1). */
  readonly maxSteps: number;
  /** The run's processors, in declaration order (`AgentConfig.processors`); empty = none. */
  readonly processors: readonly Processor[];
  /** The agent's name — the name of the run's span and its `agentName` attribute. */
  readonly agentName: string;
  /** The run's request context — framework-written `signal` / `runId` plus the user's bag. */
  readonly requestContext: RequestContext;
  /**
   * The run's structured-output option (`AgentRunOptions.structuredOutput`), present only when the
   * run asked for one: the run's terminal text is parsed as JSON and validated against the schema,
   * strictly, and the validated value settles the run's `object` (`docs/architecture/agent.md`
   *「执行语义」). The schema is also what the run's model calls carry as `responseFormat` — built by
   * the agent before the loop starts.
   */
  readonly structuredOutput?: StructuredOutputConfig | undefined;
  /**
   * The run's observability wiring, present only when a tracer is attached (`AgentConfig.tracer`).
   * Absent = the whole observability subsystem stays out of the loop: no span object is created
   * anywhere in it.
   */
  readonly tracing?: AgentTracing | undefined;
  /** The user's `modelSettings` passthrough, recorded on the step span as `parameters`. */
  readonly parameters?: Record<string, unknown> | undefined;
}

/**
 * The observability wiring of one run: the tracer plus the per-run options that only mean
 * something with one. Grouped rather than flat so the loop's zero-overhead branch is a single
 * presence check, and the trace/hiding options cannot travel without their tracer.
 */
export interface AgentTracing {
  /** The tracer injected into the agent; span creation is the loop's only observability work. */
  readonly tracer: Tracer;
  /** The trace to continue (`AgentRunOptions.traceId`), when the run attaches to one. */
  readonly traceId?: string | undefined;
  /** The parent span inside the continued trace (requires `traceId`). */
  readonly parentSpanId?: string | undefined;
  /** Per-run `hideInput` override, decided on the run's root span and inherited by its children. */
  readonly hideInput?: boolean | undefined;
  /** Per-run `hideOutput` override (see `hideInput`). */
  readonly hideOutput?: boolean | undefined;
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
 * **Fallback chain** (`docs/architecture/model.md`「model 字段形状」): a step's model call walks
 * `models` in array order, and abandons a candidate for the next one only while it has produced no
 * chunk yet. A mid-stream failure propagates instead — partial output has already reached the
 * caller, and switching would splice two models' answers together — and so does the failure of a
 * run whose signal is already aborted: cancellation is the run's outcome, not a chain failure. A
 * step whose whole chain failed ends with the last attempt's error when there was only one, or with
 * a `ModelFallbackError` carrying every candidate's own error otherwise.
 *
 * Errors never abort a run (`docs/architecture/tools.md`「校验与错误语义」): input validation
 * failures, `execute` throws, output validation failures and calls to tools the container does not
 * hold all become an `isError` tool result fed back to the model, which decides whether to recover
 * or give up.
 *
 * Provider-executed tool calls are not executed again: a call whose `toolCallId` already has a
 * result in the step (the provider executed it) is skipped.
 *
 * **Processors** (`docs/architecture/agent.md`「扩展点:Processor」): `processOutputStep` runs once per
 * completed step, after its tools, and the record it returns is the run's authoritative one — it is
 * what the next prompt is built from and what the generator's return value reports. `processError`
 * runs where an error would surface: a model-call failure that ends the step (never a cancelled run)
 * and every tool-line failure. Both chains run in declaration order; a replacement is threaded on.
 */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<Chunk, AgentGenerateResult, void> {
  const { models, callOptions, tools, maxSteps, requestContext, processors, structuredOutput } =
    options;
  const prompt: ModelMessage[] = [...options.prompt];
  /** The run's authoritative step records — the processors' rewrites included. */
  const steps: AgentStep[] = [];
  // The run boundary: one root span per run, the parent every step span hangs under. Absent tracer
  // ⇒ `undefined`, and no span is ever created — the loop's only zero-overhead branch.
  const runSpan = startRunSpan(options);
  /**
   * The terminal reason of the step that ended the run — set by the step whose tools left nothing
   * pending, or by the cap's last step. The run's terminal values are built after the loop, outside
   * the step boundary: a structured run validates its terminal text there, so a text that does not
   * become the schema's value fails the run without marking the model call that produced it (the
   * call succeeded; the run's output contract did not — `docs/architecture/agent.md`「执行语义」).
   */
  let settled: FinishReason | undefined;

  try {
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const stepStartedAt = Date.now();
      let timeToFirstChunk: number | undefined;
      let finish: FinishChunk | undefined;
      const stepText: string[] = [];
      const toolCalls: ToolCallChunk[] = [];
      /** Tool call ids that already have a result in this step (provider-executed). */
      const answered = new Set<string>();
      /** Results the provider executed itself, in stream order — echoed in the step's prompt message. */
      const providerResults: ToolResultChunk[] = [];
      /** The candidates that failed before producing a chunk, in chain order. */
      const failures: ModelFallbackFailure[] = [];
      /**
       * The candidate that served this step, with its finish chunk. Set when a candidate completes
       * (its stream ended with a finish part); its span stays open until the step's tools have run.
       */
      let served: { readonly span: Span | undefined; readonly finish: FinishChunk } | undefined;

      // The step boundary: one span per model call, hanging under the run's root span — a fallback
      // chain's failed attempts get their own spans, so a switch is visible in the trace, and the
      // attempt that serves the step carries its usage / finishReason. Every attempt walks the
      // chain in array order. Tool calls of the step hang under the serving attempt's span, so that
      // span stays open until they are done too.
      for (const candidate of models) {
        const candidateSpan = startStepSpan(options, runSpan, prompt, candidate);
        let producedChunk = false;

        try {
          const { stream } = await candidate.doStream({ ...callOptions, prompt });

          for await (const chunk of normalizeStream(stream)) {
            // Point of no return for this step: a chunk is on its way to the caller, so a later
            // failure must propagate — the next candidate would continue someone else's answer.
            producedChunk = true;
            if (timeToFirstChunk === undefined) timeToFirstChunk = Date.now() - stepStartedAt;
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

          served = { span: candidateSpan, finish };
          break;
        } catch (error) {
          // Cancellation is the run's outcome, not a chain failure and not a processor's business:
          // an aborted run surfaces its own reason untouched (`processError` is for provider errors).
          if (requestContext.signal.aborted) {
            candidateSpan?.error(error);
            throw error;
          }
          // A mid-stream failure cannot fall back — partial output has already reached the caller:
          // it surfaces through `processError`, which may replace the error the run ends with.
          if (producedChunk) {
            const surfaced = await runProcessError(
              processors,
              error,
              { source: 'model', stepIndex },
              requestContext,
            );
            candidateSpan?.error(surfaced);
            throw surfaced;
          }
          candidateSpan?.error(error);
          failures.push({ model: candidate, error });
        } finally {
          // A candidate that did not serve the step is over here: its span carries the failure (or
          // the abandoned attempt) and closes. The serving candidate's span stays open for its
          // tools, which hang under it.
          if (served === undefined) candidateSpan?.end();
        }
      }

      if (served === undefined) {
        // Every candidate failed before producing a chunk: the run ends here — with the original
        // error when there was nothing to fall back to, with the chain's context when there was.
        // The surfaced error walks the processors' error chain before it becomes the run's error.
        throw await runProcessError(
          processors,
          modelChainExhausted(failures),
          { source: 'model', stepIndex },
          requestContext,
        );
      }

      const { span: stepSpan, finish: stepFinish } = served;

      try {
        // The step is complete: its text is the run's output so far (the last step's text settles
        // the run's output — `stream()`'s `text` reads the same rule).
        stepSpan?.update({
          output: stepText.join(''),
          attributes: {
            usage: stepFinish.usage,
            finishReason: stepFinish.finishReason,
            ...(timeToFirstChunk === undefined ? {} : { timeToFirstChunk }),
          },
        });

        const pending = toolCalls.filter((call) => !answered.has(call.toolCallId));
        const lastStep = stepIndex + 1 >= maxSteps;
        // The step boundary comes before the framework-executed results: consumers see the model's
        // finish, then the results that answer the step's calls (results belong to that step).
        const terminalFinish: FinishChunk =
          pending.length > 0 && lastStep ? { ...stepFinish, finishReason: 'tool-calls' } : stepFinish;
        yield terminalFinish;

        const results: ToolResultChunk[] = [];
        for (const call of pending) {
          const toolSpan = startToolCallSpan(options, stepSpan, call);
          const outcome = await executeToolCall(tools, call, requestContext, toolSpan);
          let result: ToolResultChunk;
          if ('result' in outcome) {
            result = outcome.result;
          } else {
            // The failure walks the processors' error chain before the error tool result is built;
            // the replacement is the error the model sees (and the span records).
            const failure = await runProcessError(
              processors,
              outcome.failure.error,
              { source: 'tool', stepIndex, toolCall: call },
              requestContext,
            );
            result = toolResult(call, outcome.failure.toMessage(failure), true);
            toolSpan?.error(failure);
          }
          toolSpan?.update({ output: result.output });
          toolSpan?.end();
          results.push(result);
          yield result;
        }

        // The step is over: its full record (text / tool calls / tool results / usage) goes through
        // the processors, and the record they return is the run's authoritative one — it settles
        // the run's terminal values and is what the next prompt (and, from M2, memory) is built from.
        const record = await runProcessOutputStep(
          processors,
          {
            text: stepText.join(''),
            toolCalls,
            toolResults: [...providerResults, ...results],
            usage: stepFinish.usage,
          },
          stepIndex,
          requestContext,
        );
        steps.push(record);
        // The run span carries the run's terminal text — the processed record, same as the output
        // object's `text` (`observability.md`「自动埋点」; the step span keeps the model's response).
        runSpan?.update({ output: record.text });

        if (pending.length === 0 || lastStep) {
          settled = terminalFinish.finishReason;
          break;
        }

        // Provider-executed results stay paired with their calls inside the assistant message;
        // framework-executed ones follow in the `tool` message (the vendor-shaped split, from the
        // processed record — a processor's rewrite is what the next model call sees).
        const echoes = record.toolResults.filter((entry) => answered.has(entry.toolCallId));
        const feedback = record.toolResults.filter((entry) => !answered.has(entry.toolCallId));
        prompt.push(toAssistantMessage(record.text, record.toolCalls, echoes));
        prompt.push({ role: 'tool', content: feedback.map(toModelToolResultPart) });
      } catch (error) {
        stepSpan?.error(error);
        throw error;
      } finally {
        stepSpan?.end();
      }
    }

    if (settled === undefined) {
      // Unreachable: `maxSteps` is at least 1, so the last iteration always takes the terminal
      // branch — its step set `settled`, or it ran that step's tools first and then did.
      throw new Error('The agent loop ended without settling its run.');
    }

    const outcome = await runOutcome(steps, settled, structuredOutput);
    // A structured run's span reports the structured result — it is what the caller consumes
    // (`observability.md`「自动埋点」: agent-run output is the terminal text or the structured result).
    if (structuredOutput !== undefined) runSpan?.update({ output: outcome.object });
    return outcome;
  } catch (error) {
    // A failed run leaves its root span carrying the error (a failed step also carries it on its
    // own step span; a structured-output failure has no failing step — the run did not meet its
    // output contract).
    runSpan?.error(error);
    throw error;
  } finally {
    // Ends the run span on every exit path — normal completion, a model error, or the consumer
    // abandoning the generator.
    runSpan?.end();
  }
}

/**
 * Starts the run's root span (`docs/architecture/observability.md`「自动埋点」): the run boundary.
 * `runId` rides on the root span's attributes, so execution identity and trace identity can look
 * each other up; `traceId` / `parentSpanId` continue a trace started elsewhere.
 */
function startRunSpan(options: AgentLoopOptions): Span | undefined {
  const tracing = options.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: options.agentName,
    type: AGENT_RUN_SPAN,
    input: options.prompt,
    attributes: { agentName: options.agentName, runId: options.requestContext.runId },
    ...(tracing.traceId === undefined ? {} : { traceId: tracing.traceId }),
    ...(tracing.parentSpanId === undefined ? {} : { parentSpanId: tracing.parentSpanId }),
    ...(tracing.hideInput === undefined ? {} : { hideInput: tracing.hideInput }),
    ...(tracing.hideOutput === undefined ? {} : { hideOutput: tracing.hideOutput }),
  });
}

/**
 * Starts one step span (`docs/architecture/observability.md`「自动埋点」): one model call of the
 * run, hanging under the run's root span. Every attempt of a fallback chain gets its own span — a
 * failed attempt carries the failure, the attempt that serves the step carries its usage /
 * finishReason. The step's tool calls hang under the serving attempt's span, so that span stays
 * open until they have run too. Its prompt is copied — the loop appends to its own array, and a
 * recorded span must not mutate after the fact.
 */
function startStepSpan(
  options: AgentLoopOptions,
  runSpan: Span | undefined,
  prompt: readonly ModelMessage[],
  model: Model,
): Span | undefined {
  const tracing = options.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: model.modelId,
    type: AGENT_STEP_SPAN,
    ...(runSpan === undefined ? {} : { parent: runSpan }),
    input: [...prompt],
    attributes: {
      model: model.modelId,
      provider: model.provider,
      ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
    },
  });
}

/**
 * Starts one tool call's span (`docs/architecture/observability.md`「自动埋点」): a single tool
 * execution inside the step that requested it. The span is the source of the tool context's
 * `traceId` / `spanId`, so an as-tool delegation can hang its run under it (ADR-0012).
 */
function startToolCallSpan(
  options: AgentLoopOptions,
  stepSpan: Span | undefined,
  call: ToolCallChunk,
): Span | undefined {
  const tracing = options.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: call.toolName,
    type: TOOL_CALL_SPAN,
    ...(stepSpan === undefined ? {} : { parent: stepSpan }),
    input: call.input,
    attributes: { toolCallId: call.toolCallId },
  });
}

/**
 * Runs one tool call under the normalized error semantics of `docs/architecture/tools.md`「校验与错误语义」:
 * never throws, always answers the call — with the tool's result, or with the failure an error tool
 * result will answer. The failure is not formatted here: the loop hands its error through
 * `processError` first, then builds the model-facing message with the failure's own recipe.
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
  toolSpan: Span | undefined,
): Promise<ToolCallOutcome> {
  const tool = tools[call.toolName];
  if (tool === undefined) {
    const message = `Unknown tool '${call.toolName}': it is not in the agent's tool container.`;
    return { failure: { error: new Error(message), toMessage: messageOf } };
  }

  let input: unknown;
  if (tool.inputSchema !== undefined) {
    const validation = await validateSchema(tool.inputSchema, call.input);
    if ('issues' in validation) {
      const message = `Invalid input for tool '${call.toolName}': ${formatIssues(validation.issues)}`;
      return { failure: { error: new Error(message), toMessage: messageOf } };
    }
    input = validation.value;
  }

  let output: unknown;
  try {
    output = await tool.execute(input, toolContext(call, requestContext, toolSpan));
  } catch (error) {
    // The thrown error keeps its identity for `processError` / the span; the framework framing is
    // what turns it into the model-facing message (`Tool 'x' failed: <detail>`).
    return {
      failure: {
        error,
        toMessage: (replacement) => `Tool '${call.toolName}' failed: ${messageOf(replacement)}`,
      },
    };
  }

  if (tool.outputSchema !== undefined) {
    const validation = await validateSchema(tool.outputSchema, output);
    if ('issues' in validation) {
      const message = `Tool '${call.toolName}' returned an invalid output: ${formatIssues(validation.issues)}`;
      return { failure: { error: new Error(message), toMessage: messageOf } };
    }
    output = validation.value;
  }

  return { result: toolResult(call, output, false) };
}

/** What one tool call produced: its result, or the failure an `isError` result will answer. */
type ToolCallOutcome =
  | { readonly result: ToolResultChunk }
  | { readonly failure: ToolFailure };

/**
 * A tool-line failure: the error handed to `processError`, plus the recipe for the model-facing
 * message of a (possibly replaced) error.
 *
 * Framework-generated lines (unknown tool, failed validation) carry their full message as the
 * error's message: the model sees that message whether or not a processor replaced the error. An
 * `execute` throw keeps the framework's `Tool 'x' failed:` framing, with the replacement supplying
 * the detail after it.
 */
interface ToolFailure {
  /** The error `processError` observes — the original object, untouched. */
  readonly error: unknown;
  /** Builds the model-facing message of the (possibly replaced) error. */
  readonly toMessage: (error: unknown) => string;
}

/**
 * The six-piece context of a tool call (`docs/architecture/tools.md`「执行上下文」). Trace ids come
 * from the call's span — real ids when a tracer is attached and the trace is sampled, empty strings
 * when there is no tracer or the sampler rejected the trace (`NoOpSpan` semantics); `toolCallId` is
 * the provider's real id.
 */
function toolContext(
  call: ToolCallChunk,
  requestContext: RequestContext,
  toolSpan: Span | undefined,
): ToolContext {
  return {
    signal: requestContext.signal,
    runId: requestContext.runId,
    toolCallId: call.toolCallId,
    requestContext,
    traceId: toolSpan?.traceId ?? '',
    spanId: toolSpan?.id ?? '',
  };
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

/**
 * The run's terminal values, built from its authoritative step records (processors' rewrites
 * included): the last step's text settles `text`, the records flatten into run-wide tool calls /
 * results, and usage accumulates across steps.
 *
 * A structured run (`structuredOutput`) also settles `object` here: the very text `text` reports is
 * parsed as JSON and validated against the schema — strictly, so a terminal text that does not
 * become the schema's value fails the run with `StructuredOutputError`
 * (`docs/architecture/agent.md`「执行语义」). Validating the processed record keeps one truth: what a
 * `processOutputStep` rewrote is both the run's text and the text the structured output is read from.
 */
async function runOutcome(
  steps: readonly AgentStep[],
  finishReason: FinishReason,
  structuredOutput: StructuredOutputConfig | undefined,
): Promise<AgentGenerateResult> {
  const text = steps.at(-1)?.text ?? '';
  return {
    text,
    object:
      structuredOutput === undefined
        ? undefined
        : await toStructuredObject(structuredOutput, text),
    toolCalls: steps.flatMap((step) => step.toolCalls),
    toolResults: steps.flatMap((step) => step.toolResults),
    usage: steps.reduce<Usage>((total, step) => addUsage(total, step.usage), UNKNOWN_USAGE),
    finishReason,
    steps,
  };
}

/** Usage before any step reported one: every field unknown. */
const UNKNOWN_USAGE: Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

/**
 * Adds one step's usage onto the run total.
 *
 * Unknown stays unknown: a field no step reported stays `undefined` rather than collapsing to 0.
 * `totalTokens` is derived exactly like the normalization layer derives it per model part
 * (`normalize.ts` `toUsage`): input + output when both are known, unknown otherwise.
 */
function addUsage(total: Usage, stepUsage: Usage): Usage {
  const inputTokens = addTokens(total.inputTokens, stepUsage.inputTokens);
  const outputTokens = addTokens(total.outputTokens, stepUsage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : inputTokens + outputTokens,
  };
}

function addTokens(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}
