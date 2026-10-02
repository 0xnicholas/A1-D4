import type { ModelMessage } from '../model/contract.js';
import type { StandardSchema } from '../standard-schema.js';
import { formatIssues, validateSchema } from '../standard-schema-runtime.js';
import { createInMemoryStore } from './in-memory-store.js';
import { supportsWorkingMemory } from './store.js';
import type { MemoryStore, WorkingMemoryStore } from './store.js';
import type { StoredMessage } from './types.js';
import { mergeWorkingMemory } from './working-memory.js';

/**
 * The `Memory` class — the memory subsystem's public object on top of the `MemoryStore` port
 * (message history, working memory and the configuration surface).
 *
 * Message history is the one mechanism on by default: `save` persists messages for a
 * thread/resource pair and `recall` is the single query entry point, returning messages in the
 * shape the model contract consumes. Threads are created on the write path — a `save` naming an
 * unknown thread creates it, a `recall` for an unknown thread is an empty history, never a write.
 *
 * Working memory is the optional second mechanism: resource-scoped, schema-validated structured
 * data, read through `getWorkingMemory` and merged/persisted through `updateWorkingMemory`. Both
 * live on the same instance and the same store; enabling working memory requires the store's
 * conditional resource pair (the port extension surface).
 */

/** `lastMessages` default — the recent-window size of message history. */
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
 * Working-memory configuration: enabled by its presence, shaped by the schema.
 * The schema is the contract of the memory's value — a Standard Schema dual interface (ADR-0003),
 * so the core neither reads nor rewrites it beyond validation and the JSON Schema it emits.
 */
export interface WorkingMemoryConfig {
  /** The shape the working memory must have; also what the model sees as the update tool's schema. */
  schema: StandardSchema;
}

/** The `new Memory(...)` config surface: every entry optional. */
export interface MemoryConfig {
  /** The storage port to persist through; absent = the core's in-memory default. */
  readonly storage?: MemoryStore | undefined;
  /** The default `recall` window size; absent = 10. */
  readonly lastMessages?: number | undefined;
  /**
   * Enables working memory for this instance: the schema-only, resource-scoped
   * block agents maintain through the `updateWorkingMemory` tool. Requires a store that declares
   * the conditional resource pair (`getResource` / `saveResource`) — enabling it without that
   * capability throws here, before any run.
   */
  readonly workingMemory?: WorkingMemoryConfig | undefined;
}

/** The `recall` query: the thread plus the port's paging knobs. */
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
  /** The default `recall` window size (history is truncated by count only). */
  readonly lastMessages: number;

  /** The working-memory config; `undefined` = this instance carries message history alone. */
  readonly workingMemory: WorkingMemoryConfig | undefined;

  private readonly storage: MemoryStore;

  /** The store when working memory is enabled; the constructor proved its conditional pair. */
  private readonly workingMemoryStore: WorkingMemoryStore | undefined;

  /** The last timestamp this instance issued — the monotonic clock of `nextTimestamp`. */
  private lastStamp = 0;

  constructor(config: MemoryConfig = {}) {
    this.storage = config.storage ?? createInMemoryStore();
    this.lastMessages = assertPositiveInteger(
      config.lastMessages ?? DEFAULT_LAST_MESSAGES,
      'Memory: lastMessages',
    );
    this.workingMemory = config.workingMemory;
    // Capability flag (the port extension surface): the conditional resource pair is the
    // port's working-memory declaration; a store without it cannot carry the feature, and finding
    // that out per run (or silently storing nothing) is worse than failing here.
    this.workingMemoryStore =
      this.workingMemory === undefined ? undefined : assertWorkingMemoryCapability(this.storage);
  }

  /**
   * The single query entry of message history: returns the thread's messages
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
   * A thread belongs to exactly one resource: a call
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
   * The working memory currently stored for a resource — schema-validated at
   * write time, so it is returned as stored; `undefined` when the resource has none yet. Working
   * memory is resource-scoped: unrelated to threads and untouched by `deleteThread`. Reading does
   * not re-validate: a record written under another schema (or by another writer) is injected as
   * it was stored — conformity is the write path's promise.
   */
  async getWorkingMemory(resource: string): Promise<unknown> {
    const { storage } = this.requireWorkingMemory();
    const record = await storage.getResource(resource);
    return record?.workingMemory;
  }

  /**
   * Merges a patch into a resource's working memory, validates the result against the configured
   * schema and persists it: objects merge deeply, `null` deletes a field, arrays
   * are replaced whole). Returns the validated value — what was stored, exactly.
   *
   * This is the semantic path behind the `updateWorkingMemory` tool and the programmatic write
   * entry: a patch that does not make the merged value conform throws (issues included) and writes
   * nothing — through the tool, that error is the error tool result the model recovers from. The
   * resource record is an upsert: `metadata` and `createdAt` of an existing record are preserved.
   *
   * Read-modify-write is not atomic: concurrent updates of one resource are last-write-wins (the
   * port's conditional pair has no compare-and-swap; additive-only evolution keeps that seam open).
   */
  async updateWorkingMemory(input: {
    readonly resource: string;
    readonly patch: unknown;
  }): Promise<unknown> {
    const { schema, storage } = this.requireWorkingMemory();
    const existing = await storage.getResource(input.resource);
    const validation = await validateSchema(
      schema,
      mergeWorkingMemory(existing?.workingMemory, input.patch),
    );
    if ('issues' in validation) {
      throw new Error(
        `Memory.updateWorkingMemory: the merged working memory for resource '${input.resource}' does not match the schema — ${formatIssues(validation.issues)}`,
      );
    }
    const now = new Date();
    await storage.saveResource({
      id: input.resource,
      ...(existing?.metadata === undefined ? {} : { metadata: existing.metadata }),
      workingMemory: validation.value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return validation.value;
  }

  /**
   * Working memory's capability of this instance, with the explicit error of asking for it when the
   * feature is off. The store half was settled by the capability check at construction; this reads
   * both under their narrowed types.
   */
  private requireWorkingMemory(): { schema: StandardSchema; storage: WorkingMemoryStore } {
    const config = this.workingMemory;
    const storage = this.workingMemoryStore;
    if (config === undefined || storage === undefined) {
      throw new Error(
        'Memory: workingMemory is not configured — pass workingMemory: { schema } to new Memory(...) to use it.',
      );
    }
    return { schema: config.schema, storage };
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

/**
 * The working-memory capability check (ADR-0010's capability flag): enabling working memory needs a
 * store that declares the conditional resource pair — a half implementation counts as absent
 * (`supportsWorkingMemory`). Resolved once, at construction: a store that cannot carry the feature
 * is a configuration error, not a per-run surprise.
 */
function assertWorkingMemoryCapability(store: MemoryStore): WorkingMemoryStore {
  if (!supportsWorkingMemory(store)) {
    throw new Error(
      'Memory: workingMemory is enabled, but the store is missing getResource/saveResource — the MemoryStore conditional pair is the working-memory capability.',
    );
  }
  return store;
}
