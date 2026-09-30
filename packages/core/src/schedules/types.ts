import type { MemoryThreadRef } from '../memory/index.js';
import type { ModelMessage } from '../model/contract.js';
import type { SignalPayload } from '../signals/index.js';

/**
 * Record shapes of the schedules subsystem (`docs/architecture/harness.md`「Schedules」节). Records
 * are the JSON-serializable state line the `ScheduleStore` persists — the `next` function that
 * computes occurrences is *not* part of the record (functions do not serialize): it is registered
 * in-process by `createSchedules().save()` and paired with the persisted record by id.
 * Evolution of the ports is additive-only (ADR-0010, `docs/architecture/storage.md`).
 */

/**
 * Threadless targets: the trigger runs the named agent once, isolated — `agents[name].generate(input)`,
 * no memory identity, no thread (the mastra 「threadless」mode). Message history is untouched.
 */
export interface ScheduleAgentTarget {
  /** The agent to run, by name in `createSchedules({ agents })`. */
  readonly agent: string;
  /** The input the run starts from — the agent's own `generate` input shape. */
  readonly input: string | ModelMessage[];
}

/**
 * Threaded targets: the trigger injects a signal into a conversation — `signals.sendSignal({ thread,
 * resource }, payload)` — so the run wakes (or an active one receives it) exactly as any other
 * signal（复用基础 signals;the facade requires a `signals` instance to accept this shape）. The
 * payload is the caller's, `type` included: the core adds nothing to it.
 */
export interface ScheduleSignalTarget {
  /** The thread the signal lands in (a `Memory` thread id, or id plus creation fields). */
  readonly thread: MemoryThreadRef;
  /** The thread's owner (`resourceId`), as every signals target requires. */
  readonly resource: string;
  /** The signal payload to send — open `type` plus the sender's own fields. */
  readonly payload: SignalPayload;
}

/**
 * What a trigger does (`harness.md`「Schedules」: target 两形态). The two forms are distinguished by
 * their fields: a `thread` selects the threaded (signals) form, `agent` the threadless one.
 */
export type ScheduleTarget = ScheduleAgentTarget | ScheduleSignalTarget;

/**
 * One schedule as the store persists it (the `ScheduleStore` port's unit). JSON-only, like the two
 * snapshot ports: large data is referenced, never embedded.
 */
export interface ScheduleRecord {
  /** Identity of the schedule — the key `get` / `listDue` / `delete` speak, and the `next` pairing key. */
  id: string;
  /**
   * The next occurrence, milliseconds since epoch (JSON-friendly; `new Date(ms)` converts), or
   * `null` when the registered `next` said there is none — an exhausted (e.g. one-shot past its
   * moment) schedule. A due record is one whose `nextFireAt <= tick's now`.
   */
  nextFireAt: number | null;
  /** What firing this record does (see `ScheduleTarget`). */
  target: ScheduleTarget;
  /**
   * The IANA timezone name carried through untouched — the core never interprets it. It is for the
   * host: the material the `next` function (e.g. a croner wrapper) is built from, or display.
   */
  timezone?: string;
  /** A paused record is never due; absent at the facade (`save` defaults to `true`). */
  enabled: boolean;
  /** Opaque caller metadata, persisted as given. */
  metadata?: Record<string, unknown>;
}

/**
 * The `schedules.save()` input: the record's fields plus the occurrence function. `next(from)`
 * returns the first occurrence strictly after `from`, or `null` when the schedule has none left —
 * cron parsing is injected this way, so the core stays zero-dependency (`harness.md`「Schedules」).
 */
export interface ScheduleSaveInput {
  /** Explicit identity (the upsert key); absent = the facade mints one. */
  readonly id?: string;
  /** Next occurrence after `from`, or `null` for none (see the interface doc). */
  next: (from: Date) => Date | null;
  /** What firing does (see `ScheduleTarget`). */
  readonly target: ScheduleTarget;
  /** The IANA timezone name, carried through untouched (see `ScheduleRecord.timezone`). */
  readonly timezone?: string;
  /** Paused when `false`; absent = enabled. */
  readonly enabled?: boolean;
  /** Opaque caller metadata (see `ScheduleRecord.metadata`). */
  readonly metadata?: Record<string, unknown>;
}

/**
 * The `ScheduleStore.list()` query. Listing runs soonest-first (`nextFireAt` ascending, records with
 * `nextFireAt: null` last, `id` as tie-break), and `before` is the port family's cursor convention
 * (as in `MemoryStore.listThreads`): a record id, and the page continues strictly *past* the
 * referenced record in that order — here that means later fire times.
 */
export interface ScheduleListQuery {
  /** Page size, anchored at the head of the order. Positive integer. */
  limit?: number;
  /** Cursor record id; a dangling cursor is a caller bug and throws. */
  before?: string;
}
