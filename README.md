# Balsa

Ultralight TypeScript agent framework. Compose only what you use — run anywhere, no runtime baggage.

> **Balsa** is the umbrella brand; this repository — **balsa-framework** — is its framework
> subproject. Packages publish under the `@balsa/*` scope (starting with `@balsa/core`), and future
> subprojects live alongside it.

> **Status:** pre-1.0. Agents, memory, workflows and the harness trio — durable agents, signals,
> schedules — are complete ([roadmap](docs/ROADMAP.md)). The first public npm release (0.1.0) has not
> been published yet — until then, run Balsa from this repo (see
> [Development](#development)).

## Why Balsa

Balsa's differentiating axis is **lightweight**, in two precise senses:

- **Compose only what you use.** Every subsystem ships behind its own subpath export
  (`@balsa/core/agent`, `/tools`, `/memory`, `/workflows`, …). What you don't import costs you
  nothing — not in the dependency tree (the core has zero runtime dependencies), not in concept
  space.
- **No runtime burden.** No database, queue, or long-running process is required. Storage ports
  default to in-memory implementations, and Balsa embeds in your application instead of taking it
  over.

A small mental surface runs through everything: an agent is a handful of fields, a tool is four,
there is exactly one cross-cutting extension point (processors), and model instances come straight
from the AI SDK provider ecosystem — no adapters, no registries.

## Requirements

- Node.js ≥ 22.12
- An AI SDK provider package for your model (e.g. `@ai-sdk/openai`)

## Install

```bash
npm install @balsa/core zod @ai-sdk/openai
```

(The package is not on npm yet — see Status above.)

## Quick start

```ts
import { openai } from '@ai-sdk/openai';
import { Agent } from '@balsa/core/agent';
import { createTool } from '@balsa/core/tools';
import { z } from 'zod';

// A tool is a four-field plain object — description, optional inputSchema / outputSchema,
// execute — and its name is its key in the tools container. Schemas are Standard Schema
// dual interfaces (zod@4 speaks them): the framework validates the model's arguments with
// them and sends the JSON Schema to the provider.
const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, celsius: 18 }),
});

// The agent surface: name, instructions, model, tools (plus optional memory / processors).
// The model instance comes straight from an AI SDK provider package.
const agent = new Agent({
  name: 'assistant',
  instructions: 'You are concise. Use the weather tool for weather questions.',
  model: openai.chat('gpt-4o-mini'),
  tools: { weather },
});

// One run, two consumption styles on the same object: `for await` streams Balsa's own chunk
// protocol; the terminal values (text, usage, steps, finishReason) are awaited on it.
const result = agent.stream('What is the weather in Paris right now?');

for await (const chunk of result) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
}

console.log(await result.finishReason, await result.usage);
```

`agent.generate(input)` is the same run collapsed to its terminal values — literally `stream()` +
await, one code path, so the two always agree. When the model answers with a tool call, the
built-in loop executes the tool and feeds the result back to the model, up to `maxSteps`
(default 5); tool failures come back as `isError` results the model can recover from.

Every configuration field is a **dynamic argument**: it accepts either a value `T` or a function
`(ctx: RequestContext) => T | Promise<T>`, resolved per execution against the request context
(`signal`, `runId`, plus your own per-call properties).

## The subsystems

### Agents

`Agent` wraps a model, instructions, and tools into something you can `generate()` / `stream()`.
Cross-cutting concerns — guardrails, redaction, rate limiting, evals — live in exactly one place:
**processors**, three hooks (`processInput` / `processOutputStep` / `processError`) run in
declaration order. Multi-agent collaboration is **as-tool composition**: wrap one agent into a
tool and hang it on another; delegation is an ordinary tool call, and there is no supervisor
protocol or sub-agent concept in the core.

### Memory

```ts
import { Memory, createInMemoryStore } from '@balsa/core/memory';

const memory = new Memory({ storage: createInMemoryStore() });
const agent = new Agent({ name, instructions, model, memory });

// Thread and resource are named per call — the agent itself carries no conversation state,
// so one agent serves every conversation. A missing thread is created on first save.
await agent.generate('Should I bring a rain jacket?', {
  memory: { thread: 'trip-lisbon', resource: 'user-42' },
});
```

**Message history** (on by default) persists each run's messages per thread and injects the recent
window (`lastMessages`, default 10) into the next prompt; `memory.recall()` is the single query
entry. **Working memory** (opt-in via a schema) is a small structured, resource-scoped record the
model updates through a framework-attached tool and that is injected as a system message — so the
next conversation of that user, in any thread, starts already knowing their profile. Storage goes
through a port with an in-memory default; swapping in a persistent adapter changes nothing above
the port.

### Workflows

```ts
import { createStep, createWorkflow } from '@balsa/core/workflows';

const workflow = createWorkflow({ id: 'expense-approval', inputSchema, outputSchema })
  .foreach(checkItem, { concurrency: 2 })
  .parallel([policyCheck, budgetCheck])
  .branch([
    [(ctx) => ctx.inputData['budget-check'].budget === 'over', routeManager],
    [() => true, routeAuto],
  ])
  .then(draftMemo)      // a step whose execute calls an agent is how agents join a workflow
  .then(approvalGate)   // ctx.suspend() unwinds the run with a JSON snapshot
  .then(finalize)
  .commit();

const run = workflow.createRun({ runId: 'run-1' });
const out = run.start({ inputData: report });
for await (const event of out) { /* run-start / step-start / step-end / run-end */ }
const settled = await out.result; // { status: 'success' | 'failed' | 'suspended', … }

// Later — even in another process, with a persistent snapshot store:
const outcome = await workflow
  .createRun({ runId: 'run-1' })
  .resume({ step: 'approval-gate', resumeData: { approved: true } });
```

The builder compiles to a flat entry list interpreted by a for-loop walker — not a DAG. Every
boundary (start input, step input, resume data) is validated against its Standard Schema.
`suspend` / `resume` rest on JSON snapshots at step boundaries, persisted through a storage port
(in-memory by default).

### Observability

```ts
import { createApp } from '@balsa/core';
import { consoleExporter, createTracer } from '@balsa/core/observability';

// The composition root is an optional thin assembly point: one tracer assembled here is
// handed to every agent built through the app — no per-agent wiring.
const app = createApp({ tracer: createTracer({ exporters: [consoleExporter()] }) });
const agent = app.agent({ name, instructions, model, tools });
```

Balsa has its own minimal span model (not OTel): every agent run, model step, tool call, workflow
run/step, and memory recall/save is traced, with console and memory exporters built in. OTLP
(GenAI semantic conventions) ships as a separate capability package. A standalone
`new Agent({ … })` with no app and no tracer stays fully first-class — zero overhead, no span
objects.

### Signals

`createSignals()` (from `@balsa/core/signals`) is the thread-directed interaction primitive:
inject user input into an active run, wake an idle thread into a new run, or queue in order —
injected content lands in the message history. Single-process semantics; cross-instance
distribution belongs to capability packages.

### Durable agents

```ts
import { createDurableAgent } from '@balsa/core/durable-agent';

// The agent wrapped so a run can stop and wait for a human: a tool call whose name is on the
// approval list does not execute — the run suspends with its loop snapshot written to a port.
const durable = app.durableAgent({ agent, approval: { tools: ['issueRefund'] } });
const out = durable.stream('Please refund order A-4471.');
// out.finishReason === 'suspended' → out.suspendPayload says what was held
await durable.resume(out.runId, { approved: true }); // executes it... or false: the model replans
```

The approval declaration lives on the wrapper, never on the tool — a tool stays four fields and the
core stays permission-free. Snapshots are JSON-only and go through `AgentRunSnapshotStore`
(`load` / `save`, in-memory by default); a resume opens a new `agent-run` span in the same trace, so
one human interaction stays one trace. Crash recovery, multi-replica leases and a resumable stream
are deliberately not core.

### Schedules

```ts
import { createSchedules } from '@balsa/core/schedules';

const schedules = createSchedules({ agents: { desk: agent }, signals });
await schedules.save({ id: 'morning-sweep', next: (from) => nextDailyAt(9, from), target: { … } });
await schedules.tick(); // list what is due → fire it → advance nextFireAt
```

`tick` is the whole runtime: a platform cron hitting an endpoint that calls it is the first-class
shape, and `startTicker` is only an in-process convenience. Records are JSON-only through
`ScheduleStore`; the occurrence function is **injected** (`next(from) → Date | null`), so cron
parsing never enters the core. A trigger is either threadless (`agent.generate`) or threaded (a
`sendSignal` into a conversation — schedules reusing signals).

## Package surface

| Import path | What it gives you |
| --- | --- |
| `@balsa/core` | `createApp` — the optional composition root |
| `@balsa/core/agent` | `Agent`, dynamic arguments, structured output, processors |
| `@balsa/core/model` | the model contract and chunk protocol types |
| `@balsa/core/tools` | `createTool` and the tool types |
| `@balsa/core/memory` | `Memory`, `createInMemoryStore`, the memory storage ports |
| `@balsa/core/workflows` | `createWorkflow`, `createStep`, snapshot store |
| `@balsa/core/observability` | `createTracer`, console / memory exporters, span types |
| `@balsa/core/signals` | `createSignals` — inject / wake / queue on a thread |
| `@balsa/core/durable-agent` | `createDurableAgent`, the approval gate, `AgentRunSnapshotStore` |
| `@balsa/core/schedules` | `createSchedules`, `tick`, `ScheduleStore` |

External-dependency capabilities (MCP server/client, OTLP exporter, SQLite storage adapter,
AI SDK interop) ship as separate `@balsa/<capability>` packages — install only what you use
(see the [roadmap](docs/ROADMAP.md), M5).

## Examples

Runnable, self-asserting examples live in [`examples/`](examples/). From the repo root:

```bash
pnpm install
pnpm build                  # examples consume @balsa/core through its package exports (dist)
OPENAI_API_KEY=sk-... pnpm --filter @balsa/example-minimal-agent start
```

Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
`OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 pnpm --filter … start`

| Example | Shows |
| --- | --- |
| [`minimal-agent`](examples/minimal-agent/) | one agent, one tool, streaming, the composition root, console tracing |
| [`memory-chat`](examples/memory-chat/) | two threads on one resource, message history, `recall()`, working memory |
| [`workflow-approval`](examples/workflow-approval/) | `foreach` / `parallel` / `branch`, an agent step, suspend → snapshot → resume |
| [`durable-approval`](examples/durable-approval/) | the approval gate: a tool call held at the step boundary, `finishReason: 'suspended'`, `resume({ approved })` two ways |
| [`signals-desk`](examples/signals-desk/) | one thread: wake / inject / queue in order, a typed `sendSignal`, `subscribeToThread`, a scheduled `tick` |

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — the project glossary: every domain term, defined once
- [`docs/architecture/`](docs/architecture/README.md) — the architecture specs, one per subsystem
- [`docs/adr/`](docs/adr/) — the decisions behind the specs
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan and the v1.0 gate

## Development

```bash
pnpm install
pnpm verify    # typecheck + build + tests + dist / runtime-deps / byte-budget checks
```

The byte budget is enforced in CI from day one — "lightweight" is a checked property, not a
slogan.

## License

[Apache-2.0](LICENSE)
