# `@balsats/core`

The core package of [Balsa](https://github.com/0xnicholas/balsa-framework) — an ultralight
TypeScript agent framework: model contract, agents, tools, memory, workflows, observability,
signals, durable agents and schedules, each behind its own subpath export. Compose only what you
use: what you don't import costs you nothing, not in the dependency tree and not in concept space.
Model instances come straight from the AI SDK provider ecosystem and tool schemas are Standard
Schema dual interfaces, so the core itself carries no runtime dependencies.

```ts
import { openai } from '@ai-sdk/openai';
import { Agent } from '@balsats/core/agent';
import { createTool } from '@balsats/core/tools';
import { z } from 'zod';

const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, celsius: 18 }),
});

const agent = new Agent({
  name: 'assistant',
  instructions: 'You are concise. Use the weather tool for weather questions.',
  model: openai.chat('gpt-4o-mini'),
  tools: { weather },
});

const result = agent.stream('What is the weather in Paris right now?');

for await (const chunk of result) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
}

console.log(await result.finishReason, await result.usage);
```

- Framework README: [balsa-framework](https://github.com/0xnicholas/balsa-framework#readme) — quick start, examples, capability packages
- Specs: [`docs/architecture/`](https://github.com/0xnicholas/balsa-framework/blob/main/docs/architecture/README.md) — one per subsystem
- Decisions: [`docs/adr/`](https://github.com/0xnicholas/balsa-framework/tree/main/docs/adr) — the decisions behind the specs
- Glossary: [`CONTEXT.md`](https://github.com/0xnicholas/balsa-framework/blob/main/CONTEXT.md) — every domain term, defined once
- Example: [`examples/minimal-agent`](https://github.com/0xnicholas/balsa-framework/tree/main/examples/minimal-agent) — one agent, one tool, streaming, console tracing

## Install

```bash
npm install @balsats/core zod @ai-sdk/openai
```

Requires Node.js **≥ 22.13**. The provider package (any AI SDK provider, any OpenAI-compatible
endpoint behind one) and the schema library (`zod` or any other Standard Schema implementation) are
yours to pick — the core has no runtime dependencies of its own.

## Import map

| Import path | What it gives you |
| --- | --- |
| `@balsats/core` | `createApp` — the optional composition root |
| `@balsats/core/agent` | `Agent`, dynamic arguments, structured output, processors |
| `@balsats/core/model` | the model contract and chunk protocol types |
| `@balsats/core/tools` | `createTool` and the tool types |
| `@balsats/core/memory` | `Memory`, `createInMemoryStore`, the memory storage ports |
| `@balsats/core/workflows` | `createWorkflow`, `createStep`, snapshot store |
| `@balsats/core/observability` | `createTracer`, console / memory exporters, span types |
| `@balsats/core/signals` | `createSignals` — inject / wake / queue on a thread |
| `@balsats/core/durable-agent` | `createDurableAgent`, the approval gate, `AgentRunSnapshotStore` |
| `@balsats/core/schedules` | `createSchedules`, `tick`, `ScheduleStore` |

## The composition root

`createApp` is an optional thin assembly point: one tracer and one set of storage ports handed to
every subsystem built through the app, so there is no per-agent wiring.

```ts
import { createApp } from '@balsats/core';
import { createInMemoryStore } from '@balsats/core/memory';
import { consoleExporter, createTracer } from '@balsats/core/observability';

const app = createApp({
  tracer: createTracer({ exporters: [consoleExporter()] }),
  storage: { memory: createInMemoryStore() }, // one slot per storage port; in-memory by default
});

const agent = app.agent({ name: 'assistant', instructions: '…', model, tools });
```

Subsystems stay fully usable without it — a standalone `new Agent({ … })` with no app and no tracer
is first-class, with zero span overhead. Explicit assembly wins: a config that brings its own
`tracer` / `memory` / `storage` is never taken over.

## Lightweight

- runtime dependencies: none — the zero-dependency redline is a hard CI gate over both the manifest
  and the built output ([ADR-0015](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0015-ci-lightweight-redlines.md))
- first-party code: the minified baseline lives in `byte-budget.json` and is checked on every PR —
  an internal regression reference, not a public budget ([ADR-0001](https://github.com/0xnicholas/balsa-framework/blob/main/docs/adr/0001-lightweight-definition.md))
- the capability packages ship separately, so a deployment installs only what it uses

## License

[Apache-2.0](https://github.com/0xnicholas/balsa-framework/blob/main/LICENSE)
