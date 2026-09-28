/**
 * Balsa minimal example — a five-field agent, streamed to the terminal.
 *
 * The model instance comes straight from an AI SDK provider package; it satisfies the core's
 * model contract structurally, no adapter or registration (ADR-0004).
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsa/example-minimal-agent start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsa/example-minimal-agent start
 */
import { openai } from '@ai-sdk/openai';
import { Agent } from '@balsa/core/agent';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

const agent = new Agent({
  name: 'assistant',
  instructions: 'You are concise. Answer in one short sentence.',
  // Chat Completions is the lowest common denominator: it works against OpenAI and any
  // OpenAI-compatible endpoint (Ollama, LM Studio, gateways). Use `openai('gpt-4o-mini')`
  // for OpenAI's Responses API.
  model: openai.chat('gpt-4o-mini'),
});

// One run, two consumption styles on the same object: `for await` yields the core's own chunk
// protocol (text-delta / tool-call / tool-result / finish), while the terminal values are
// awaitable promise getters. `generate()` is this same run collapsed to its terminal values
// (single code path), e.g. `const { text, usage } = await agent.generate('…')`.
const result = agent.stream('Why is the sky blue?');

for await (const chunk of result) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
}

const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);

console.log(`\n\n[finishReason] ${finishReason}`);
console.log(
  `[usage] input=${usage.inputTokens ?? '-'} output=${usage.outputTokens ?? '-'} total=${usage.totalTokens ?? '-'}`,
);
