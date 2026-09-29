import type { ModelMessage } from '../model/contract.js';
import type { StandardSchema } from '../standard-schema.js';
import { createInMemoryStore } from './in-memory-store.js';
import type { MemoryStore } from './store.js';
import type { StoredMessage } from './types.js';

/**
 * The `Memory` class — the memory subsystem's public object on top of the `MemoryStore` port
 * (spec: `docs/architecture/memory.md` 消息历史节 + 配置表面节).
 *
 * Message history is the one mechanism on by default: `save` persists messages for a
 * thread/resource pair and `recall` is the single query entry point, returning messages in the
 * shape the model contract consumes. Threads are created on the write path — a `save` naming an
 * unknown thread creates it, a `recall` for an unknown thread is an empty history, never a write.
 */

/** `lastMessages` default — the recent-window size of message history (spec 消息历史节). */
const DEFAULT_LAST_MESSAGES = 10;

/**
 * A reference to a thread: the id alone, or the id plus the `title` / `metadata` a missing thread
 * is created with (and `save` applies to an existing thread when provided).
 */
export type MemoryThreadRef =
  | string
  | { id: string; title?: string; metadata?: Record<string, unknown> };

/**
 * A message handed to `save`: a model-contract message plus an *optional* storage envelope. The
 * caller may bring `id` / `createdAt` (explicit values are persisted as given); the rest of the
 * envelope is always Memory's — `threadId` / `resourceId` come from the call's `thread` /
 * `resource`, never from the message body.
 */
export type SaveMessage = ModelMessage & { id?: string; createdAt?: Date };

/**
 * Working-memory configuration — accepted and held here, inert in this ticket: its semantics
 * (schema merge, injection, the `updateWorkingMemory` tool) land with the working-memory ticket.
 */
export interface WorkingMemoryConfig {
  schema: StandardSchema;
}

/** The `new Memory(...)` config surface (spec 配置表面节): every entry optional. */
export interface MemoryConfig {
  /** The storage port to persist through; absent = the core's in-memory default. */
  readonly storage?: MemoryStore | undefined;
  /** The default `recall` window size; absent = 10. */
  readonly lastMessages?: number | undefined;
  /** Reserved for working memory; inert until its ticket lands. */
  readonly workingMemory?: WorkingMemoryConfig | undefined;
}

/** The `recall` query: the thread plus the port's paging knobs (spec 消息历史节「单一查询入口」). */
export interface RecallQuery {
  /** The thread to read history from. */
  readonly threadId: string;
  /** Page size; absent = this instance's `lastMessages` window. */
  readonly limit?: number | undefined;
  /** Cursor: only messages strictly older than the referenced message id are returned. */
  readonly before?: string | undefined;
  /** Presentation order; absent = `'asc'` (chronological, ready to feed the model). */
  readonly order?: 'asc' | 'desc' | undefined;
}

/** The `save` input: the thread/resource identity plus the messages to append. */
export interface SaveInput {
  /** The thread to save into — created when it does not exist yet. */
  readonly thread: MemoryThreadRef;
  /** The thread's owner (and the `resourceId` stamped on every saved message). */
  readonly resource: string;
  /** The messages to persist, in order. */
  readonly messages: readonly SaveMessage[];
}

/** The memory subsystem's entry object. */
export class Memory {
  /** The default `recall` window size (spec: message history is truncated by count only). */
  readonly lastMessages: number;

  /** Held for the working-memory ticket; reading it here has no effect in this ticket. */
  readonly workingMemory: WorkingMemoryConfig | undefined;

  private readonly storage: MemoryStore;

  /** The last timestamp this instance issued — the monotonic clock of `nextTimestamp`. */
  private lastStamp = 0;

  constructor(config: MemoryConfig = {}) {
    this.storage = config.storage ?? createInMemoryStore();
    this.lastMessages = assertPositiveInteger(
      config.lastMessages ?? DEFAULT_LAST_MESSAGES,
      'Memory: lastMessages',
    );
    this.workingMemory = config.workingMemory;
  }

  /**
   * The single query entry of message history (spec 消息历史节): returns the thread's messages
   * with the storage envelope, in chronological order by default — directly feedable to a model.
   * Without an explicit `limit` the instance's `lastMessages` window applies; `before` pages
   * towards older history. Unknown threads read as an empty history.
   */
  async recall(query: RecallQuery): Promise<StoredMessage[]> {
    return this.storage.listMessages({
      threadId: query.threadId,
      limit:
        query.limit === undefined
          ? this.lastMessages
          : assertPositiveInteger(query.limit, 'recall: limit'),
      order: query.order ?? 'asc',
      ...(query.before === undefined ? {} : { before: query.before }),
    });
  }

  /**
   * Persists messages into a thread, creating the thread when it does not exist yet (with the
   * reference's `title` / `metadata`; applying them to an existing thread when provided, leaving
   * them untouched otherwise). Fills the parts of the envelope the caller left out (`id` via
   * `crypto.randomUUID()`, `createdAt` from this instance's stamp sequence) and stamps `threadId`
   * / `resourceId` from the call. Returns the messages as persisted, envelope included.
   *
   * A thread belongs to exactly one resource (no ownership migration, spec 身份模型节): a call
   * naming an existing thread with a different `resource` throws before anything is written.
   */
  async save(input: SaveInput): Promise<StoredMessage[]> {
    const thread = threadRefOf(input.thread);
    const messages = input.messages.map((message) => ({
      ...message,
      id: message.id ?? crypto.randomUUID(),
      createdAt: message.createdAt ?? this.nextTimestamp(),
      threadId: thread.id,
      resourceId: input.resource,
    }));

    await this.ensureThread(thread, input.resource, messages.length > 0);
    if (messages.length > 0) await this.storage.saveMessages(messages);
    return messages;
  }

  /**
   * The write path's thread handling: create a missing thread, refresh `updatedAt` when messages
   * are persisted (thread listing is most-recently-active first), and refuse a resource mismatch.
   */
  private async ensureThread(
    thread: NormalizedThreadRef,
    resource: string,
    persistedMessages: boolean,
  ): Promise<void> {
    const existing = await this.storage.getThreadById(thread.id);
    const now = new Date();
    if (existing === null) {
      await this.storage.saveThread({
        id: thread.id,
        resourceId: resource,
        ...(thread.title === undefined ? {} : { title: thread.title }),
        ...(thread.metadata === undefined ? {} : { metadata: thread.metadata }),
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    if (existing.resourceId !== resource) {
      throw new Error(
        `Memory.save: thread '${thread.id}' belongs to resource '${existing.resourceId}', not '${resource}' — ownership is not migrated`,
      );
    }
    const title = thread.title ?? existing.title;
    const metadata = thread.metadata ?? existing.metadata;
    if (!persistedMessages && title === existing.title && metadata === existing.metadata) return;
    await this.storage.saveThread({
      ...existing,
      ...(title === undefined ? {} : { title }),
      ...(metadata === undefined ? {} : { metadata }),
      updatedAt: persistedMessages ? now : existing.updatedAt,
    });
  }

  /**
   * Issues the `createdAt` of a message that arrived without one: strictly increasing in save
   * order (never more than a millisecond past the clock), so recall reads back the order the
   * caller saved in — two messages of the same millisecond would otherwise be ordered by id.
   */
  private nextTimestamp(): Date {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp);
  }
}

/** A thread reference normalized to its record parts. */
interface NormalizedThreadRef {
  readonly id: string;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Normalizes the id-only and id-plus-metadata reference forms into one shape. */
function threadRefOf(thread: MemoryThreadRef): NormalizedThreadRef {
  return typeof thread === 'string' ? { id: thread } : thread;
}

/** Message history is truncated by count only — a window size is a positive integer or a bug. */
function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}
