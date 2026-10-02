/**
 * Balsa minimal example — a five-field agent with one tool, streamed to the terminal.
 *
 * The model instance comes straight from an AI SDK provider package; it satisfies the core's
 * model contract structurally, no adapter or registration (ADR-0004). The agent hangs on the
 * optional composition root, which distributes one tracer to it — no per-agent wiring (ADR-0002).
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsats/example-minimal-agent start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsats/example-minimal-agent start
 */
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsats/core';
import { consoleExporter, createTracer } from '@balsats/core/observability';
import { createTool } from '@balsats/core/tools';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

// A tool is a four-field plain object — description, optional inputSchema / outputSchema,
// execute — and its name is this Record key. The schemas are Standard Schema dual interfaces
// (zod@4 speaks them): the framework validates the model's arguments with them and sends the
// JSON Schema to the provider.
const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ city: z.string(), celsius: z.number() }),
  // A deterministic stand-in so the example runs without any extra service.
  execute: ({ city }) => ({ city, celsius: 18 }),
});

// The composition root is the optional thin assembly point (ADR-0002): one tracer is assembled
// here and handed to every agent built through the app, so nothing is passed per agent. A
// standalone `new Agent({ … })` without the app stays equally first-class. The console exporter
// pretty-prints every span event as it happens — agent run → step → tool call; the memory
// exporter is the test-time counterpart you assert against.
const app = createApp({
  tracer: createTracer({ exporters: [consoleExporter()] }),
});

const agent = app.agent({
  name: 'assistant',
  instructions:
    'You are concise. Answer in one short sentence. Use the weather tool for weather questions.',
  // Chat Completions is the lowest common denominator: it works against OpenAI and any
  // OpenAI-compatible endpoint (Ollama, LM Studio, gateways). Use `openai('gpt-4o-mini')`
  // for OpenAI's Responses API.
  model: openai.chat('gpt-4o-mini'),
  tools: { weather },
});

// One run, two consumption styles on the same object. `for await` yields the core's own chunk
// protocol; the built-in loop turns a `tool-call` into a `tool-result` right after the step's
// `finish` and feeds it back to the model — up to `maxSteps` (default 5). Tool failures (invalid
// input, a throw, invalid output) come back as `isError` results the model can recover from.
const result = agent.stream('What is the weather in Paris right now?');

for await (const chunk of result) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.textDelta);
  } else if (chunk.type === 'tool-call') {
    console.log(`\n[tool-call] ${chunk.toolName}(${JSON.stringify(chunk.input)})`);
  } else if (chunk.type === 'tool-result') {
    const error = chunk.isError ? ' (error)' : '';
    console.log(`[tool-result] ${chunk.toolName} -> ${JSON.stringify(chunk.output)}${error}`);
  }
}

// `generate()` is this same run collapsed to its terminal values (single code path), e.g.
// `const { text, toolCalls, toolResults, steps, usage } = await agent.generate('…')`.
const [finishReason, usage, steps] = await Promise.all([
  result.finishReason,
  result.usage,
  result.steps,
]);

console.log(`\n\n[steps] ${steps.length}`);
console.log(`[finishReason] ${finishReason}`);
console.log(
  `[usage] input=${usage.inputTokens ?? '-'} output=${usage.outputTokens ?? '-'} total=${usage.totalTokens ?? '-'}`,
);
