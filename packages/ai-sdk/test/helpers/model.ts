/**
 * A scripted fake model for the route tests — the same seam the core's own tests use
 * (`packages/core/test/helpers/fake-model.ts`, issue #21's testing decision), in a lean form:
 * it implements the vendored `Model` contract by replaying a script of steps through `doStream`
 * and records every call's options so tests can assert the prompt the model actually saw.
 * No network, no external service.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { Model, ModelCallOptions } from '@balsats/core/model';

/** One scripted model step: what one `doStream` call emits. */
export interface ScriptedStep {
  /** Text output; a string is one delta, an array is several. */
  readonly text?: string | readonly string[];
  /** Tool calls the step requests (framework-executed; ids default `call-1`, `call-2`, …). */
  readonly toolCalls?: readonly { toolCallId?: string; toolName: string; input: unknown }[];
  /** Unified finish reason; defaults to `'tool-calls'` when calls are requested, else `'stop'`. */
  readonly finishReason?: 'stop' | 'tool-calls' | 'length' | 'error' | 'content-filter' | 'other';
  /** Token usage reported on the finish part. */
  readonly usage?: { inputTokens?: number; outputTokens?: number };
  /** Rejects the call outright (before any output). */
  readonly fail?: unknown;
  /** Emits an `error` part after the scripted output (mid-stream failure). */
  readonly errorAfter?: unknown;
  /** Waits this long before the step's parts start flowing (keep-alive tests). */
  readonly delayMs?: number;
}

/** A scripted model that also exposes its recorded calls. */
export interface ScriptedModel extends Model {
  /** Every `doStream` call's options, in order. */
  readonly calls: readonly ModelCallOptions[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function scriptedModel(script: readonly ScriptedStep[]): ScriptedModel {
  const calls: ModelCallOptions[] = [];
  let answered = 0;
  let callCount = 0;

  const doStream = async (
    call: LanguageModelV4CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> => {
    call.abortSignal?.throwIfAborted();
    calls.push(call as unknown as ModelCallOptions);
    const step = script[answered];
    if (step === undefined) {
      throw new Error(`scripted model exhausted: ${script.length} step(s), call ${answered + 1}`);
    }
    answered += 1;
    if (step.fail !== undefined) throw step.fail;

    const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    const deltas = typeof step.text === 'string' ? [step.text] : (step.text ?? []);
    if (deltas.length > 0) {
      parts.push({ type: 'text-start', id: 'text-0' });
      for (const delta of deltas) parts.push({ type: 'text-delta', id: 'text-0', delta });
      parts.push({ type: 'text-end', id: 'text-0' });
    }
    for (const request of step.toolCalls ?? []) {
      callCount += 1;
      parts.push({ type: 'tool-call', toolCallId: request.toolCallId ?? `call-${callCount}`, toolName: request.toolName, input: JSON.stringify(request.input) });
    }
    if (step.errorAfter !== undefined) {
      parts.push({ type: 'error', error: step.errorAfter });
    } else {
      const unified = step.finishReason ?? (step.toolCalls?.length ? 'tool-calls' : 'stop');
      parts.push({
        type: 'finish',
        finishReason: { unified, raw: unified },
        usage: {
          inputTokens: { total: step.usage?.inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: step.usage?.outputTokens, text: undefined, reasoning: undefined },
        },
      });
    }

    const delayMs = step.delayMs ?? 0;
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          if (delayMs > 0) await sleep(delayMs);
          for (const part of parts) {
            controller.enqueue(part);
            if (delayMs > 0) await sleep(delayMs);
          }
          controller.close();
        },
      }),
    };
  };

  const contract: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('the route only streams; doGenerate is never exercised');
    },
    doStream,
  };
  return { ...contract, calls };
}
