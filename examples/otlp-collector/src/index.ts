/**
 * Balsa otlp-collector example — a traced agent run lands in a local OTLP collector as GenAI
 * semconv spans.
 *
 * One script, no external services: a **local collector** (`node:http`) plays the OTLP backend —
 * Langfuse / LangSmith / any OTel collector speak the same wire — a **scripted model** (defined in
 * this file: no API key, no network) drives a real agent run, and `@balsats/otlp` ships the run's
 * spans over OTLP/JSON.
 *
 * 1. **The run is traced** — `createApp({ tracer })` distributes the tracer to the desk agent;
 *    the run produces the framework's automatic spans: `agent-run` → `agent-step` → `tool-call`.
 * 2. **The collector receives semconv, not Balsa shapes** — the kernel's own span model never
 *    leaves the process: the `@balsats/otlp` exporter rebuilds every span for backends —
 *    `invoke_agent refund-desk`, `chat scripted-mini` (CLIENT kind; `gen_ai.*` request / usage /
 *    response attributes; messages as parts), `execute_tool checkOrder` (arguments / result) —
 *    plus `balsa.span.type` / `balsa.run_id` for Balsa-side correlation.
 * 3. **The failure face** — with the collector unreachable the run still completes: `export()`
 *    never throws. Only an explicit `flush()` surfaces the transport failure, straight from the
 *    official exporter stack.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @balsats/example-otlp-collector start
 *
 * The collector endpoint defaults to this script's local collector; export
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to point the exporter at
 * a real backend instead — the official env surface passes straight through. OTLP/JSON is the
 * default here so the local collector can decode what it receives; setting
 * `OTEL_EXPORTER_OTLP_PROTOCOL=protobuf` switches the wire to protobuf (the collector then reports
 * opaque bytes, the way a real backend accepts them).
 *
 * The script self-asserts (`node:assert/strict`): any violated payoff exits 1.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '@balsats/core';
import { createTracer } from '@balsats/core/observability';
import { createTool } from '@balsats/core/tools';
import type { Model, ModelStreamPart } from '@balsats/core/model';
import { createOtlpExporter } from '@balsats/otlp';
import { z } from 'zod';

// ── The scripted model: two turns — ask for the tool, then answer ────────────────────────────────

interface ScriptedTurn {
  readonly text?: string;
  readonly toolCall?: { readonly name: string; readonly input: unknown };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

const ANSWER = 'Order A-4471 is eligible: the overcharge was refunded.';

/** A minimal scripted `Model` (the vendor contract): streams text and tool calls, no network. */
function scriptedModel(script: readonly ScriptedTurn[]): Model {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'example',
    modelId: 'scripted-mini',
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async () => {
      const answer = script[turn];
      if (answer === undefined) {
        throw new Error(`scripted model exhausted after ${turn} turn(s)`);
      }
      turn += 1;
      const parts: ModelStreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (answer.toolCall !== undefined) {
        const id = `call-${turn}`;
        const input = JSON.stringify(answer.toolCall.input ?? {});
        parts.push({ type: 'tool-input-start', id, toolName: answer.toolCall.name });
        parts.push({ type: 'tool-input-delta', id, delta: input });
        parts.push({ type: 'tool-input-end', id });
        parts.push({ type: 'tool-call', toolCallId: id, toolName: answer.toolCall.name, input });
      }
      if (answer.text !== undefined && answer.text !== '') {
        parts.push({ type: 'text-start', id: 'text-0' });
        parts.push({ type: 'text-delta', id: 'text-0', delta: answer.text });
        parts.push({ type: 'text-end', id: 'text-0' });
      }
      parts.push({
        type: 'finish',
        // The unified reason the kernel maps onto `gen_ai.response.finish_reasons`.
        finishReason: answer.toolCall === undefined
          ? { unified: 'stop', raw: 'stop' }
          : { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: {
            total: answer.usage?.inputTokens ?? 0,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: answer.usage?.outputTokens ?? 0, text: undefined, reasoning: undefined },
        },
      });
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

// ── The local collector: a tiny OTLP/JSON receiver ───────────────────────────────────────────────

interface CollectedSpan {
  readonly name: string;
  readonly kind: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributes: Record<string, unknown>;
}

/** Decodes one OTLP/JSON attribute value envelope. */
function decodeValue(envelope: Record<string, unknown>): unknown {
  if ('stringValue' in envelope) return envelope.stringValue;
  if ('boolValue' in envelope) return envelope.boolValue;
  if ('intValue' in envelope) return Number(envelope.intValue);
  if ('doubleValue' in envelope) return envelope.doubleValue;
  if ('arrayValue' in envelope) {
    const values = (envelope.arrayValue as { values?: Record<string, unknown>[] }).values ?? [];
    return values.map(decodeValue);
  }
  return undefined;
}

function decodeAttributes(
  pairs: { key: string; value: Record<string, unknown> }[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries((pairs ?? []).map(({ key, value }) => [key, decodeValue(value)]));
}

/** Flattens an exported ExportTraceServiceRequest into the spans a backend would ingest. */
function decodeBatch(body: string): CollectedSpan[] {
  const document = JSON.parse(body) as {
    resourceSpans?: { scopeSpans?: { spans?: Record<string, unknown>[] }[] }[];
  };
  const spans: CollectedSpan[] = [];
  for (const resourceSpans of document.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        spans.push({
          name: String(span.name),
          kind: Number(span.kind),
          traceId: String(span.traceId),
          spanId: String(span.spanId),
          parentSpanId:
            span.parentSpanId === undefined || span.parentSpanId === '' ? undefined : String(span.parentSpanId),
          attributes: decodeAttributes(span.attributes as { key: string; value: Record<string, unknown> }[]),
        });
      }
    }
  }
  return spans;
}

interface Collector {
  readonly endpoint: string;
  readonly url: string;
  readonly spans: CollectedSpan[];
  /** Accepted requests that were not decodable OTLP/JSON (e.g. protobuf bodies). */
  readonly opaqueBatches: number;
  close(): Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const spans: CollectedSpan[] = [];
  let opaqueBatches = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType.includes('json')) {
        spans.push(...decodeBatch(body.toString('utf8')));
      } else {
        opaqueBatches += 1;
      }
      // The official exporter reads 200 as success.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    endpoint,
    url: `${endpoint}/v1/traces`,
    spans,
    get opaqueBatches() {
      return opaqueBatches;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// ── The desk: one traced agent run ───────────────────────────────────────────────────────────────

/** The tool the first model turn asks for; the second turn reports its result. */
function checkOrderTool(): ReturnType<typeof createTool> {
  return createTool({
    description: 'Checks whether an order is eligible for a refund.',
    inputSchema: z.object({ orderId: z.string() }),
    execute: ({ orderId }) => ({ orderId, eligible: true, reason: 'duplicate charge' }),
  });
}

async function tracedRun(exporter: ReturnType<typeof createOtlpExporter>): Promise<string> {
  const tracer = createTracer({ exporters: [exporter] });
  const app = createApp({ tracer });
  const agent = app.agent({
    name: 'refund-desk',
    instructions: 'You are the refund desk. Check the order, then answer in one short sentence.',
    model: scriptedModel([
      { toolCall: { name: 'checkOrder', input: { orderId: 'A-4471' } }, usage: { inputTokens: 11, outputTokens: 4 } },
      { text: ANSWER, usage: { inputTokens: 23, outputTokens: 9 } },
    ]),
    tools: { checkOrder: checkOrderTool() },
  });

  const run = agent.stream('Customer asks: is order A-4471 eligible for a refund?');
  for await (const _chunk of run) {
    // Drain the run's own stream; the terminal values below are what this script waits on.
  }
  const text = await run.text;
  await tracer.flush();
  return text;
}

/** One human-readable line per span, the way a backend's trace view starts. */
function printSpans(spans: readonly CollectedSpan[]): void {
  for (const span of spans) {
    const parent = span.parentSpanId === undefined ? 'root' : span.parentSpanId.slice(0, 8);
    console.log(`  ${span.name.padEnd(28)} kind=${span.kind}  trace=${span.traceId.slice(0, 8)}  parent=${parent}`);
    const interesting = Object.entries(span.attributes).filter(([key]) =>
      key.startsWith('gen_ai.') || key.startsWith('balsa.'),
    );
    for (const [key, value] of interesting) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      console.log(`      ${key} = ${text.length > 96 ? `${text.slice(0, 96)}…` : text}`);
    }
  }
}

async function main(): Promise<void> {
  const collector = await startCollector();
  try {
    // Endpoint: the local collector unless the official env surface says otherwise; OTLP/JSON
    // unless the protocol env face says protobuf (kept explicit so the collector can decode).
    const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const envProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    const exporter = createOtlpExporter({
      ...(envProtocol === undefined || envProtocol === '' ? { protocol: 'json' } : {}),
      ...(envEndpoint === undefined || envEndpoint === '' ? { url: collector.url } : {}),
    });

    console.log('otlp-collector — a traced agent run lands in a local OTLP collector:');
    console.log(`  collector listening on ${collector.url}`);
    console.log(`  exporter target: ${envEndpoint ?? collector.url} (${envProtocol ?? 'json'})\n`);

    // ── Act 1: the run is traced and the collector receives semconv spans ─────────────────────
    console.log('──────── Act 1 — the agent run, traced and shipped ────────');
    const text = await tracedRun(exporter);
    assert.equal(text, ANSWER, 'the run itself must complete normally');

    const spans = collector.spans;
    const root = spans.find((span) => span.name === 'invoke_agent refund-desk');
    assert.ok(root !== undefined, 'the collector must receive the rebuilt agent-run span');
    const chats = spans.filter((span) => span.name === 'chat scripted-mini');
    assert.equal(chats.length, 2, 'one chat span per model turn (two turns)');
    const tool = spans.find((span) => span.name === 'execute_tool checkOrder');
    assert.ok(tool !== undefined, 'the collector must receive the rebuilt tool-call span');

    console.log('\nWhat a backend would ingest:\n');
    printSpans(spans);
    console.log('');

    // The span tree keeps trace context: run → step → tool, one trace.
    assert.equal(chats[0]!.traceId, root.traceId, 'the whole run shares one trace id');
    assert.equal(chats[0]!.parentSpanId, root.spanId, 'agent-step hangs under agent-run');
    assert.equal(tool.parentSpanId, chats[0]!.spanId, 'tool-call hangs under the step that asked');

    // The contract's payoff attributes — the shape Langfuse / LangSmith / OTel backends read.
    assert.equal(root.attributes['balsa.span.type'], 'agent-run');
    assert.equal(typeof root.attributes['balsa.run_id'], 'string', 'runId rides the root span');

    const firstChat = chats[0]!;
    assert.equal(firstChat.kind, 3, 'agent-step maps to OTLP CLIENT kind');
    assert.equal(firstChat.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(firstChat.attributes['gen_ai.provider.name'], 'example');
    assert.equal(firstChat.attributes['gen_ai.request.model'], 'scripted-mini');
    assert.equal(firstChat.attributes['gen_ai.request.stream'], true, 'the loop always streams');
    assert.deepEqual(firstChat.attributes['gen_ai.response.finish_reasons'], ['tool-calls']);
    assert.equal(firstChat.attributes['gen_ai.usage.input_tokens'], 11);
    assert.equal(firstChat.attributes['gen_ai.response.time_to_first_chunk'] !== undefined, true);

    const secondChat = chats[1]!;
    assert.equal(secondChat.attributes['gen_ai.usage.output_tokens'], 9);
    assert.deepEqual(secondChat.attributes['gen_ai.response.finish_reasons'], ['stop']);
    const output = JSON.parse(secondChat.attributes['gen_ai.output.messages'] as string) as {
      role: string;
      parts: { type: string; content: string }[];
    }[];
    assert.deepEqual(output, [{ role: 'assistant', parts: [{ type: 'text', content: ANSWER }] }]);

    assert.equal(tool.attributes['gen_ai.tool.name'], 'checkOrder');
    assert.deepEqual(tool.attributes['gen_ai.tool.call.arguments'], '{"orderId":"A-4471"}');
    assert.equal(
      tool.attributes['gen_ai.tool.call.result'],
      '{"orderId":"A-4471","eligible":true,"reason":"duplicate charge"}',
    );
    console.log('  ✓ span tree, kinds, and gen_ai.* / balsa.* attributes all asserted');

    // ── Act 2: the failure face — a dead collector never breaks the run ────────────────────────
    console.log('\n──────── Act 2 — the collector is unreachable; the run still completes ────────');
    const before = collector.spans.length;
    const deadExporter = createOtlpExporter({
      protocol: 'json',
      url: 'http://127.0.0.1:1/v1/traces', // nothing listens on port 1
      timeoutMillis: 50,
    });
    const deadTracer = createTracer({ exporters: [deadExporter] });
    const deadApp = createApp({ tracer: deadTracer });
    const deadAgent = deadApp.agent({
      name: 'refund-desk',
      instructions: 'You are the refund desk. Answer in one short sentence.',
      model: scriptedModel([{ text: ANSWER, usage: { inputTokens: 7, outputTokens: 9 } }]),
    });
    const deadRun = deadAgent.stream('Customer asks again about order A-4471.');
    for await (const _chunk of deadRun) {
      // Drain.
    }
    assert.equal(await deadRun.text, ANSWER, 'telemetry failures never break the traced run');
    // `export()` above only enqueued (silent by contract); the explicit flush is where the
    // official transport failure surfaces — passed through as-is.
    await assert.rejects(deadTracer.flush(), 'an explicit flush surfaces the transport failure');
    assert.equal(collector.spans.length, before, 'nothing new arrived at the collector');

    console.log('  ✓ run completed despite a dead collector; export() stayed silent; flush() rejected (official passthrough)');
    console.log('\notlp-collector — done: semconv spans delivered, failure face asserted.');
  } finally {
    await collector.close();
  }
}

await main();
