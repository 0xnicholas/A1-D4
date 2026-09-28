import type {
  Chunk,
  FinishChunk,
  FinishReason,
  ToolCallChunk,
  ToolResultChunk,
  Usage,
} from '../model/chunks.js';
import { ModelContractError } from '../model/resolve.js';
import type { AgentStep, AgentStreamResult } from './types.js';

/**
 * The contract violation of a model stream that ends without a `finish` part — `finishReason` and
 * usage are unknown. The run engine raises it when the whole chunk stream ends without one; the
 * loop raises it when a single step's model stream does, so a later step cannot settle the run on
 * a previous step's finish chunk. Internal seam, not part of the entry's public surface.
 */
export function missingFinishError(): ModelContractError {
  return new ModelContractError(
    'The model stream ended without a finish part, so finishReason and usage are unknown. ' +
      'The model does not implement the streaming contract of the AI SDK provider specification.',
  );
}

/**
 * The run behind an output object (`docs/architecture/agent.md`「执行语义」「输出对象」).
 *
 * One pass over the core chunk protocol serves both consumption styles: the `for await` iterator
 * and the terminal promises, so the two can be mixed freely and always describe the same run.
 *
 * - **Lazy start**: the model call happens on first consumption — the first `next()` of the chunk
 *   stream or the first terminal promise read. A result nobody consumes makes no model call.
 * - **Single-consumption chunks**: chunks are handed to the waiting iterator, or buffered when the
 *   iterator is slower than the model, and always delivered in stream order. Once the consumer
 *   leaves the loop early, buffering stops — nobody can read that buffer again.
 * - **Lazy terminal promises**: a promise is created when it is read, so a run whose terminal
 *   values nobody awaits cannot produce unhandled rejections.
 * - **Stream end without a `finish` chunk** is a contract violation: the iterator throws it where
 *   the stream ended, and the terminal promises reject with it.
 */
export function createAgentStream(chunks: () => AsyncIterable<Chunk>): AgentStreamResult {
  let started = false;
  let settled = false;
  let failure: { readonly error: unknown } | undefined;
  /** Set when the consumer leaves the loop early; it ends that traversal, not the run. */
  let abandoned = false;
  const buffered: Chunk[] = [];
  const waiting: WaitForNext[] = [];

  let finish: FinishChunk | undefined;
  let usage: Usage = UNKNOWN_USAGE;
  const steps: StepAccumulator[] = [];
  /** The current step: open while its model call streams, finished-but-current for late results. */
  let step: StepAccumulator = newStep();
  let stepFinished = false;

  const text = createTerminal<string>();
  const usageTerminal = createTerminal<Usage>();
  const stepsTerminal = createTerminal<readonly AgentStep[]>();
  const toolCallsTerminal = createTerminal<readonly ToolCallChunk[]>();
  const toolResultsTerminal = createTerminal<readonly ToolResultChunk[]>();
  const finishReason = createTerminal<FinishReason>();

  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    try {
      for await (const chunk of chunks()) {
        record(chunk);
        deliver(chunk);
      }
      if (finish === undefined) {
        throw missingFinishError();
      }
      settle(finish);
    } catch (error) {
      fail(error);
    }
  }

  /** Folds one chunk into the run's terminal accumulators. */
  function record(chunk: Chunk): void {
    switch (chunk.type) {
      case 'text-delta':
        openStepForContent();
        step.text += chunk.textDelta;
        break;
      case 'tool-call':
        openStepForContent();
        step.toolCalls.push(chunk);
        break;
      case 'tool-result':
        // Results belong to the step whose call they answer: provider-executed results arrive
        // inside the step, framework-executed ones (the loop's job) right after its finish
        // chunk — both land on the step that is current here.
        step.toolResults.push(chunk);
        break;
      case 'finish':
        // A finish chunk closes the step, keeping it current until the next model call's first
        // content chunk (or its own finish) opens the next one.
        if (stepFinished) step = newStep();
        step.usage = chunk.usage;
        steps.push(step);
        stepFinished = true;
        usage = addUsage(usage, chunk.usage);
        finish = chunk;
        break;
      default:
        chunk satisfies never;
    }
  }

  /** Content of a new model call arrived: the previous step is over, the next one begins. */
  function openStepForContent(): void {
    if (!stepFinished) return;
    step = newStep();
    stepFinished = false;
  }

  /** Hands a chunk to the waiting iterator, or buffers it until one asks. */
  function deliver(chunk: Chunk): void {
    if (abandoned) return; // The consumer left; nothing will ever read this buffer again.
    const waiter = waiting.shift();
    if (waiter === undefined) {
      buffered.push(chunk);
      return;
    }
    waiter.resolve({ value: chunk, done: false });
  }

  function settle(final: FinishChunk): void {
    settled = true;
    for (const waiter of waiting.splice(0)) waiter.resolve(DONE);
    text.settle(steps.at(-1)?.text ?? '');
    usageTerminal.settle(usage);
    stepsTerminal.settle(steps);
    toolCallsTerminal.settle(steps.flatMap((record) => record.toolCalls));
    toolResultsTerminal.settle(steps.flatMap((record) => record.toolResults));
    finishReason.settle(final.finishReason);
  }

  function fail(error: unknown): void {
    settled = true;
    failure = { error };
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    text.fail(error);
    usageTerminal.fail(error);
    stepsTerminal.fail(error);
    toolCallsTerminal.fail(error);
    toolResultsTerminal.fail(error);
    finishReason.fail(error);
  }

  const iterator: AsyncIterator<Chunk> = {
    next(): Promise<IteratorResult<Chunk>> {
      start();
      if (abandoned) return Promise.resolve(DONE);
      // Buffered chunks first: a failed run still delivers everything it produced before failing.
      const chunk = buffered.shift();
      if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
      if (failure !== undefined) return Promise.reject(failure.error);
      if (settled) return Promise.resolve(DONE);
      return new Promise<IteratorResult<Chunk>>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    return(): Promise<IteratorResult<Chunk>> {
      abandoned = true;
      buffered.length = 0;
      return Promise.resolve(DONE);
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    get text() {
      start();
      return text.promise();
    },
    get toolCalls() {
      start();
      return toolCallsTerminal.promise();
    },
    get toolResults() {
      start();
      return toolResultsTerminal.promise();
    },
    get usage() {
      start();
      return usageTerminal.promise();
    },
    get steps() {
      start();
      return stepsTerminal.promise();
    },
    get finishReason() {
      start();
      return finishReason.promise();
    },
  };
}

/** A step while it is still being accumulated; the finished records live on as `AgentStep`. */
interface StepAccumulator {
  text: string;
  toolCalls: ToolCallChunk[];
  toolResults: ToolResultChunk[];
  usage: Usage;
}

interface WaitForNext {
  resolve(result: IteratorResult<Chunk>): void;
  reject(error: unknown): void;
}

const DONE: IteratorResult<Chunk> = { value: undefined, done: true };

const UNKNOWN_USAGE: Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

function newStep(): StepAccumulator {
  return { text: '', toolCalls: [], toolResults: [], usage: UNKNOWN_USAGE };
}

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

/**
 * A terminal value that only becomes a promise when it is read.
 *
 * Settling before the first read stores the outcome instead of creating a promise, so a result
 * whose terminal values are never awaited cannot reject unhandled. Reading twice returns the same
 * promise: one run, one terminal value.
 */
interface Terminal<T> {
  promise(): Promise<T>;
  settle(value: T): void;
  fail(error: unknown): void;
}

type TerminalState<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

function createTerminal<T>(): Terminal<T> {
  let promise: Promise<T> | undefined;
  let state: TerminalState<T> = { kind: 'pending' };
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;

  return {
    promise() {
      if (promise !== undefined) return promise;
      switch (state.kind) {
        case 'value':
          promise = Promise.resolve(state.value);
          break;
        case 'error':
          promise = Promise.reject(state.error);
          break;
        case 'pending':
          promise = new Promise<T>((onValue, onError) => {
            resolve = onValue;
            reject = onError;
          });
          break;
      }
      return promise;
    },
    settle(value) {
      if (resolve !== undefined) resolve(value);
      else state = { kind: 'value', value };
    },
    fail(error) {
      if (reject !== undefined) reject(error);
      else state = { kind: 'error', error };
    },
  };
}
