/**
 * The suspend control signal (`docs/architecture/workflows.md`「suspend/resume 与快照」): calling
 * `suspend(payload)` never returns — it throws this branded signal, which unwinds the step and every
 * block around it (retries never re-run it, `foreach` and the loops never record it as a failure) up
 * to the walker's entry loop. There the walker decides: a `then` entry's step turns it into the run's
 * `suspended` outcome and a snapshot; anywhere else it is converted into an explicit error, because a
 * block's iteration site has no representation in the v1 snapshot shape.
 *
 * It is control flow, not failure — the one distinction every catch along the way has to keep.
 */
export class SuspendSignal extends Error {
  /** The step whose `execute` called `suspend` — the step a resume must target. */
  readonly stepId: string;
  /** The payload the step suspended with (recorded as the step's `suspendPayload`). */
  readonly payload: unknown;

  constructor(stepId: string, payload: unknown) {
    super(`step "${stepId}" suspended`);
    this.name = 'SuspendSignal';
    this.stepId = stepId;
    this.payload = payload;
  }
}

/** Whether a thrown value is the suspend control signal — `catch` sites use this to pass it through. */
export function isSuspendSignal(error: unknown): error is SuspendSignal {
  return error instanceof SuspendSignal;
}
