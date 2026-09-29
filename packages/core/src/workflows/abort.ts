/**
 * Cancellation (`docs/architecture/workflows.md`「错误、重试与状态机」): a run's `AbortSignal` fails
 * the run — there is no `canceled` state of its own, and `failed` is where an aborted run lands.
 * These three helpers are the whole vocabulary: the error an abort means, the boundary check every
 * walk step goes through, and the one wait cancellation cuts short (`.sleep()` and the fixed retry
 * interval — the run's in-process waits, which stay `running` while they wait).
 */

/**
 * The error an abort means: the signal's own reason (a caller may abort with an error of its own),
 * or an `AbortError` of ours when the aborter left a non-Error reason.
 */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Fails with the abort's error when the signal is aborted; a no-op otherwise. The boundary check
 * the walker runs before every entry (and a loop before every condition evaluation), so a run
 * whose signal is already aborted does nothing at all.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/**
 * Waits `durationMs` in-process (`setTimeout`), cut short by the signal: aborting rejects with the
 * abort's error right away and clears the timer. Not durable — a dying process drops the wait, and
 * a durable sleep is an external runner's business (`docs/architecture/workflows.md`
 * 「砍单与承载缝」).
 */
export function abortableSleep(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
