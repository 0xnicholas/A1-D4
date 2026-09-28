/**
 * Balsa minimal example — a five-field agent, one text generation.
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

const result = await agent.generate('Why is the sky blue?');

console.log(result.text);
console.log(`\n[finishReason] ${result.finishReason}`);
console.log(
  `[usage] input=${result.usage.inputTokens ?? '-'} output=${result.usage.outputTokens ?? '-'} total=${result.usage.totalTokens ?? '-'}`,
);
