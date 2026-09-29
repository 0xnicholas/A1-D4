import type { WorkflowIterationSite } from './snapshot.js';

/**
 * The suspend control signal (`docs/architecture/workflows.md`「suspend/resume 与快照」): calling
 * `suspend(payload)` never returns — it throws this branded signal, which unwinds the step and every
 * block around it (retries never re-run it, `foreach` and the loops never record it as a failure) up
 * to the walker's entry loop. There the walker turns it into the run's `suspended` outcome and a
 * snapshot. A block the signal passes through enriches it with its iteration site (#54) — the facts
 * `resume` needs to re-enter that block — before rethrowing; a top-level `then` suspension carries
 * none.
 *
 * It is control flow, not failure — the one distinction every catch along the way has to keep.
 */
export class SuspendSignal extends Error {
  /** The step whose `execute` called `suspend` — the step a resume must target. */
  readonly stepId: string;
  /** The payload the step suspended with (recorded as the step's `suspendPayload`). */
  readonly payload: unknown;
  /** Set by the enclosing block before rethrowing (#54); absent on a top-level `then` suspension. */
  iterationSite?: WorkflowIterationSite;

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
