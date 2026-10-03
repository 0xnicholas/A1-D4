/**
 * The output object (CONTEXT.md 「输出对象」): the dual-consumable return of one execution —
 * `for await` walks its chunk stream, `await` reads its terminal values, both backed by a single
 * lazy pass over the run. The agent stream (`agent/stream.ts`) and the workflow run output
 * (`workflows/run.ts`) build theirs through `createOutputObject` — their sources differ only in
 * shape (the agent pulls an async generator, the workflow pushes events from a promise), which
 * the `start` callback parameterizes away; `materialize` awaits the terminal record.
 *
 * Internal seam — not exported from any entry (the `standard-schema-runtime.ts` pattern). The
 * interface is shaped so it could be promoted to a public subpath as-is; that promotion needs its
 * own issue (explicit ratification) — this module changes no export surface.
 *
 * The pinned semantics (asserted through the public surface by the behavior contract,
 * `test/helpers/output-object-contract.ts`, running against both the agent and the workflows
 * suites):
 * - **Lazy start**: the source's `start` runs on first consumption — the first `next()` of the
 *   chunk stream or the first terminal read. A result nobody consumes never runs.
 * - **Single pass, single iterator**: one execution feeds both consumption styles; every
 *   `[Symbol.asyncIterator]()` call returns the same iterator.
 * - **Order and buffering**: chunks go to the waiting iterator, or buffer in stream order until
 *   one asks.
 * - **Failure after the buffer**: a failed run still delivers everything it produced; the error
 *   rejects the iterator only once the buffer has drained, and rejects every terminal promise
 *   with the same error.
 * - **Abandon stays local**: leaving the `for await` loop early ends that traversal (the buffer
 *   is dropped) but never the run — nothing propagates to the source, and the terminal values
 *   still settle from the same pass.
 * - **Lazy terminals**: a terminal promise is created when it is read (settling before the first
 *   read stores the outcome), so a run whose terminals nobody awaits cannot reject unhandled;
 *   reading twice returns the same promise.
 *
 * Load-bearing constraint for callers augmenting the returned object with extra fields: assign
 * them with `Object.assign`, never spread — reading a terminal property starts the run, and a
 * spread reads them all (laziness depends on it).
 */

/**
 * The dual-consumable shape: an async iterable of the run's chunks plus one lazy terminal promise
 * per key of the terminal record (`TTerminals` is the agent's `AgentGenerateResult` or the
 * workflow's `{ result }`).
 */
export type OutputObject<TChunk, TTerminals> = AsyncIterable<TChunk> & {
  readonly [K in keyof TTerminals]: Promise<TTerminals[K]>;
};

/**
 * The run behind an output object: `start` drives it once, handing each chunk to `deliver` in
 * stream order and resolving with the run's outcome (rejecting fails the run). A pull source
 * drains its generator; a push source resolves its promise — the pump below is identical either
 * way.
 */
export interface OutputSource<TChunk, TOutcome> {
  start(deliver: (chunk: TChunk) => void): Promise<TOutcome>;
}

/**
 * The terminal projection: one pure selector per terminal value, applied to the run's outcome
 * when it completes (the agent's seven, the workflow's single `result`). The keys of this record
 * are the output object's terminal getters.
 */
export type OutputProjections<TOutcome, TTerminals> = {
  readonly [K in keyof TTerminals]: (outcome: TOutcome) => TTerminals[K];
};

/**
 * Creates an output object over one run. See the module doc for the pump semantics; `project`'s
 * keys become the lazy terminal getters, its selectors settle them from the outcome.
 */
export function createOutputObject<TChunk, TOutcome, TTerminals>(
  source: OutputSource<TChunk, TOutcome>,
  project: OutputProjections<TOutcome, TTerminals>,
): OutputObject<TChunk, TTerminals> {
  let started = false;
  let settled = false;
  let failure: { readonly error: unknown } | undefined;
  /** Set when the consumer leaves the loop early; it ends that traversal, not the run. */
  let abandoned = false;
  const buffered: TChunk[] = [];
  const waiting: WaitForNext<TChunk>[] = [];
  const terminals = Object.entries(project).map(([key, select]) => ({
    key,
    select: select as (outcome: TOutcome) => unknown,
    terminal: createTerminal<unknown>(),
  }));

  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    try {
      settle(await source.start(deliver));
    } catch (error) {
      fail(error);
    }
  }

  /** Hands a chunk to the waiting iterator, or buffers it until one asks. */
  function deliver(chunk: TChunk): void {
    if (abandoned) return; // The consumer left; nothing will ever read this buffer again.
    const waiter = waiting.shift();
    if (waiter === undefined) {
      buffered.push(chunk);
      return;
    }
    waiter.resolve({ value: chunk, done: false });
  }

  /** The run completed: its projected terminal values settle every terminal. */
  function settle(outcome: TOutcome): void {
    settled = true;
    for (const waiter of waiting.splice(0)) waiter.resolve(DONE);
    for (const { select, terminal } of terminals) terminal.settle(select(outcome));
  }

  function fail(error: unknown): void {
    settled = true;
    failure = { error };
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    for (const { terminal } of terminals) terminal.fail(error);
  }

  const iterator: AsyncIterator<TChunk> = {
    next(): Promise<IteratorResult<TChunk>> {
      start();
      if (abandoned) return Promise.resolve(DONE);
      // Buffered chunks first: a failed run still delivers everything it produced before failing.
      const chunk = buffered.shift();
      if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
      if (failure !== undefined) return Promise.reject(failure.error);
      if (settled) return Promise.resolve(DONE);
      return new Promise<IteratorResult<TChunk>>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    return(): Promise<IteratorResult<TChunk>> {
      abandoned = true;
      buffered.length = 0;
      return Promise.resolve(DONE);
    },
  };

  const surface: Record<string | symbol, unknown> = { [Symbol.asyncIterator]: () => iterator };
  for (const { key, terminal } of terminals) {
    // One enumerable getter per terminal (object-literal semantics): reading it starts the run
    // and hands out the lazy promise; enumerability lets `materialize` discover the terminal keys.
    Object.defineProperty(surface, key, {
      enumerable: true,
      configurable: true,
      get() {
        start();
        return terminal.promise();
      },
    });
  }
  return surface as OutputObject<TChunk, TTerminals>;
}

/**
 * The terminal record of an output object, awaited: every terminal read together, the values
 * reassembled under the same keys. The one place repo-wide that enumerates the terminal keys —
 * a new terminal field joins the projections (and the types) and flows through here untouched.
 */
export async function materialize<TTerminals>(output: {
  readonly [K in keyof TTerminals]: Promise<TTerminals[K]>;
}): Promise<TTerminals> {
  const entries = await Promise.all(
    Object.entries(output as Record<string, Promise<unknown>>).map(
      async ([key, terminal]) => [key, await terminal] as const,
    ),
  );
  return Object.fromEntries(entries) as TTerminals;
}

interface WaitForNext<TChunk> {
  resolve(result: IteratorResult<TChunk>): void;
  reject(error: unknown): void;
}

const DONE: IteratorResult<never> = { value: undefined, done: true };

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
