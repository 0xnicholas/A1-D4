/**
 * The seven-type mapping contract (`docs/architecture/observability.md`「映射契约(七类 + 兜底)」):
 * name templates, `gen_ai.operation.name` / kind per type, the agent-step attribute table, the
 * `balsa.*` vocabulary, error mapping, metadata, and the value-domain rules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportedSpan } from '@balsa/core/observability';
import { saveOtelEnv, shipSpans, testSpan } from './helpers.js';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = saveOtelEnv();
});
afterEach(() => {
  restoreEnv();
});

describe('seven-type mapping: names, operations, kinds', () => {
  it('maps agent-run to invoke_agent with the agent semconv attributes', async () => {
    const span = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk', runId: 'run-1' },
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.name).toBe('invoke_agent desk');
    expect(mapped.kind).toBe(1); // OTLP INTERNAL
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'desk',
      'balsa.run_id': 'run-1',
      'balsa.span.type': 'agent-run',
    });
  });

  it('maps agent-step to chat with CLIENT kind and the request attributes', async () => {
    const span = testSpan({
      type: 'agent-step',
      name: 'gpt-5',
      attributes: {
        model: 'gpt-5',
        provider: 'openai',
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
        finishReason: 'stop',
        timeToFirstChunk: 250,
      },
      output: 'hello',
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.name).toBe('chat gpt-5');
    expect(mapped.kind).toBe(3); // OTLP CLIENT
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5',
      'gen_ai.request.stream': true,
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.time_to_first_chunk': 0.25,
      'balsa.span.type': 'agent-step',
    });
    // `total` has no semconv key — no repeated counting across backends.
    expect(Object.keys(mapped.attributes)).not.toContain('gen_ai.usage.total_tokens');
  });

  it('passes agent-step parameters through the whitelist and the rest under balsa.request.*', async () => {
    const span = testSpan({
      type: 'agent-step',
      name: 'gpt-5',
      attributes: {
        model: 'gpt-5',
        provider: 'openai',
        parameters: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 1024,
          stopSequences: ['END'],
          customKnob: 'x',
        },
      },
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.attributes).toMatchObject({
      'gen_ai.request.temperature': 0.7,
      'gen_ai.request.top_p': 0.9,
      'gen_ai.request.max_tokens': 1024,
      'gen_ai.request.stop_sequences': ['END'],
      'balsa.request.customKnob': 'x',
    });
  });

  it('maps tool-call to execute_tool, result only on success', async () => {
    const spanned = testSpan({
      type: 'tool-call',
      name: 'refund',
      attributes: { toolCallId: 'call-1' },
      input: { orderId: 'o-1' },
      output: { refunded: true },
    });
    const [mapped] = await shipSpans(spanned);
    expect(mapped.name).toBe('execute_tool refund');
    expect(mapped.kind).toBe(1);
    expect(mapped.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'refund',
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.call.arguments': '{"orderId":"o-1"}',
      'gen_ai.tool.call.result': '{"refunded":true}',
      'balsa.span.type': 'tool-call',
    });

    const failed = testSpan({
      type: 'tool-call',
      name: 'refund',
      attributes: { toolCallId: 'call-2' },
      input: { orderId: 'o-2' },
      output: { refunded: true },
      error: { message: 'gateway down', details: Object.assign(new Error('gateway down'), { name: 'TimeoutError' }) },
    });
    const [failedMapped] = await shipSpans(failed);
    expect(failedMapped.attributes).toMatchObject({
      'gen_ai.tool.call.arguments': '{"orderId":"o-2"}',
      'error.type': 'TimeoutError',
    });
    expect(failedMapped.attributes).not.toHaveProperty('gen_ai.tool.call.result');
    expect(failedMapped.status).toMatchObject({ code: 2, message: 'gateway down' });
  });

  it('maps workflow-run and workflow-step', async () => {
    const run = testSpan({
      type: 'workflow-run',
      name: 'refund-flow',
      attributes: { workflowId: 'refund-flow', runId: 'run-9' },
      input: { orderId: 'o-1' },
      output: 'refunded',
    });
    const step = testSpan({
      type: 'workflow-step',
      name: 'validate',
      attributes: {},
      input: { orderId: 'o-1' },
      output: true,
    });
    const spans = await shipSpans(run, step);
    const mappedRun = spans[0]!;
    const mappedStep = spans[1]!;

    expect(mappedRun.name).toBe('invoke_workflow refund-flow');
    expect(mappedRun.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': 'refund-flow',
      'balsa.run_id': 'run-9',
      'balsa.input': '{"orderId":"o-1"}',
      'balsa.output': '"refunded"',
      'balsa.span.type': 'workflow-run',
    });

    expect(mappedStep.name).toBe('workflow-step validate');
    expect(mappedStep.attributes).toMatchObject({
      'balsa.input': '{"orderId":"o-1"}',
      'balsa.output': 'true',
      'balsa.span.type': 'workflow-step',
    });
    expect(mappedStep.attributes).not.toHaveProperty('gen_ai.operation.name');
  });

  it('maps memory-recall and memory-save without inventing operations', async () => {
    const recall = testSpan({
      type: 'memory-recall',
      name: 'thread-1',
      attributes: { threadId: 'thread-1' },
      input: { query: 'last messages' },
      output: [],
    });
    const save = testSpan({
      type: 'memory-save',
      name: 'thread-1',
      attributes: { threadId: 'thread-1', resourceId: 'user-7' },
      input: [{ role: 'user', content: 'hi' }],
      output: [{ id: 'm-1' }],
    });
    const spans = await shipSpans(recall, save);
    const mappedRecall = spans[0]!;
    const mappedSave = spans[1]!;

    expect(mappedRecall.name).toBe('memory-recall thread-1');
    expect(mappedRecall.attributes).toMatchObject({
      'balsa.thread_id': 'thread-1',
      'balsa.input': '{"query":"last messages"}',
      'balsa.output': '[]',
    });
    expect(mappedRecall.attributes).not.toHaveProperty('gen_ai.operation.name');

    expect(mappedSave.name).toBe('memory-save thread-1');
    expect(mappedSave.attributes).toMatchObject({
      'balsa.thread_id': 'thread-1',
      'balsa.resource_id': 'user-7',
    });
  });

  it('passes open types through untouched, marked only by balsa.span.type', async () => {
    const span = testSpan({
      type: 'signal',
      name: 'approval-signal',
      attributes: { kind: 'approval' },
      input: { verdict: 'approved' },
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.name).toBe('approval-signal');
    expect(mapped.kind).toBe(1);
    expect(mapped.attributes).toMatchObject({
      kind: 'approval',
      'balsa.input': '{"verdict":"approved"}',
      'balsa.span.type': 'signal',
    });
    expect(mapped.attributes).not.toHaveProperty('gen_ai.operation.name');
  });
});

describe('error, metadata, and the value domain', () => {
  it('maps details.name to error.type, falls back to _OTHER, and omits an empty details JSON', async () => {
    const named = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      error: { message: 'boom', details: { name: 'RateLimitError', retryAfter: 3 } },
    });
    const plain = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      error: { message: 'boom', details: new Error('boom') },
    });
    const nameless = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      error: { message: 'boom', details: { code: 500 } },
    });
    const bare = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      error: { message: 'boom' },
    });
    const spans = await shipSpans(named, plain, nameless, bare);
    const mappedNamed = spans[0]!;
    const mappedPlain = spans[1]!;
    const mappedNameless = spans[2]!;
    const mappedBare = spans[3]!;

    expect(mappedNamed.status).toMatchObject({ code: 2, message: 'boom' });
    expect(mappedNamed.attributes['error.type']).toBe('RateLimitError');
    expect(mappedNamed.attributes['balsa.error.details']).toBe('{"name":"RateLimitError","retryAfter":3}');

    // A plain Error's name is the string 'Error' — taken as-is; only a missing name falls back.
    expect(mappedPlain.attributes['error.type']).toBe('Error');
    // An Error's own properties do not enumerate — `{}` would be worse than nothing.
    expect(mappedPlain.attributes).not.toHaveProperty('balsa.error.details');

    expect(mappedNameless.attributes['error.type']).toBe('_OTHER');
    expect(mappedBare.attributes['error.type']).toBe('_OTHER');
  });

  it('ships the metadata bag as one balsa.metadata JSON attribute (empty omitted)', async () => {
    const withMetadata = testSpan({ metadata: { tenant: 'acme', attempt: 2 } });
    const withEmpty = testSpan({ metadata: {} });
    const spans = await shipSpans(withMetadata, withEmpty);
    const mapped = spans[0]!;
    const mappedEmpty = spans[1]!;

    expect(mapped.attributes['balsa.metadata']).toBe('{"tenant":"acme","attempt":2}');
    expect(mappedEmpty.attributes).not.toHaveProperty('balsa.metadata');
  });

  it('applies the value-domain rules to unmapped attribute keys', async () => {
    const span = testSpan({
      attributes: {
        plain: 'text',
        count: 3,
        flag: true,
        object: { nested: [1, 2] },
        holes: [1, null, undefined, 2],
        mixed: [1, { a: 2 }],
        dropped: undefined,
      },
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.attributes).toMatchObject({
      plain: 'text',
      count: 3,
      flag: true,
      object: '{"nested":[1,2]}',
      holes: [1, 2],
      // A non-primitive member makes the whole array "any other value" → JSON text.
      mixed: '[1,{"a":2}]',
    });
    expect(mapped.attributes).not.toHaveProperty('dropped');
    expect(mapped.droppedAttributesCount).toBe(0);
  });

  it('drops unserializable values and counts them in droppedAttributesCount', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const span = testSpan({ attributes: { circular } });
    const [mapped] = await shipSpans(span);

    expect(mapped.attributes).not.toHaveProperty('circular');
    expect(mapped.droppedAttributesCount).toBe(1);
  });

  it('drops a primitive array that strips down to nothing', async () => {
    const span = testSpan({ attributes: { empty: [null, undefined] } });
    const [mapped] = await shipSpans(span);
    expect(mapped.attributes).not.toHaveProperty('empty');
  });
});

/** The prompt fixture shared by the payload assertions. */
const prompt: ExportedSpan['input'] = [
  { role: 'system', content: 'You are a refund desk.' },
  { role: 'user', content: [{ type: 'text', text: 'refund o-1' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'checking the order' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'refund', input: { orderId: 'o-1' } },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'refund',
        output: { type: 'json', value: { refunded: true } },
      },
    ],
  },
];

describe('message semantics (agent-run / agent-step payloads)', () => {
  it('splits system instructions from input messages and converts every part', async () => {
    const span = testSpan({
      type: 'agent-step',
      name: 'gpt-5',
      attributes: { model: 'gpt-5', provider: 'openai' },
      input: prompt,
      output: 'all set',
    });
    const [mapped] = await shipSpans(span);

    expect(JSON.parse(mapped.attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'You are a refund desk.' },
    ]);
    expect(JSON.parse(mapped.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'refund o-1' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'checking the order' },
          { type: 'tool_call', id: 'call-1', name: 'refund', arguments: '{"orderId":"o-1"}' },
        ],
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_call_response', id: 'call-1', name: 'refund', output: '{"refunded":true}' },
        ],
      },
    ]);
    expect(JSON.parse(mapped.attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'all set' }] },
    ]);
  });

  it('degrades unrecognized parts to a single JSON text part', async () => {
    const span = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      input: [
        { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://x/y.png' } }] },
      ],
    });
    const [mapped] = await shipSpans(span);

    const messages = JSON.parse(mapped.attributes['gen_ai.input.messages'] as string) as {
      parts: { type: string; content: string }[];
    }[];
    const [message] = messages;
    expect(message!.parts).toHaveLength(1);
    const [part] = message!.parts;
    expect(part!.type).toBe('text');
    expect(JSON.parse(part!.content)).toMatchObject({ type: 'file', mediaType: 'image/png' });
  });

  it('omits empty model text and JSON-texts a structured result', async () => {
    const empty = testSpan({
      type: 'agent-step',
      name: 'gpt-5',
      attributes: { model: 'gpt-5', provider: 'openai' },
      output: '',
    });
    const structured = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      output: { verdict: 'approved' },
    });
    const spans = await shipSpans(empty, structured);
    const mappedEmpty = spans[0]!;
    const mappedStructured = spans[1]!;

    expect(mappedEmpty.attributes).not.toHaveProperty('gen_ai.output.messages');
    expect(JSON.parse(mappedStructured.attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '{"verdict":"approved"}' }] },
    ]);
  });

  it('falls back to balsa.input when the recorded input is not a message array', async () => {
    const span = testSpan({
      type: 'agent-run',
      name: 'desk',
      attributes: { agentName: 'desk' },
      input: { note: 'not a ModelMessage[]' },
    });
    const [mapped] = await shipSpans(span);

    expect(mapped.attributes['balsa.input']).toBe('{"note":"not a ModelMessage[]"}');
    expect(mapped.attributes).not.toHaveProperty('gen_ai.input.messages');
  });
});
