/**
 * `@balsa/core/memory` — memory subsystem.
 *
 * Thread/resource identity, message history (recall), working memory, the storage port, and its
 * in-memory default implementation.
 * Spec: `docs/architecture/memory.md`; port evolution discipline (additive-only): ADR-0010,
 * `docs/architecture/storage.md`.
 *
 * This entry exports the storage port (`MemoryStore`, 6 required + 2 conditional resource
 * methods), the stored-record types, the capability-flag detection convention, the in-memory
 * default store, and the `Memory` class (message history: recall/save).
 */
export { createInMemoryStore } from './in-memory-store.js';
export { Memory } from './memory.js';
export type {
  MemoryConfig,
  MemoryThreadRef,
  RecallQuery,
  SaveInput,
  SaveMessage,
  WorkingMemoryConfig,
} from './memory.js';
export { supportsWorkingMemory } from './store.js';
export type { MemoryStore, WorkingMemoryStore } from './store.js';
export type {
  ListMessagesQuery,
  ListThreadsQuery,
  StoredMessage,
  StoredResource,
  StoredThread,
} from './types.js';
