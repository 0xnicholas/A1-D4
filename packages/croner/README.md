# `@balsats/croner`

Cron expressions for [Balsa](https://github.com/0xnicholas/balsa-framework) schedules: one `cron()`
call returns exactly the `next` + `timezone` fragment `schedules.save()` takes, so a schedule is
registered by spreading it in — and the expression never enters the record.

```ts
import { createSchedules } from '@balsats/core/schedules';
import { cron } from '@balsats/croner';

const schedules = createSchedules({ agents: { reporter } });

await schedules.save({
  id: 'daily-report',
  ...cron('0 9 * * *', { timezone: 'Asia/Shanghai' }),
  target: { agent: 'reporter', input: 'write the daily report' },
});

await schedules.tick(); // the platform cron's endpoint calls this
```

- Spec: [`docs/architecture/harness.md`](https://github.com/0xnicholas/balsa-framework/blob/main/docs/architecture/harness.md) —「croner 封装能力包(`@balsats/croner`)」
- Facts this package builds on: [`docs/research/croner.md`](https://github.com/0xnicholas/balsa-framework/blob/main/docs/research/croner.md)
- Decisions: [ADR-0002](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0002-package-structure.md) (packaging); harness spec ([ADR-0011](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0011-harness-semantics.md))
- Example: [`examples/cron-schedule`](https://github.com/0xnicholas/balsa-framework/blob/main/examples/cron-schedule) — save → occurrences advance → `tick` fires

## Install

```bash
npm install @balsats/croner
```

The wrapper is one exact-pinned dependency (`croner@10.0.1`, MIT, zero transitive packages, engines
`>=18`). There is **no `@balsats/core` peer**: the fragment is structurally just the `next` +
`timezone` slice of `ScheduleSaveInput`, so this package stands alone — install `@balsats/core`
separately when you actually call `schedules.save()`.

## The fragment

```ts
cron(expression, { timezone? }) // → { next: (from: Date) => Date | null, timezone? }
```

- **Spread or destructure, both work.** `{ ...cron(expr), target }` and
  `{ next: cron(expr).next, target }` are the same to `save()`. `timezone` is present only when
  given — absent, the expression is read in the process's own timezone (croner's default).
- **`next` is croner's `nextRun`.** The first occurrence strictly after `from`, milliseconds
  stripped, `null` when none is left (an exhausted schedule — e.g. a 7-part pattern whose year has
  passed). That is the framework's occurrence semantics exactly; no translation layer.
- **A date-time string is croner's once mode, passed through as-is.** `cron('2030-01-01T00:00:00Z')`
  returns that instant until it has passed, then `null` — `save()` records it and the target fires
  once, then the record is the exhausted `nextFireAt: null` form. Out of the cron-pattern surface,
  but the wrapper's stance is upstream behavior, recorded rather than compensated (same as DST).
- **The expression syntax is croner's full set** — 5-part, 6-part (seconds first) and 7-part
  (year last) patterns, `@daily`-style nicknames, month/weekday names, `L` / `W` / `#`.
- **The option subset is closed: `timezone` only.** croner's other construction options
  (`startAt` / `stopAt` / `utcOffset` / `mode` / `domAndDow` / …) are not exposed. Clamping wants
  are served by destructuring `next` and wrapping it yourself.
- **Everything is validated at the `cron()` call site, synchronously.** Structural and range
  errors are croner's own (`TypeError` / `RangeError`) and pass through untouched. Invalid IANA
  timezones — which croner only rejects lazily, on the first `nextRun` — are probed once at
  construction, so `cron('0 9 * * *', { timezone: 'Planet/Nowhere' })` throws right there. After
  that, `next` is pure computation and never throws.
- **The expression lives on the host side.** `save()` persists the timezone but never the pattern:
  keep `id ↔ expression` in your config or code and re-`save()` each definition at boot — `save()`
  re-anchors `nextFireAt` from `now`, so the definition you hold is authoritative.

## DST

Daylight-saving behavior is croner's, passed through untouched — this package neither compensates
nor hides it. Observed on `croner@10.0.1` with `Europe/Stockholm`, 2026: on the spring-forward gap
day `30 2 * * *` returns local **03:30 CEST** (the same instant `30 3 * * *` returns — an offset
mapping, which contradicts croner's README wording "gaps are skipped"; upstream behavior wins and
is recorded here), and on the fall-back overlap day the 02:30 pattern runs once, at the first
occurrence. Both cases are pinned in this package's tests, so a croner bump that changes DST
semantics fails loudly.
