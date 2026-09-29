import { abortableSleep } from './abort.js';

/**
 * The fixed interval between a step's retry attempts (`docs/architecture/workflows.md`
 * 「错误、重试与状态机」): `retries` buys that many *extra* attempts at one fixed spacing — no
 * backoff, whose policy object is the field's reserved additive extension. The wait is an
 * in-process one like `.sleep()`, so cancellation cuts it short.
 */
export const STEP_RETRY_INTERVAL_MS = 1000;

/**
 * Runs one step's `execute` up to `retries + 1` times, waiting `STEP_RETRY_INTERVAL_MS` between
 * attempts, and rethrows the last error verbatim — never wrapped, never aggregated
 * (`docs/architecture/workflows.md`「错误、重试与状态机」).
 *
 * Retrying wraps `execute` only: the step boundary's IO validation happens once, before this is
 * called, because an input its schema rejects will not start passing on a second look.
 */
export async function executeWithRetries<T>(
  attempt: () => Promise<T>,
  retries: number,
  signal: AbortSignal,
): Promise<T> {
  for (let failed = 0; ; failed += 1) {
    try {
      return await attempt();
    } catch (error) {
      // Counting the failures also closes the door on an untrusted count (`createStep` validates
      // `retries`, but a hand-written step literal bypasses the factory): `NaN` compares false
      // here, so it spends no retry at all instead of retrying forever.
      if (!(failed < retries)) throw error;
      await abortableSleep(STEP_RETRY_INTERVAL_MS, signal);
    }
  }
}
