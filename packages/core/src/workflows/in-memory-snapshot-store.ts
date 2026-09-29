import type { WorkflowRunSnapshot, WorkflowSnapshotStore } from './snapshot.js';

/**
 * The core's in-memory default `WorkflowSnapshotStore` (Map-backed, zero runtime burden): a workflow
 * without attached storage keeps its snapshots in process memory, so suspend/resume still runs — the
 * snapshot simply does not outlive the process. One store per run holds every snapshot of that run,
 * keyed by run id; later writes replace earlier ones.
 *
 * It doubles as the reference for adapter authors: reads and writes cross the port as deep copies
 * (`structuredClone`), so stored state changes only through the port, exactly like a serializing
 * backend — and a snapshot that cannot be cloned is a snapshot that violates the JSON-only rule.
 */
export function createInMemorySnapshotStore(): WorkflowSnapshotStore {
  const snapshots = new Map<string, WorkflowRunSnapshot>();

  return {
    load: async (runId) => {
      const snapshot = snapshots.get(runId);
      return snapshot === undefined ? null : structuredClone(snapshot);
    },

    save: async (runId, snapshot) => {
      snapshots.set(runId, structuredClone(snapshot));
    },
  };
}
