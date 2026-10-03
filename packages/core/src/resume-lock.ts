/**
 * The in-process resume lock (suspend/resume and snapshots): at most one resume per snapshot
 * identity — the `(store, runId)` pair a snapshot persists under — at a time. A resume that finds
 * its identity already in flight joins that promise instead of loading the same suspended snapshot
 * twice; the entry clears when the resume settles, so a run that suspended again can be resumed
 * again. Keying by the store object (WeakMap), not the run id alone, is what keeps two stores that
 * happen to hold the same run id independent — joining them would hand a caller the other store's
 * (wrongly typed) outcome.
 *
 * The mechanism is shared; the registry is not — each subsystem holds its own module-level
 * instance, so a workflow resume and a durable-agent resume never merge even when a unified
 * adapter serves both snapshot ports from one store object. Cross-process safety stays the
 * store's concern (CAS is the adapter's optional extension, ADR-0010), not the core's.
 */
export interface ResumeLock {
  /**
   * Runs `task` under the lock for `(store, runId)`: the first caller's task executes, concurrent
   * callers join its promise, and the entry is deleted on settle. `T` flows from the task —
   * joining only ever happens between resumes of one snapshot identity, so the joined promise is
   * the caller's own type.
   */
  run<T>(store: object, runId: string, task: () => Promise<T>): Promise<T>;
}

/** Creates one registry. One per subsystem (see the module doc). */
export function createResumeLock(): ResumeLock {
  const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();
  return {
    run<T>(store: object, runId: string, task: () => Promise<T>): Promise<T> {
      let byRunId = inFlight.get(store);
      if (byRunId === undefined) {
        byRunId = new Map();
        inFlight.set(store, byRunId);
      }
      const running = byRunId.get(runId);
      if (running !== undefined) return running as Promise<T>;
      let locked: Promise<T> | undefined;
      locked = task().finally(() => {
        if (locked !== undefined && byRunId.get(runId) === locked) byRunId.delete(runId);
      });
      byRunId.set(runId, locked);
      return locked;
    },
  };
}
