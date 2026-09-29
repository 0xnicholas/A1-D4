import type { Chunk, FinishReason, ToolCallChunk, ToolResultChunk, Usage } from '../model/chunks.js';
import { ModelContractError } from '../model/resolve.js';
import type { AgentGenerateResult, AgentStep, AgentStreamResult } from './types.js';

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
 * - **Terminal values come from the run itself**: the generator's return value is the run's
 *   authoritative result (`AgentGenerateResult`), which the loop builds from its post-processor step
 *   records. The chunk stream is never re-accumulated here — a processor's `processOutputStep`
 *   rewrite is what `steps` / `text` / `usage` report, while the live chunks stay the model's own
 *   output.
 * - **Lazy terminal promises**: a promise is created when it is read, so a run whose terminal
 *   values nobody awaits cannot produce unhandled rejections.
 * - **A failed run** rejects the iterator where the failure surfaced and rejects every terminal
 *   promise with the same error — the error `processError` settled on, when processors replaced it.
 */
export function createAgentStream(
  run: () => AsyncGenerator<Chunk, AgentGenerateResult, void>,
): AgentStreamResult {
  let started = false;
  let settled = false;
  let failure: { readonly error: unknown } | undefined;
  /** Set when the consumer leaves the loop early; it ends that traversal, not the run. */
  let abandoned = false;
  const buffered: Chunk[] = [];
  const waiting: WaitForNext[] = [];

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
      const iterator = run()[Symbol.asyncIterator]();
      // Manual iteration rather than `for await`: the run's terminal result is the generator's
      // *return value*, which a `for await` loop discards.
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          settle(next.value);
          return;
        }
        deliver(next.value);
      }
    } catch (error) {
      fail(error);
    }
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

  /** The run completed: its terminal result settles every terminal value. */
  function settle(outcome: AgentGenerateResult): void {
    settled = true;
    for (const waiter of waiting.splice(0)) waiter.resolve(DONE);
    text.settle(outcome.text);
    usageTerminal.settle(outcome.usage);
    stepsTerminal.settle(outcome.steps);
    toolCallsTerminal.settle(outcome.toolCalls);
    toolResultsTerminal.settle(outcome.toolResults);
    finishReason.settle(outcome.finishReason);
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

interface WaitForNext {
  resolve(result: IteratorResult<Chunk>): void;
  reject(error: unknown): void;
}

const DONE: IteratorResult<Chunk> = { value: undefined, done: true };

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
