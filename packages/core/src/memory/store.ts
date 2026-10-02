import type {
  ListMessagesQuery,
  ListThreadsQuery,
  StoredMessage,
  StoredResource,
  StoredThread,
} from './types.js';

/**
 * The memory storage port: six required
 * methods plus the conditional resource pair, required only when working memory is enabled.
 *
 * Evolution discipline is additive-only (ADR-0010): required
 * signatures never change; new capabilities arrive as optional methods whose existence is the
 * capability declaration — see `supportsWorkingMemory` for the detection convention.
 */
export interface MemoryStore {
  /** Fetch one thread; `null` when absent. */
  getThreadById(id: string): Promise<StoredThread | null>;
  /** Upsert a full thread record (create and update share this one entry). */
  saveThread(thread: StoredThread): Promise<void>;
  /** Delete a thread and cascade-delete its messages; resource-level data is untouched. */
  deleteThread(id: string): Promise<void>;
  /** List one resource's threads (see `ListThreadsQuery` for ordering/cursor semantics). */
  listThreads(query: ListThreadsQuery): Promise<StoredThread[]>;
  /** List one thread's messages (see `ListMessagesQuery` for ordering/cursor semantics). */
  listMessages(query: ListMessagesQuery): Promise<StoredMessage[]>;
  /** Batch-save messages (upsert by id). */
  saveMessages(messages: StoredMessage[]): Promise<void>;
  /** Fetch one resource; `null` when absent. Conditional: working-memory capability. */
  getResource?(id: string): Promise<StoredResource | null>;
  /** Upsert a full resource record. Conditional: working-memory capability. */
  saveResource?(resource: StoredResource): Promise<void>;
}

/** A `MemoryStore` with the conditional resource pair present (working-memory capable). */
export interface WorkingMemoryStore extends MemoryStore {
  getResource(id: string): Promise<StoredResource | null>;
  saveResource(resource: StoredResource): Promise<void>;
}

/**
 * The capability-flag detection convention (the port extension surface): the
 * conditional resource methods count as a pair — a store declares working-memory support only
 * when both exist; a half implementation is treated as absent (the caller degrades or throws).
 */
export function supportsWorkingMemory(store: MemoryStore): store is WorkingMemoryStore {
  return typeof store.getResource === 'function' && typeof store.saveResource === 'function';
}
