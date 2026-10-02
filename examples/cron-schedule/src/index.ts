/**
 * Balsats cron-schedule example — a cron expression becomes the `next` fragment `schedules.save()`
 * takes, and the schedule's whole life is walked one act at a time.
 *
 * One script, no external services: a **scripted model** (defined in this file — no API key, no
 * network) plays the reporting agent that a threadless target runs, and `@balsats/croner` turns one
 * expression into the occurrence function the schedules subsystem asks for.
 *
 * 1. **Save: the fragment slots straight in.** `{ ...cron('0 9 * * *', { timezone:
 *    'Asia/Shanghai' }), target }` is structurally the `next` + `timezone` slice `ScheduleSaveInput`
 *    takes. `save()` calls `next` once at `now` and stores `nextFireAt` plus the timezone; the
 *    expression itself stays here, in the host's definition — never in the record.
 * 2. **`next` advances as pure computation.** Asked for the first occurrence strictly after a
 *    moment, the fragment walks the schedule forward — no ticker, no timer, no process.
 * 3. **`tick` fires when due.** A tick before the due instant is a no-op; at the due instant the
 *    threadless target runs the agent — one `agent-run` span, and no span for the tick itself —
 *    and the record re-anchors to the following occurrence.
 * 4. **The failure face is the call site.** A bad expression, a bad value and a bad IANA timezone
 *    all throw from `cron()`: the timezone is probed at construction because croner would defer it
 *    to the first `nextRun`.
 * 5. **DST passes through as-is.** The spring-forward and fall-back facts of the pinned croner are
 *    printed, not compensated — they are the product surface, recordable only as observed.
 *
 * The script self-asserts (`node:assert/strict`): any violated payoff exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @balsats/example-cron-schedule start
 */
import assert from 'node:assert/strict';
import { createApp } from '@balsats/core';
import type { Model, ModelStreamPart } from '@balsats/core/model';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@balsats/core/observability';
import type { ExportedSpan } from '@balsats/core/observability';
import { createInMemoryScheduleStore } from '@balsats/core/schedules';
import { cron } from '@balsats/croner';

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT = 'Daily report: 3 orders open, nothing needs attention.';

// ── The scripted model: one fixed report per run, no network ─────────────────────────────────────

/** A minimal scripted `Model` (the vendor contract): every call streams the same report. */
function scriptedReporter(): Model {
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'scripted-mini',
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async () => {
      const parts: ModelStreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: REPORT },
        { type: 'text-end', id: 'text-0' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 18, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 11, text: undefined, reasoning: undefined },
          },
        },
      ];
      return {
        stream: new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

// ── The composition root wires the tracer, the store and the agent ───────────────────────────────

const exporter = memoryExporter({ capacity: 1_000 });
const tracer = createTracer({ exporters: [exporter] });
const scheduleStore = createInMemoryScheduleStore();
const app = createApp({ tracer, storage: { schedules: scheduleStore } });

const reporter = app.agent({
  name: 'reporter',
  instructions: 'You are the shop\'s reporting desk. Answer with the daily report, one line.',
  model: scriptedReporter(),
});

// Threadless targets run `agents[name].generate(input)`; `tick` is the whole runtime.
const schedules = app.schedules({ agents: { reporter } });

/** The `agent-run` spans exported since the last `exporter.clear()`. */
function runSpans(): readonly ExportedSpan[] {
  return exporter.spans().filter((span) => span.type === AGENT_RUN_SPAN);
}

/** The stored occurrence of one schedule id (`null` when the record says it is exhausted). */
async function dueOf(id: string): Promise<number | null> {
  return (await scheduleStore.get(id))?.nextFireAt ?? null;
}

function act(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

async function main(): Promise<void> {
  console.log('cron-schedule — one expression becomes the occurrence function schedules.save() takes.');

  // ── Act 1: the fragment slots into save() ───────────────────────────────────────────────────
  act("Act 1 — save: { ...cron('0 9 * * *', { timezone: 'Asia/Shanghai' }), target }");
  const definition = cron('0 9 * * *', { timezone: 'Asia/Shanghai' });
  const savedAt = Date.now();
  const record = await schedules.save({
    id: 'daily-report',
    ...definition,
    target: { agent: 'reporter', input: 'write the daily report' },
  });

  assert.ok(record.nextFireAt !== null, 'the saved schedule must have a next occurrence');
  const occurrence = new Date(record.nextFireAt);
  // 09:00 Asia/Shanghai is 01:00 UTC — Shanghai has no DST, so the UTC clock reading is pinned.
  assert.equal(occurrence.getUTCHours(), 1, 'the occurrence must be 09:00 Asia/Shanghai (01:00 UTC)');
  assert.equal(occurrence.getUTCMinutes(), 0);
  assert.equal(occurrence.getUTCSeconds(), 0);
  assert.equal(occurrence.getUTCMilliseconds(), 0, 'nextRun strips milliseconds');
  assert.ok(occurrence.getTime() > savedAt, 'the occurrence must be strictly after save');
  assert.ok(occurrence.getTime() - savedAt <= DAY_MS, 'the occurrence must be within one day');
  assert.equal(record.timezone, 'Asia/Shanghai', 'the timezone rides the record');
  // The expression stays host-side: the persisted record never carries it (functions do not
  // serialize; the record is the occurrence cache, the definition is authority).
  assert.ok(!JSON.stringify(record).includes('0 9 * * *'), 'the expression must not enter the record');
  assert.deepEqual(await scheduleStore.get('daily-report'), record);

  console.log(`  fragment     next + timezone only: ${JSON.stringify(Object.keys(definition))}`);
  console.log(
    `  record       id='${record.id}'  nextFireAt=${occurrence.toISOString()}  timezone=${record.timezone}`,
  );
  console.log(`  expression   not in the record — it lives here, next to the id '${record.id}'`);

  // ── Act 2: next advances without any runtime ─────────────────────────────────────────────────
  act('Act 2 — next: pure computation, first occurrence strictly after from');
  let from = new Date('2026-01-01T00:00:00Z');
  const first = from.toISOString();
  const walked: Date[] = [];
  for (let day = 0; day < 3; day += 1) {
    const occurrence = definition.next(from);
    assert.ok(occurrence !== null, 'a daily schedule must keep producing occurrences');
    assert.equal(occurrence.getUTCHours(), 1, 'every occurrence is 09:00 Asia/Shanghai (01:00 UTC)');
    walked.push(occurrence);
    from = occurrence;
  }
  assert.deepEqual(
    walked.map((occurrence) => occurrence.toISOString()),
    ['2026-01-01T01:00:00.000Z', '2026-01-02T01:00:00.000Z', '2026-01-03T01:00:00.000Z'],
    'occurrences advance one day at a time',
  );
  console.log(`  from         ${first}`);
  for (const [index, occurrence] of walked.entries()) {
    console.log(`  next #${index + 1}     ${occurrence.toISOString()}`);
  }
  // ── Act 3: tick fires the due record and re-anchors it ───────────────────────────────────────
  act('Act 3 — tick: nothing due early, the target runs at due, nextFireAt advances');
  exporter.clear();
  await schedules.tick({ now: new Date(record.nextFireAt - 1) });
  assert.equal(runSpans().length, 0, 'a tick one millisecond early must fire nothing');
  assert.equal(await dueOf('daily-report'), record.nextFireAt);
  console.log('  tick(-1 ms)  nothing due — 0 runs, record unchanged');

  let anchor: number = record.nextFireAt;
  for (let beat = 1; beat <= 2; beat += 1) {
    exporter.clear();
    await schedules.tick({ now: new Date(anchor) });
    const runs = runSpans();
    assert.equal(runs.length, 1, `beat ${beat}: the due record must fire exactly one run`);
    assert.equal(runs[0]?.output, REPORT, 'the threadless target must run the agent to its terminal text');
    // The tick itself opens no span: everything exported in this window belongs to the run's tree.
    assert.ok(
      exporter.spans().every((span) => span.traceId === runs[0]?.traceId),
      `beat ${beat}: a span outside the triggered run's trace appeared — the tick opened a span`,
    );
    const advanced = await dueOf('daily-report');
    assert.ok(advanced !== null, `beat ${beat}: the record must have a next occurrence`);
    assert.equal(advanced, anchor + DAY_MS, `beat ${beat}: the record must advance exactly one day`);
    anchor = advanced;
    console.log(
      `  tick(due)    beat ${beat}: 1 run → "${runSpans()[0]?.output}"  nextFireAt=${new Date(anchor).toISOString()} (+24h)`,
    );
  }
  console.log('  tick itself  opens no span — the run it triggers carries its own agent-run span');

  // ── Act 4: the failure face is the cron() call site ──────────────────────────────────────────
  act('Act 4 — the failure face: everything throws at cron(), nothing is deferred');
  assert.throws(() => cron('not a cron'), {
    name: 'TypeError',
    message: /exactly five, six, or seven space separated parts/,
  });
  assert.throws(() => cron('61 * * * *'), { name: 'RangeError', message: /Invalid value for minute: 61/ });
  assert.throws(() => cron('0 9 * * *', { timezone: 'Planet/Nowhere' }), {
    name: 'TypeError',
    message: /Planet\/Nowhere/,
  });
  console.log("  cron('not a cron')                            → TypeError (pattern structure)");
  console.log("  cron('61 * * * *')                            → RangeError (value range)");
  console.log("  cron('0 9 * * *', { timezone: 'Planet/Nowhere' }) → TypeError (probing nextRun at construction)");

  // ── Act 5: DST passes through as-is ──────────────────────────────────────────────────────────
  act('Act 5 — DST as-is: the pinned croner behavior, printed not compensated');
  const stockholm = cron('30 2 * * *', { timezone: 'Europe/Stockholm' });
  const gap = stockholm.next(new Date('2026-03-28T12:00:00Z'));
  const overlap = stockholm.next(new Date('2026-10-24T12:00:00Z'));
  assert.equal(gap?.toISOString(), '2026-03-29T01:30:00.000Z', 'gap day: 02:30 maps to 03:30 CEST');
  assert.equal(overlap?.toISOString(), '2026-10-25T00:30:00.000Z', 'overlap day: only the first 02:30 runs');
  console.log(`  2026-03-29   30 2 * * * → ${gap?.toISOString()}  (local 03:30 CEST — the gap is offset-mapped)`);
  console.log(`  2026-10-25   30 2 * * * → ${overlap?.toISOString()}  (local 02:30 CEST — first occurrence only)`);

  console.log(
    '\nDone — the fragment slotted into save(), next walked the schedule, two ticks fired their ' +
      'reports and advanced the record, and every error surfaced at the call site.',
  );
}

await main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
