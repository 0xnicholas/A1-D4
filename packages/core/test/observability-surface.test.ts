import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  MEMORY_RECALL_SPAN,
  MEMORY_SAVE_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@balsa/core/observability';
import type {
  AgentRunAttributes,
  AgentStepAttributes,
  ExportedSpan,
  MemoryRecallAttributes,
  MemorySaveAttributes,
  Span,
  SpanAttributes,
  SpanError,
  SpanProcessor,
  StartSpanOptions,
  Tracer,
  TracerConfig,
  TracingEvent,
  ToolCallAttributes,
  WorkflowRunAttributes,
} from '@balsa/core/observability';
import { expectAssignable } from './helpers/assertions.js';

/**
 * 观测内核的类型表面(M1-08 #29):Span / ExportedSpan 形状与 7 类型常量、采样四档、processor 签名、
 * startSpan 选项都在公开面导出且形状正确——编译期断言,运行时只留最小声明性检查。
 */
describe('观测内核类型表面', () => {
  it('Span 有活方法;ExportedSpan 是纯数据(无 end / update / error 方法)', () => {
    type SpanHasEnd = 'end' extends keyof Span ? true : false;
    type SpanHasUpdate = 'update' extends keyof Span ? true : false;
    type SpanHasError = 'error' extends keyof Span ? true : false;
    type ExportedHasEnd = 'end' extends keyof ExportedSpan ? true : false;
    type ExportedHasUpdate = 'update' extends keyof ExportedSpan ? true : false;

    expectAssignable<true>(null as unknown as SpanHasEnd);
    expectAssignable<true>(null as unknown as SpanHasUpdate);
    expectAssignable<true>(null as unknown as SpanHasError);
    expectAssignable<false>(null as unknown as ExportedHasEnd);
    expectAssignable<false>(null as unknown as ExportedHasUpdate);

    // error 在活 span 上是记录方法,在导出形态上是数据字段
    expectAssignable<(error: unknown) => void>(null as unknown as Span['error']);
    expectAssignable<SpanError | undefined>(null as unknown as ExportedSpan['error']);
    expectAssignable<string>(null as unknown as ExportedSpan['id']);
    expectAssignable<string>(null as unknown as ExportedSpan['traceId']);
    expectAssignable<Date>(null as unknown as ExportedSpan['startTime']);
    expectAssignable<Date | undefined>(null as unknown as ExportedSpan['endTime']);
    expectAssignable<boolean | undefined>(null as unknown as ExportedSpan['isEvent']);
    expectAssignable<Record<string, unknown> | undefined>(
      null as unknown as ExportedSpan['metadata'],
    );
  });

  it('Span / ExportedSpan 全字段可从公开面构造(手写字面量的合法形状)', () => {
    const exported: ExportedSpan = {
      id: '1a2b3c4d5e6f7a8b',
      traceId: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      parentSpanId: '5e6f7a8b1a2b3c4d',
      name: 'assistant',
      type: AGENT_RUN_SPAN,
      startTime: new Date('2026-01-01T00:00:00.000Z'),
      endTime: new Date('2026-01-01T00:00:01.000Z'),
      input: { question: 'hi' },
      output: 'hi',
      attributes: { agentName: 'assistant', runId: 'run-1' },
      metadata: { tenant: 'acme' },
      error: { message: 'boom', details: new Error('boom') },
      isEvent: false,
    };

    expect(exported.id).toBe('1a2b3c4d5e6f7a8b');
  });

  it('attributes 按 7 个框架类型各自的形状 + 开放袋', () => {
    expectAssignable<AgentRunAttributes>({ agentName: 'assistant', runId: 'run-1' });
    expectAssignable<AgentStepAttributes>({
      model: 'gpt-4o',
      provider: 'openai',
      parameters: { temperature: 0.2 },
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      finishReason: 'stop',
      timeToFirstChunk: 120,
    });
    expectAssignable<ToolCallAttributes>({ toolCallId: 'call-1' });
    expectAssignable<WorkflowRunAttributes>({ workflowId: 'w-1' });
    expectAssignable<MemoryRecallAttributes>({ threadId: 'thread-1' });
    expectAssignable<MemorySaveAttributes>({ threadId: 'thread-1', resourceId: 'user-1' });

    expectAssignable<SpanAttributes>({ agentName: 'assistant' });
    expectAssignable<SpanAttributes>({ model: 'gpt-4o', provider: 'openai' });
    expectAssignable<SpanAttributes>({ toolCallId: 'call-1' });
    expectAssignable<SpanAttributes>({ workflowId: 'w-1' });
    expectAssignable<SpanAttributes>({ threadId: 'thread-1' });
    expectAssignable<SpanAttributes>({ threadId: 'thread-1', resourceId: 'user-1' });
    // workflow-step 的空属性与用户自建 span 的开放袋
    expectAssignable<SpanAttributes>({});
    expectAssignable<SpanAttributes>({ anything: 1 });

    // @ts-expect-error agent-step 缺 provider
    expectAssignable<AgentStepAttributes>({ model: 'gpt-4o' });
    // @ts-expect-error memory-save 缺 resourceId
    expectAssignable<MemorySaveAttributes>({ threadId: 'thread-1' });
  });

  it('startSpan 选项:type 开放字符串,name 必填', () => {
    expectAssignable<StartSpanOptions>({ name: 'a', type: AGENT_RUN_SPAN });
    expectAssignable<StartSpanOptions>({ name: 'a', type: AGENT_STEP_SPAN, parent: null as unknown as Span });
    expectAssignable<StartSpanOptions>({ name: 'a', type: TOOL_CALL_SPAN, input: 1, output: 2 });
    expectAssignable<StartSpanOptions>({ name: 'a', type: MEMORY_RECALL_SPAN, parent: null as unknown as Span });
    expectAssignable<StartSpanOptions>({ name: 'a', type: MEMORY_SAVE_SPAN, input: [], output: [] });
    expectAssignable<StartSpanOptions>({ name: 'a', type: 'my-own-type', isEvent: true });
    expectAssignable<StartSpanOptions>({
      name: 'a',
      type: AGENT_RUN_SPAN,
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
    });
    expectAssignable<StartSpanOptions>({ name: 'a', type: 'custom', hideInput: true, hideOutput: true });

    // @ts-expect-error name 必填
    expectAssignable<StartSpanOptions>({ type: 'custom' });
  });

  it('采样四档与 processor 签名可从公开面书写', () => {
    expectAssignable<TracerConfig>({ exporters: [] });
    expectAssignable<TracerConfig>({
      exporters: [],
      sampler: 'never',
      spanProcessors: [],
      hideInput: true,
      hideOutput: true,
    });

    expectAssignable<SpanProcessor>((event) => event);
    expectAssignable<SpanProcessor>(() => undefined);
    expectAssignable<SpanProcessor>((event) => {
      event.span.name = 'rewritten';
      return event;
    });
  });

  it('三事件判别联合的 kind 收窄', () => {
    const event: TracingEvent = { kind: 'span_started', span: null as unknown as ExportedSpan };
    expectAssignable<'span_started' | 'span_updated' | 'span_ended'>(event.kind);

    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const span = tracer.startSpan({ name: 'a', type: 'custom' });
    expectAssignable<Tracer>(tracer);
    expectAssignable<Span>(span);
    span.end();

    expect(memory.events.map((record) => record.kind)).toEqual(['span_started', 'span_ended']);
  });
});
