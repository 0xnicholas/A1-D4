/**
 * `@balsats/croner` — the croner wrapper capability package: a cron expression as one
 * `schedules.save()` fragment.
 *
 * `cron('0 9 * * *', { timezone: 'Asia/Shanghai' })` returns exactly the `next` + `timezone` slice
 * `ScheduleSaveInput` takes, so it spreads straight into `save()` — and the expression never lands
 * in the record: the persisted `ScheduleRecord` carries the timezone, while the truth for the
 * expression stays on the host side (config or code), paired with the record by id in-process.
 *
 * The `next` function is the whole wrapping: croner's `nextRun(from)` already computes the first
 * occurrence *strictly after* `from` — milliseconds stripped, `null` when the schedule is
 * exhausted — which is the framework's occurrence semantics exactly. Validation happens once, at
 * construction (see `cron`), and `next` is a pure computation afterwards.
 *
 * Spec: `docs/architecture/harness.md`「croner 封装能力包」. Facts on croner's API and DST
 * behavior: `docs/research/croner.md`.
 */
import { Cron } from 'croner';

/**
 * The `save()` fragment: the occurrence function plus the IANA timezone name, structurally the
 * `next` + `timezone` subset of `ScheduleSaveInput`. `timezone` is absent when the caller gave
 * none — then the expression is read in the process's own timezone (croner's default).
 */
export interface CronFragment {
  /** The first occurrence strictly after `from`, milliseconds stripped; `null` when none is left. */
  readonly next: (from: Date) => Date | null;
  /** The IANA timezone name the expression is read in; absent = the process timezone. */
  readonly timezone?: string;
}

/**
 * The closed option subset: `timezone` only. Every other croner construction option (`startAt`,
 * `stopAt`, `utcOffset`, `mode`, `domAndDow`, …) stays out — clamping wants are served by
 * destructuring `next` and wrapping it. The expression syntax itself is croner's full set
 * (5/6/7-part patterns, seconds-first in the 6-part form, `@daily`-style nicknames).
 */
export interface CronOptions {
  /** The IANA timezone name, passed through to croner untouched. */
  readonly timezone?: string;
}

/**
 * Builds the fragment from one cron expression: `new Cron(expression, { timezone })`, lazily —
 * croner registers no timer and creates no job when constructed without a callback. Everything is
 * validated here, synchronously, so a bad expression fails at the call site; `next` never throws.
 *
 * A colon-bearing date-time string is croner's once mode and passes through the same way: `next`
 * returns that instant until it has passed, then `null` — the framework's exhausted (`nextFireAt:
 * null`) shape. It is outside the cron-pattern surface, but nothing here rejects it: the wrapper's
 * stance is croner's behavior, passed through as-is.
 *
 * Package face: [`cron`], [`CronFragment`], [`CronOptions`].
 */
export function cron(expression: string, options: CronOptions = {}): CronFragment {
  const { timezone } = options;
  // Two separate option bags on purpose: croner mutates the bag it is constructed with (it fills
  // in its defaults in place), so sharing one would leak its whole option surface into the
  // returned fragment. The closed subset stays closed because the fragment is built from the
  // caller's `timezone` value, never from the mutated bag.
  const croner = new Cron(expression, timezone === undefined ? {} : { timezone });
  // Build-time probe: croner validates the pattern's structure and values at construction, but an
  // invalid IANA timezone only throws once a date is converted. Converting "now" here surfaces
  // that error at the call site — the same `next` call `save()` makes, so registration loses
  // nothing. The result is discarded (an exhausted schedule legitimately has no occurrence).
  croner.nextRun();
  return {
    next: (from) => croner.nextRun(from),
    ...(timezone === undefined ? {} : { timezone }),
  };
}
