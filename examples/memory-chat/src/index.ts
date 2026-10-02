/**
 * Balsa memory-chat example — two threads, one resource, and working memory.
 *
 * A scripted, non-interactive run drives one agent over one `Memory` instance and shows the two
 * memory mechanisms of the framework working together:
 *
 * - **Message history** (thread-scoped, on by default): each run names its conversation through
 *   the per-call `memory: { thread, resource }` option, recalls the recent window into the prompt,
 *   and saves every step back into the thread. The same agent serves both conversations because
 *   the thread lives on the call, not on the agent; nothing in this file creates a thread — the
 *   first save of a run creates the thread it names.
 * - **Working memory** (resource-scoped, opt-in through a schema): a small structured record the
 *   model updates through the framework-attached `updateWorkingMemory` tool. It persists across
 *   threads and runs and is injected as a system message, so the next conversation starts already
 *   knowing the user's profile.
 *
 * The acts: two threads alternate turns, `recall()` reads one thread's history back, and the
 * script closes by writing the user's profile to working memory. Watch the console exporter as
 * it runs: each `memory-recall` span hangs under its run's `agent-run` span and each `memory-save`
 * span under an `agent-step` — no extra wiring beyond naming the thread and resource per call.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsats/example-memory-chat start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsats/example-memory-chat start
 */
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsats/core';
import type { AgentGenerateResult } from '@balsats/core/agent';
import { Memory, createInMemoryStore } from '@balsats/core/memory';
import type { MemoryThreadRef, StoredMessage } from '@balsats/core/memory';
import { consoleExporter, createTracer } from '@balsats/core/observability';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** The one resource this session belongs to: one user, two conversations. */
const RESOURCE = 'user-42';

/**
 * The two threads, as per-call references. A reference may be a bare id or — as here — an id plus
 * the `title` / `metadata` a *missing* thread is created with. Both threads stay unknown until a
 * run with that reference saves its first step; no explicit creation call exists anywhere.
 */
const tripThread: MemoryThreadRef = {
  id: 'trip-lisbon',
  title: 'Trip to Lisbon',
  metadata: { topic: 'travel' },
};
const dinnerThread: MemoryThreadRef = {
  id: 'weeknight-dinners',
  title: 'Weeknight dinners',
  metadata: { topic: 'cooking' },
};

/** The id of either reference form. */
function threadId(thread: MemoryThreadRef): string {
  return typeof thread === 'string' ? thread : thread.id;
}

/**
 * Working memory is schema-only: this schema is the whole contract. The merged record is validated
 * against it on every update (a non-conforming patch comes back to the model as an error tool
 * result), and the same schema is handed verbatim to the model as the `updateWorkingMemory` tool
 * input schema — no adapter, no rewriting (ADR-0003).
 */
const userProfile = z.object({
  name: z.string(),
  homeCity: z.string(),
  diet: z.string(),
});

// The core's in-memory store is the default; the example holds onto it only to show the threads
// the runs created. Message history lives in the store — swapping in an adapter changes nothing
// above this line (docs/architecture/storage.md).
const store = createInMemoryStore();

// One Memory instance serves every run below. `lastMessages` defaults to 10; naming a schema
// switches working memory on, which makes each memory-enabled run attach the `updateWorkingMemory`
// tool and inject the resource's current record as a system message.
const memory = new Memory({
  storage: store,
  workingMemory: { schema: userProfile },
});

// The composition root is the optional thin assembly point (ADR-0002): one tracer is assembled
// here and handed to the agent built through the app. Memory needs no separation wiring — both
// memory spans appear on any memory-enabled run of a traced agent (docs/architecture/observability.md).
const app = createApp({
  tracer: createTracer({ exporters: [consoleExporter()] }),
});

const agent = app.agent({
  name: 'concierge',
  instructions:
    'You are a concise concierge. Answer in one or two short sentences. ' +
    'When the user asks you to remember something for later conversations, record it in working memory.',
  // Chat Completions is the lowest common denominator: it works against OpenAI and any
  // OpenAI-compatible endpoint (Ollama, LM Studio, gateways). Use `openai('gpt-4o-mini')`
  // for OpenAI's Responses API.
  model: openai.chat('gpt-4o-mini'),
  memory,
});

/**
 * One scripted turn: the per-call `memory` option is the run's whole identity — thread and
 * resource appear here and nowhere else. The agent carries no thread state, so the same agent
 * serves both conversations; a run without the option would simply do no memory I/O.
 */
async function chat(thread: MemoryThreadRef, message: string): Promise<AgentGenerateResult> {
  console.log(`\n[user → ${threadId(thread)}] ${message}`);
  const result = await agent.generate(message, { memory: { thread, resource: RESOURCE } });
  for (const call of result.toolCalls) {
    console.log(`[tool-call] ${call.toolName}(${JSON.stringify(call.input)})`);
  }
  for (const toolResult of result.toolResults) {
    const error = toolResult.isError ? ' (error)' : '';
    console.log(`[tool-result] ${toolResult.toolName} -> ${JSON.stringify(toolResult.output)}${error}`);
  }
  console.log(`[assistant] ${result.text.trim()}`);
  return result;
}

/** One-line rendering of a stored message for the recall printout below. */
function textOf(message: StoredMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(' ');
}

/** A narration header between acts of the scripted session. */
function act(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

console.log(`memory-chat — resource '${RESOURCE}', one Memory instance, two threads.`);
console.log(`Threads '${threadId(tripThread)}' and '${threadId(dinnerThread)}' do not exist yet.`);

act('Act 1 — two conversations, interleaved');
await chat(tripThread, 'I am planning a trip to Lisbon in May. What should I pack?');
await chat(dinnerThread, 'What should I cook for dinner tonight?');
await chat(tripThread, 'Should I bring a rain jacket?');
await chat(dinnerThread, 'Something quick please — I only have 20 minutes.');

act('Act 2 — recall() reads a thread back');
// recall() is message history's single query entry: the thread's messages in chronological order,
// envelope included, directly feedable to a model. Without a limit the `lastMessages` window
// (default 10) applies; `before` pages towards older history.
const history = await memory.recall({ threadId: threadId(tripThread) });
console.log(`memory.recall({ threadId: '${threadId(tripThread)}' }) → ${history.length} messages:`);
for (const message of history) {
  console.log(`  ${message.role}: ${textOf(message)}`);
}

// Both threads came into being with their first save, carrying the title / metadata the per-call
// reference brought. The store port's listing makes that visible; above the port, nothing in this
// file ever asked for a thread to be created.
const threads = await store.listThreads({ resourceId: RESOURCE });
console.log(`\nstore.listThreads({ resourceId: '${RESOURCE}' }) → ${threads.length} threads, most recently active first:`);
for (const thread of threads) {
  console.log(`  ${thread.id} — "${thread.title ?? ''}" ${JSON.stringify(thread.metadata ?? {})}`);
}

act('Act 3 — working memory is written by tool call');
// The agent decides to call `updateWorkingMemory`; the framework merges the patch into the
// resource's record, validates the result against the schema and persists it. Working memory is
// resource-scoped, so this profile is available to *every* thread from the next run on.
const closingTurn = await chat(
  dinnerThread,
  'Before I forget — please remember this for next time: I am Ada, I live in Lisbon, and I am vegetarian.',
);

// The closer is the example's payoff, so it is asserted rather than assumed: a model that skips
// the tool (or a rejected patch) would otherwise leave `undefined` on screen behind a zero exit.
const profile = await memory.getWorkingMemory(RESOURCE);
if (!closingTurn.toolCalls.some((call) => call.toolName === 'updateWorkingMemory') || profile === undefined) {
  console.error(
    'The closing turn did not write working memory: the model never called updateWorkingMemory. Re-run the example — this act asserts the demo instead of assuming it.',
  );
  process.exit(1);
}

console.log(`\nmemory.getWorkingMemory('${RESOURCE}') →`);
console.log(JSON.stringify(profile, null, 2));

console.log('\nDone — the next run in any thread of this resource starts with that profile injected.');
