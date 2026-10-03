/**
 * The run's default `signal` (the `RequestContext` convention, `agent/types.ts`): a run started
 * without one carries a signal that never aborts, so tools and steps always receive an
 * `AbortSignal`. One instance repo-wide — the agent and workflow run engines share it.
 *
 * Internal seam — not exported from any entry.
 */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;
