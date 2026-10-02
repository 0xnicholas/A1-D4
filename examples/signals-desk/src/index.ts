/**
 * Balsa signals-desk example — one support thread that messages and signals both land in.
 *
 * A scripted, non-interactive run drives one shop's support desk over a real OpenAI model and
 * shows the M4 signals subsystem end to end, with the schedules primitive wired into the same
 * thread. The fixed three sentences are the whole API surface: 活跃 = 注入当前 run(下一 step 生效);
 * 空闲 = 唤醒新 run;queueMessage = 排队保序. Around them, the two observation surfaces: the four
 * methods, and the chunk subscription a woken run can only be watched through.
 *
 * The acts:
 *
 * 1. **An idle thread: sendMessage wakes a run.** The subscription is attached first —
 *    `subscribeToThread` has no replay — and the woken run is watched through it, because a wake
 *    hands out no output object to await.
 * 2. **The run is parked mid-tool: sendMessage injects.** The desk pages its supervisor (the script
 *    plays the supervisor) and waits: that parked window is what makes "the run is active" a fact
 *    of the script instead of a race. The message sent in that window does not wake anything — it
 *    lands at the loop's next step boundary, at the tail of the run's second model call, and in
 *    message history as an ordinary message.
 * 3. **Queued while live: queueMessage keeps the order.** Two messages sent during that window wait
 *    for the run to end, then land as the input of *one* continuation run, in arrival order.
 * 4. **A system signal: sendSignal injects a typed payload.** Rendered as one `[signal] {…}` user
 *    message — the receiver's protocol, not the core's — landing in the prompt and in history.
 * 5. **A scheduled trigger: the schedules primitive fires into the same thread.** A record carries
 *    an injected `next` occurrence function (cron parsing never enters the core) and a threaded
 *    target; `tick` reads what is due, sends the signal, and advances `nextFireAt`.
 *
 * The script asserts its own payoff: a signal that woke a second run instead of injecting, an
 * injected message that did not reach the next model call, queued messages that arrived out of
 * order or in two continuations, a tick that did not advance its record — each exits non-zero
 * instead of printing a happy face.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsats/example-signals-desk start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsats/example-signals-desk start
 */
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsats/core';
import { Memory, createInMemoryStore } from '@balsats/core/memory';
import type { StoredMessage } from '@balsats/core/memory';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  consoleExporter,
  createTracer,
  memoryExporter,
} from '@balsats/core/observability';
import type { ExportedSpan } from '@balsats/core/observability';
import { createInMemoryScheduleStore } from '@balsats/core/schedules';
import { createTool } from '@balsats/core/tools';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** The one conversation this session is about, and its owner (the resource every message is stamped with). */
const THREAD = { id: 'order-4471', title: 'Order 4471 — Lisbon delivery' };
const RESOURCE = 'shop-7';
/** The per-call identity every signal method takes: the thread plus its resource. */
const TARGET = { thread: THREAD, resource: RESOURCE };

// ── The desk and its supervisor ────────────────────────────────────────────────────────────────

/** One page to the supervisor, held until the script answers it. */
interface SupervisorPage {
  /** What the desk asked. */
  readonly question: string;
  /** Answers the page: the tool returns and the run's next step proceeds. */
  readonly reply: (answer: string) => void;
}

/**
 * The script plays the supervisor. `next()` holds the next page for the act to inspect — the desk's
 * run parks on it, and that parked window is the act's "active run": a fact the script controls,
 * not a race against a fast model. In a real deployment the same window is a downstream call's
 * latency. A page nobody is holding is answered by the standing reply, so a model that pages at an
 * unexpected moment never wedges the script.
 */
function supervisorDesk() {
  const holders: Array<(page: SupervisorPage) => void> = [];
  let standing = 'Standard policy applies — go ahead.';
  const pageSupervisor = createTool({
    description:
      "Pages the shop's supervisor with an open question and waits for their answer. The " +
      'supervisor can take a while — the desk holds the line until they reply.',
    inputSchema: z.object({ question: z.string() }),
    execute: ({ question }) =>
      new Promise<{ answer: string }>((resolve) => {
        const page: SupervisorPage = { question, reply: (answer) => resolve({ answer }) };
        const holder = holders.shift();
        if (holder === undefined) page.reply(standing);
        else holder(page);
      }),
  });
  return {
    pageSupervisor,
    /** Holds the next page for the script — the run stays parked until `reply` is called. */
    next: () => new Promise<SupervisorPage>((resolve) => holders.push(resolve)),
    /** The reply for pages no act holds. */
    setStanding: (answer: string) => {
      standing = answer;
    },
  };
}

// ── The composition root wires the pieces ──────────────────────────────────────────────────────

// The memory exporter is the observability kernel's assertion surface: the acts below read the
// step spans' prompts (a step span's `input` is the model call's exact prompt) and the `signal`
// isEvent spans out of it.
const exporter = memoryExporter({ capacity: 5_000 });
const tracer = createTracer({ exporters: [consoleExporter(), exporter] });
const memoryStore = createInMemoryStore();
const scheduleStore = createInMemoryScheduleStore();

// The composition root distributes what is cross-cutting (ADR-0002): the tracer to the agent and
// the signals facade, and the storage slots to the subsystems that persist through them. Two slots
// are pinned here so the script can read them back — the rest fall back to the core's defaults.
const app = createApp({ tracer, storage: { memory: memoryStore, schedules: scheduleStore } });

const desk = supervisorDesk();
const agent = app.agent({
  name: 'desk',
  instructions:
    'You are the support desk for a small shop, working one customer conversation. Keep every ' +
    'reply to one or two short sentences. When a customer asks you to check with a supervisor — or ' +
    'says they are sending more details — call pageSupervisor with the open question and wait for ' +
    'the answer before replying. Answer everything else yourself.',
  // Chat Completions is the lowest common denominator: it works against OpenAI and any
  // OpenAI-compatible endpoint (Ollama, LM Studio, gateways).
  model: openai.chat('gpt-4o-mini'),
  tools: { pageSupervisor: desk.pageSupervisor },
});

// Both facades come off the app: `app.signals` receives the shared `Memory` (the same instance the
// agent carries) and the tracer, `app.schedules` the schedule store slot plus the agents and
// signals a trigger may name.
const signals = app.signals({ agent });
const schedules = app.schedules({ agents: { desk: agent }, signals });

/** The script's read handle on history: a `Memory` over the same store the app distributed. */
const memory = new Memory({ storage: memoryStore });

// ── Script helpers ─────────────────────────────────────────────────────────────────────────────

/** A narration header between acts of the scripted session. */
function act(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

/** The example's assertion: a payoff the script does not see exits non-zero. */
function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** JSON with a hard cap, for one-line printouts. */
function clip(value: unknown, max = 76): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Bounds a model-dependent wait: an example that hangs teaches nothing. */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the model did not ${what} within ${ms} ms — re-run the example`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The text of one model message: string content, or its parts rendered. */
function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const content: unknown = (value as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return '';
      const record = part as Record<string, unknown>;
      if (record['type'] === 'text') return String(record['text'] ?? '');
      if (record['type'] === 'tool-call') return `→ ${String(record['toolName'])}()`;
      if (record['type'] === 'tool-result') return `← ${String(record['toolName'])}`;
      return `[${String(record['type'])}]`;
    })
    .join(' ');
}

/** The model messages a step span was exported with — a step span's `input` is its exact prompt. */
function promptOf(span: ExportedSpan | undefined): readonly unknown[] {
  return span !== undefined && Array.isArray(span.input) ? span.input : [];
}

/** The `agent-run` spans exported since the last `exporter.clear()` — one per run of the thread. */
function runSpans(): readonly ExportedSpan[] {
  return exporter.spans().filter((span) => span.type === AGENT_RUN_SPAN);
}

/** The `agent-step` spans exported since the last `exporter.clear()` — one per model call. */
function stepSpans(): readonly ExportedSpan[] {
  return exporter.spans().filter((span) => span.type === AGENT_STEP_SPAN);
}

/** Prints the thread's message history top to bottom. */
async function printHistory(label: string): Promise<void> {
  const history = await memory.recall({ threadId: THREAD.id });
  console.log(`\n${label} (${history.length} messages):`);
  for (const message of history) {
    console.log(`  ${message.role.padEnd(9)} ${textOf(message).slice(0, 86)}`);
  }
}

// ── The scripted session ───────────────────────────────────────────────────────────────────────

/**
 * The thread's chunk traffic, consumed as it flows. `subscribeToThread` has no replay, so it is
 * attached here — before the first run exists — and it is the stream a UI would forward: every
 * chunk of every run on the thread, as it happens.
 */
const traffic = { chunks: 0, textDeltas: 0, toolResults: 0, finishes: 0 };
void (async () => {
  for await (const chunk of signals.subscribeToThread(TARGET)) {
    traffic.chunks += 1;
    if (chunk.type === 'text-delta') traffic.textDeltas += 1;
    if (chunk.type === 'tool-result') traffic.toolResults += 1;
    if (chunk.type === 'finish') traffic.finishes += 1;
  }
})();

/** The `agent-run` spans of runs that have *ended* since the last `exporter.clear()`. */
function endedRuns(): readonly ExportedSpan[] {
  return runSpans().filter((span) => span.endTime !== undefined);
}

/** The terminal text a run's span reported — the loop writes the run's output onto it. */
function reportedText(span: ExportedSpan | undefined): string {
  return span !== undefined && typeof span.output === 'string' ? span.output.trim() : '';
}

/**
 * Waits until `count` runs have ended on the thread since the last `exporter.clear()`.
 *
 * A *woken* run hands out no output object to await, so the script watches runs the way a
 * deployment can: a run's `agent-run` span ends when the run does, carrying its terminal text as
 * `output`. The thread itself is released a few microtasks after that, so one macrotask turn lets
 * those drain — every act starts on a free thread.
 */
async function waitForRuns(count: number, what: string): Promise<void> {
  await within(
    30_000,
    what,
    (async () => {
      while (endedRuns().length < count) await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The next 09:00 UTC strictly after `from` — a cron-shaped rule the script injects. */
function nextDailyAt(hourUtc: number): (from: Date) => Date {
  return (from) => {
    const next = new Date(from);
    next.setUTCHours(hourUtc, 0, 0, 0);
    if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  };
}

async function main(): Promise<void> {
  console.log('signals-desk — one support thread that messages and signals both land in.');
  console.log(`Thread '${THREAD.id}' (resource '${RESOURCE}') does not exist yet.`);

  act('Act 1 — 空闲唤醒:sendMessage 打向空闲 thread,自己开一个新 run');
  // The subscription is already attached (above, before any run existed) — with no replay, that is
  // the only way to see the very first run. `sendMessage` resolves once the message is delivered;
  // the run it woke is watched through the subscription's chunks and the run's own span.
  desk.setStanding('It is in transit — the carrier says Thursday.');
  const chunksBefore1 = traffic.chunks;
  await signals.sendMessage(TARGET, 'Hi! Where is order 4471? It was meant to arrive last week.');
  await waitForRuns(1, 'answer the first message');
  const reply1 = reportedText(endedRuns().at(0));
  if (endedRuns().length !== 1) {
    fail(`Expected the wake to start exactly one run, got ${endedRuns().length}.`);
  }
  if (traffic.chunks <= chunksBefore1) fail('The subscription saw none of the woken run\'s chunks.');
  if (reply1 === '') fail('The woken run produced no text.');
  console.log(
    `  subscription ${traffic.chunks - chunksBefore1} chunks forwarded while it ran ` +
      `(${traffic.textDeltas} text-deltas, ${traffic.toolResults} tool-results)`,
  );
  console.log(`\n[woken run → ${THREAD.id}] ${reply1}`);

  act('Act 2 — 活跃窗口:sendMessage 注入当前 run,下一 step 生效');
  exporter.clear();
  const page2 = desk.next(); // hold the supervisor page: the desk's run parks on it
  const run2 = signals.stream(
    'Please hold the line and check with your supervisor: can order 4471 still be re-routed?',
    { memory: TARGET },
  );
  const answer2 = run2.text; // reading a terminal value is what starts the run
  const held2 = await within(30_000, 'page the supervisor', page2);
  console.log(`  parked on    pageSupervisor(${clip(held2.question)})  ← the run is live and waiting`);

  // 活跃 = 注入当前 run: no new run starts, the message lands at the loop's next step boundary and
  // in message history as an ordinary message.
  await signals.sendMessage(
    TARGET,
    'Sending a detail while you check: please have it left with the concierge.',
  );
  held2.reply('Re-routing is still possible — the carrier can take a new instruction.');
  const reply2 = await answer2; // the handle-driven run reports on its own object
  await waitForRuns(1, 'finish the injected run'); // ...and its span is what frees the thread

  const steps2 = await run2.steps;
  if (steps2.length < 2) {
    fail(`Expected a second model call after the injection, but the run made ${steps2.length}.`);
  }
  // The injection lands at the next step boundary: one of this run's prompts ends with it.
  const promptTails = stepSpans().map((span) => textOf(promptOf(span).at(-1)));
  const injectedIndex = promptTails.findIndex((tail) => tail.includes('concierge'));
  if (injectedIndex < 0) {
    fail('The injected message never reached a model call — no prompt of the run ends with it.');
  }
  const injected = promptTails[injectedIndex] ?? '';
  // The injection hangs one `isEvent` span off the live run (no new span type, no loop change).
  const signalSpans = exporter
    .spans()
    .filter((span) => span.isEvent === true && span.type === 'signal');
  if (signalSpans.length === 0) {
    fail('Expected the injection to hang an `isEvent` signal span off the active run.');
  }
  if (!runSpans().some((run) => run.traceId === signalSpans[0]?.traceId)) {
    fail("The injection's signal span is not in the active run's trace.");
  }
  console.log(`  injected     "${injected}"  ← call ${injectedIndex + 1} of the run ends with it`);
  console.log(`  signal span  isEvent type='signal' trace=${signalSpans[0]?.traceId}  ← hung off the run`);
  console.log(`\n[run → ${THREAD.id}] ${reply2.trim()}`);
  await printHistory('History after the injection');

  act('Act 3 — 排队保序:queueMessage 等当前 run 完,两条按到达序作一个续跑 run 的输入');
  exporter.clear();
  const page3 = desk.next();
  const run3 = signals.stream('One more check with your supervisor: is the parcel still in Lisbon?', {
    memory: TARGET,
  });
  const answer3 = run3.text;
  const held3 = await within(30_000, 'page the supervisor', page3);
  console.log(`  parked on    pageSupervisor(${clip(held3.question)})`);

  const QUEUED_FIRST = 'First queued ask: please gift-wrap the parcel.';
  const QUEUED_SECOND = 'Second queued ask: and include a birthday card.';
  await signals.queueMessage(TARGET, QUEUED_FIRST);
  await signals.queueMessage(TARGET, QUEUED_SECOND);
  held3.reply('Yes — still in Lisbon.');
  await answer3;
  // Two runs end in this act: the held one, then the continuation the queue starts as it settles.
  await waitForRuns(2, 'answer both queued messages');
  const ended3 = endedRuns();
  const heldTurn = reportedText(ended3.at(0));
  const continuationTurn = reportedText(ended3.at(1));

  // Two queued messages became one continuation run — not two wakes (a wake per message would lose
  // the order they arrived in).
  if (runSpans().length !== 2) {
    fail(
      `Expected the held run plus one continuation (2 runs), got ${runSpans().length} — the queue ` +
        'did not fold into a single continuation.',
    );
  }
  const carried = stepSpans().some((span) => {
    const tail = promptOf(span).slice(-2).map((message) => textOf(message));
    return tail[0] === QUEUED_FIRST && tail[1] === QUEUED_SECOND;
  });
  if (!carried) {
    fail('No model call carried both queued messages, in arrival order, as its prompt tail.');
  }
  const history3 = await memory.recall({ threadId: THREAD.id });
  const firstIndex = history3.findIndex((message: StoredMessage) => textOf(message) === QUEUED_FIRST);
  const secondIndex = history3.findIndex((message: StoredMessage) => textOf(message) === QUEUED_SECOND);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex > secondIndex) {
    fail("The queued messages are not in history, in arrival order.");
  }
  console.log(`  held reply   ${heldTurn}`);
  console.log(`  continuation ${continuationTurn}  ← one run, both queued messages in order`);
  await printHistory('History after the queue');

  act('Act 4 — 系统信号:sendSignal 的 payload 渲染为一条 [signal] 消息,唤醒 thread');
  exporter.clear();
  await signals.sendSignal(TARGET, {
    type: 'order-shipped',
    orderId: THREAD.id,
    carrier: 'DHL',
    eta: 'Thursday',
  });
  await waitForRuns(1, 'answer the shipping signal');
  const reply4 = reportedText(endedRuns().at(0));
  const rendered = textOf(promptOf(stepSpans().at(0)).at(-1));
  if (!rendered.startsWith('[signal] {"type":"order-shipped"')) {
    fail(`Expected the woken run's prompt to end with the rendered signal, got "${rendered}".`);
  }
  if (runSpans().length !== 1) fail(`Expected one woken run, got ${runSpans().length}.`);
  console.log(`  rendered     ${rendered}`);
  console.log(`\n[run → ${THREAD.id}] ${reply4}`);

  act('Act 5 — schedules:tick 读到期记录、触发 threaded target、推进 nextFireAt');
  exporter.clear();
  // The record carries the occurrence function the script injects — cron parsing never enters the
  // core — plus a threaded target: firing it is a plain `signals.sendSignal` into this thread.
  const record = await schedules.save({
    id: 'morning-sweep',
    next: nextDailyAt(9),
    target: {
      thread: THREAD,
      resource: RESOURCE,
      payload: { type: 'digest', openOrders: 3, note: 'the morning sweep' },
    },
    timezone: 'UTC',
    metadata: { rule: 'daily at 09:00 UTC' },
  });
  if (record.nextFireAt === null) fail('The daily sweep saved without a next occurrence.');
  const DAY_MS = 24 * 60 * 60 * 1000;
  console.log(`  saved        '${record.id}'  nextFireAt=${new Date(record.nextFireAt).toISOString()}  (rule: daily 09:00 UTC)`);

  // A tick before the due instant is a no-op: `listDue` has nothing to hand out.
  await schedules.tick({ now: new Date(record.nextFireAt - 1) });
  if (runSpans().length !== 0) fail('A tick before the due instant fired a target.');
  console.log(`  tick(-1ms)   nothing due — 0 runs`);

  await schedules.tick({ now: new Date(record.nextFireAt) });
  await waitForRuns(1, 'answer the scheduled signal');
  const reply5 = reportedText(endedRuns().at(0));
  const digest = textOf(promptOf(stepSpans().at(0)).at(-1));
  if (!digest.startsWith('[signal] {"type":"digest"')) {
    fail(`Expected the woken run's prompt to end with the rendered signal, got "${digest}".`);
  }
  if (runSpans().length !== 1) fail(`Expected the trigger to wake one run, got ${runSpans().length}.`);
  const advanced = await scheduleStore.get(record.id);
  if (advanced === null || advanced.nextFireAt !== record.nextFireAt + DAY_MS) {
    fail(
      `Expected the fired record to advance one day, got ` +
        `${advanced === null ? 'nothing' : String(advanced.nextFireAt)}.`,
    );
  }
  console.log(`  tick(due)    fired the threaded target → signals.sendSignal → a woken run`);
  console.log(`  advanced     nextFireAt=${new Date(advanced.nextFireAt).toISOString()}  ← +24h`);
  console.log(`\n[run → ${THREAD.id}] ${reply5}`);

  act('The thread at the end');
  await printHistory('memory.recall');
  const threads = await memoryStore.listThreads({ resourceId: RESOURCE });
  console.log(`\nstore.listThreads({ resourceId: '${RESOURCE}' }) → ${threads.length} thread(s):`);
  for (const thread of threads) console.log(`  ${thread.id} — "${thread.title ?? ''}"`);

  console.log(
    '\nDone — messages woke and injected, the queue held its order, a typed signal and a scheduled ' +
      'trigger landed in the same thread. Every path ended in message history; the subscription ' +
      `forwarded ${traffic.chunks} chunks across ${traffic.finishes} run(s).`,
  );
}

await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
