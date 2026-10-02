/**
 * `@balsats/core/schedules` — schedules subsystem (one of the three harness subsystems).
 *
 * `createSchedules({ storage?, agents, signals? })`: the record CRUD + `tick` primitive — records
 * carry a `next` occurrence function (cron parsing injected, so the core stays zero-dependency) and
 * a target in one of two forms; `tick` reads the due records, fires them and advances `nextFireAt`.
 * Platform cron hitting an endpoint that calls `tick` is the first-class shape; `startTicker` is the
 * optional in-process convenience (single-process semantics). The `ScheduleStore` port (5 methods,
 * JSON-only records; the in-memory default ships with the core) is the persistence seam.
 */
export { createSchedules } from './schedules.js';
export type {
  ScheduleTicker,
  ScheduleTickerOptions,
  ScheduleTickOptions,
  Schedules,
  SchedulesConfig,
} from './schedules.js';
export { createInMemoryScheduleStore } from './in-memory-store.js';
export type { ScheduleStore } from './store.js';
export type {
  ScheduleAgentTarget,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleSaveInput,
  ScheduleSignalTarget,
  ScheduleTarget,
} from './types.js';
