/**
 * Balsa ai-chat-route example — one `useChat()`-compatible HTTP route, one durable run, one
 * app-side resume.
 *
 * The script hosts `createChatRoute` on plain `node:http` (any web-standard host works the same
 * way — the route speaks `Request → Response`), then plays the client with raw `fetch`, exactly
 * the bytes `useChat`'s `DefaultChatTransport` sends and parses:
 *
 * 1. **The client chats** — the request's tail user message crosses, history is thread recall
 *    (memory-authoritative; the client's message list is never replayed), and the answer streams
 *    back as a UI message stream: official five headers, `start` without a messageId, body frames,
 *    `finish`, `[DONE]`.
 * 2. **The run suspends in the stream** — the model calls the approval-gated `issueRefund`; the
 *    stream ends `finishReason: 'other'` with `messageMetadata.suspended { runId,
 *    awaitingApproval }`. No `tool-approval-*` frames: the UI renders the held tool part itself.
 * 3. **The application resumes out-of-band** — the pattern this example exists to show: read the
 *    `runId` off the finish frame, call `durable.resume(runId, { approved: true, memory })`, and
 *    answer the client over your own channel. Resuming is app orchestration, not route logic.
 * 4. **The next turn remembers** — a second POST to the same thread recalls the history the first
 *    run wrote, and `toAISdkMessages` renders the stored thread as UI messages.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @balsats/example-ai-chat-route start
 *
 * Any OpenAI-compatible endpoint works too, e.g. a local Ollama:
 *
 *   OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 \
 *     pnpm --filter @balsats/example-ai-chat-route start
 *
 * The script self-asserts (`node:assert/strict`): any violated payoff exits 1.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openai } from '@ai-sdk/openai';
import { createApp } from '@balsats/core';
import { Memory } from '@balsats/core/memory';
import { createTool } from '@balsats/core/tools';
import { toAISdkMessages, createChatRoute } from '@balsats/ai-sdk';
import type { AISdkStreamChunk } from '@balsats/ai-sdk';
import { z } from 'zod';

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL) before running this example.');
  process.exit(1);
}

/** The thread both turns live in — the route's memory identity. */
const THREAD = { thread: 'refund-A-4471', resource: 'customer-4471' };

/** A useChat-shaped request body, the way DefaultChatTransport sends it. */
function chatBody(text: string): string {
  return JSON.stringify({
    id: THREAD.thread,
    messages: [{ id: `u-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }],
    trigger: 'submit-message',
    messageId: `u-${Date.now()}`,
  });
}

/** Decodes an SSE body into its data payloads (`[DONE]` excluded, comments dropped). */
function sseFrames(body: string): AISdkStreamChunk[] {
  return body
    .split('\n\n')
    .filter((event) => event.startsWith('data: '))
    .map((event) => event.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as AISdkStreamChunk);
}

async function main(): Promise<void> {
  // ── The desk: memory + one approval-gated tool, wrapped durable ─────────────────────────────
  const ledger: number[] = [];
  const app = createApp({});
  const memory = new Memory();
  const agent = app.agent({
    name: 'refund-desk',
    instructions:
      'You are the refund desk. When asked for a refund, call issueRefund with the order id and ' +
      'the amount, then report the outcome in one short sentence.',
    model: openai.chat('gpt-4o-mini'),
    memory,
    tools: {
      issueRefund: createTool({
        description:
          'Issue a refund for an order. Money leaves the account and cannot be recalled — this ' +
          'call requires a human approval before it executes.',
        inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
        execute: ({ amount }) => {
          ledger.push(amount);
          return { refunded: true, amount };
        },
      }),
    },
  });
  const durable = app.durableAgent({ agent, approval: { tools: ['issueRefund'] } });

  // ── The route, hosted on plain node:http ────────────────────────────────────────────────────
  const route = createChatRoute({
    agent: durable,
    // Authorization is the application's: identity maps the raw request to thread/resource.
    identity: () => ({ resource: THREAD.resource }),
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const request = new Request(url, {
          method: req.method ?? 'GET',
          headers: req.headers as Record<string, string>,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
          // node:http has no request signal; skip it here (undici/cf workers hosts pass theirs).
        });
        const response = await route(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body === null) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      })().catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'host failure' }));
        console.error(error);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const api = `http://127.0.0.1:${port}/api/chat`;

  try {
    console.log('ai-chat-route — one useChat-compatible route, one durable run, one resume:');
    console.log(`  serving POST ${api}\n`);

    // ── Act 1: the client asks; the run suspends inside the stream ────────────────────────────
    console.log('──────── Act 1 — the chat request suspends in the stream ────────');
    const first = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody(
        'Customer message: "You charged me twice for order A-4471 — please refund the $129 overcharge."',
      ),
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
    assert.equal(first.headers.get('content-type'), 'text/event-stream');
    const firstBody = await first.text();
    assert.ok(firstBody.endsWith('data: [DONE]\n\n'), 'the stream terminates with [DONE]');
    const frames = sseFrames(firstBody);
    assert.equal(frames[0]!.type, 'start', 'the stream opens with a start frame');
    assert.ok(
      frames.some((frame) => frame.type === 'tool-input-available'),
      'the held tool call is visible as a tool-input-available frame',
    );
    const finish = frames.at(-1)!;
    assert.equal(finish.type, 'finish');
    assert.equal(finish.finishReason, 'other', 'suspension maps to finishReason "other"');
    const suspended = finish.messageMetadata?.suspended;
    assert.ok(suspended !== undefined, 'the finish frame carries the suspension metadata');
    assert.ok(suspended.awaitingApproval.length > 0, 'the held call awaits the decision');
    assert.deepEqual(ledger, [], 'nothing executes while the run is suspended');
    console.log(`  finish { finishReason: 'other', suspended: { runId: ${suspended.runId.slice(0, 8)}… } }`);
    console.log('  useChat renders the held tool part; the client is free to answer elsewhere.\n');

    // ── Act 2: the application resumes out-of-band ────────────────────────────────────────────
    console.log('──────── Act 2 — the app resumes the suspended run ────────');
    const outcome = await durable.resume(suspended.runId, { approved: true, memory: THREAD });
    assert.equal(outcome.finishReason, 'stop', 'the resumed run finishes');
    assert.deepEqual(ledger, [129], 'the approved refund executes');
    console.log(`  durable.resume('${suspended.runId.slice(0, 8)}…', { approved: true }) → '${outcome.finishReason}'`);
    console.log(`  desk reply: ${outcome.text.trim()}\n`);

    // ── Act 3: the next turn remembers; the thread reads back as UI messages ──────────────────
    console.log('──────── Act 3 — the next turn recalls the same thread ────────');
    const second = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody('Following up: did my refund for order A-4471 actually go through?'),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.text();
    const secondFrames = sseFrames(secondBody);
    const secondFinish = secondFrames.at(-1)!;
    assert.equal(secondFinish.type, 'finish');
    assert.equal(secondFinish.finishReason, 'stop');
    assert.ok(
      secondFrames.some((frame) => frame.type === 'text-delta'),
      'the answer streams as text',
    );
    const history = await memory.recall({ threadId: THREAD.thread });
    assert.ok(history.length > 0, 'the thread carries the history both runs wrote');
    const uiMessages = toAISdkMessages(history);
    assert.ok(
      uiMessages.some((message) => message.role === 'user'),
      'read-back renders the stored user turns',
    );
    const assistantMessages = uiMessages.filter((message) => message.role === 'assistant');
    assert.ok(assistantMessages.length > 0, 'read-back renders the folded assistant turns');
    const kinds = assistantMessages.flatMap((message) => message.parts.map((part) => part.type));
    assert.ok(kinds.includes('text'), 'the folded turns carry their text parts');
    console.log(`  second turn → finishReason '${secondFinish.finishReason}' (history recalled, not replayed)`);
    console.log(`  toAISdkMessages(memory.recall(…)) → ${uiMessages.length} UI message(s), parts: ${kinds.join(', ')}\n`);

    // ── The negative space, asserted ─────────────────────────────────────────────────────────
    const wrongMethod = await fetch(api, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    const badJson = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    const tailNotUser = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: THREAD.thread,
        messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    });
    assert.equal(tailNotUser.status, 400);
    console.log('──────── Negative space ────────');
    console.log('  GET → 405 (Allow: POST);  invalid JSON → 400;  tail not user → 400');
    console.log('\nAll assertions passed.');
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
