import type { ScheduleListQuery, ScheduleRecord } from './types.js';

/**
 * The schedules storage port (`docs/architecture/harness.md`「ScheduleStore」): the five methods
 * records live through, JSON-only records, isomorphic to the other three ports. Core ships an
 * in-memory default (`in-memory-store.ts`); real backends arrive as adapters of the unified family.
 *
 * Evolution is additive-only (ADR-0010, `docs/architecture/storage.md`): new capabilities arrive as
 * optional methods plus capability flags, never by changing these signatures.
 *
 * The port owns storage, not firing: no CAS, no claim, no lease — `tick` reads due records and the
 * caller (platform cron is the first-class form) drives it; multi-instance safety is the deployer's
 * (`harness.md`「Schedules」).
 */
export interface ScheduleStore {
  /** Upsert one record, replacing the previous record under the same id. */
  save(schedule: ScheduleRecord): Promise<void>;
  /** Fetch one record by id; `null` when the store has none. */
  get(id: string): Promise<ScheduleRecord | null>;
  /** List records (see `ScheduleListQuery` for order and cursor semantics). */
  list(query?: ScheduleListQuery): Promise<ScheduleRecord[]>;
  /** Delete a record; deleting an absent id is a no-op. */
  delete(id: string): Promise<void>;
  /** The records due at `now`: enabled, with a next occurrence at or before it, soonest first. */
  listDue(now: Date): Promise<ScheduleRecord[]>;
}
