import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  MEMORY_RECALL_SPAN,
  MEMORY_SAVE_SPAN,
  NoOpSpan,
  TOOL_CALL_SPAN,
  WORKFLOW_RUN_SPAN,
  WORKFLOW_STEP_SPAN,
  createTracer,
  memoryExporter,
} from '@balsats/core/observability';
import type { ExportedSpan, Span } from '@balsats/core/observability';
import { SPAN_ID, TRACE_ID, kinds } from './helpers/spans.js';

/**
 * 观测内核(M1-08 #29):`createTracer({ exporters, sampler?, spanProcessors? })` 后用户手动
 * `startSpan` 自建 span,三事件(span_started / updated / ended)携带 ExportedSpan 在 memory exporter
 * 上可断言;采样四档只在 root 判定一次、不通过全树 NoOpSpan;spanProcessors 同步逐事件改写或丢弃;
 * hideInput / hideOutput 导出时擦字段;isEvent span 创建即完成、只派发一次 span_ended。
 *
 * 断言只走公开面(`@balsats/core/observability` 子路径导出)与规范钦定的 memory exporter 断言抓手
 * (issue #21 测试决策),不触碰内部状态。
 */

describe('手动 span 生命周期', () => {
  it('startSpan → end:span_started / span_ended 各一次,事件携带 ExportedSpan 快照', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({
      name: 'assistant',
      type: AGENT_RUN_SPAN,
      input: { question: 'Weather in SF?' },
    });
    span.end();

    expect(kinds(memory.events)).toEqual(['span_started', 'span_ended']);

    const started = memory.events[0]?.span as ExportedSpan;
    const ended = memory.events[1]?.span as ExportedSpan;

    expect(started.id).toMatch(SPAN_ID);
    expect(started.traceId).toMatch(TRACE_ID);
    expect(started.name).toBe('assistant');
    expect(started.type).toBe('agent-run');
    expect(started.input).toEqual({ question: 'Weather in SF?' });
    expect(started.startTime).toBeInstanceOf(Date);
    expect(started.parentSpanId).toBeUndefined();
    expect(started.endTime).toBeUndefined();

    // 导出形态去方法、去循环引用:只有纯数据字段,活 span 的三个方法不在其中
    expect(Object.keys(ended).sort()).toEqual(
      ['endTime', 'id', 'input', 'name', 'startTime', 'traceId', 'type'].sort(),
    );

    // ended 快照:同一身份,补上 endTime
    expect(ended.id).toBe(started.id);
    expect(ended.traceId).toBe(started.traceId);
    expect(ended.endTime).toBeInstanceOf(Date);
    expect(ended.endTime?.getTime()).toBeGreaterThanOrEqual(started.startTime.getTime());

    // 活 span 字段与导出快照一致
    expect(span.id).toMatch(SPAN_ID);
    expect(span.traceId).toMatch(TRACE_ID);
    expect(span.name).toBe('assistant');
    expect(span.type).toBe('agent-run');
    expect(span.endTime).toBeInstanceOf(Date);
  });

  it('框架 7 个 span 类型常量:workflow 两常量只导出、memory 两常量归 agent 埋点', () => {
    expect([
      AGENT_RUN_SPAN,
      AGENT_STEP_SPAN,
      TOOL_CALL_SPAN,
      WORKFLOW_RUN_SPAN,
      WORKFLOW_STEP_SPAN,
      MEMORY_RECALL_SPAN,
      MEMORY_SAVE_SPAN,
    ]).toEqual([
      'agent-run',
      'agent-step',
      'tool-call',
      'workflow-run',
      'workflow-step',
      'memory-recall',
      'memory-save',
    ]);
  });

  it('无 exporters 的 tracer 不报错:手动 span 照常可用', () => {
    const tracer = createTracer({ exporters: [] });
    const span: Span = tracer.startSpan({ name: 'noop-exporter', type: 'custom' });

    expect(() => {
      span.update({ output: 'ok' });
      span.end();
    }).not.toThrow();
  });
});

describe('memory exporter:环形缓冲', () => {
  it('超过容量时丢最旧事件,events 只保留最近的 capacity 条', () => {
    const memory = memoryExporter({ capacity: 2 });
    const tracer = createTracer({ exporters: [memory] });

    tracer.startSpan({ name: 'a', type: 'custom' }).end();
    tracer.startSpan({ name: 'b', type: 'custom' }).end();

    expect(kinds(memory.events)).toEqual(['span_started', 'span_ended']);
    expect(memory.events.map((event) => event.span.name)).toEqual(['b', 'b']);
  });

  it('spans() 按 span 去重,按首次出现顺序给出最新快照', () => {
    const memory = memoryExporter({ capacity: 3 });
    const tracer = createTracer({ exporters: [memory] });

    tracer.startSpan({ name: 'a', type: 'custom' }).end();
    tracer.startSpan({ name: 'b', type: 'custom' });

    expect(memory.spans().map((span) => span.name)).toEqual(['a', 'b']);
    // a 的最新快照来自 span_ended(带 endTime),b 还开着
    expect(memory.spans()[0]?.endTime).toBeInstanceOf(Date);
    expect(memory.spans()[1]?.endTime).toBeUndefined();
  });

  it('clear() 清空后继续记录', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    tracer.startSpan({ name: 'a', type: 'custom' }).end();
    memory.clear();
    expect(memory.events).toEqual([]);

    tracer.startSpan({ name: 'b', type: 'custom' });
    expect(memory.events.map((event) => event.span.name)).toEqual(['b']);
  });
});

describe('isEvent span:创建即完成', () => {
  it('创建即派发 span_ended,无 endTime;end() 不再派发第二次', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const event = tracer.startSpan({
      name: 'user-message',
      type: 'custom',
      isEvent: true,
      input: 'hello',
    });
    event.end();

    expect(kinds(memory.events)).toEqual(['span_ended']);
    const span = memory.events[0]?.span as ExportedSpan;
    expect(span.isEvent).toBe(true);
    expect(span.input).toBe('hello');
    expect(span.endTime).toBeUndefined();
  });

  it('创建后 update / error 是 no-op:事件不增、字段不变', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const event = tracer.startSpan({ name: 'e', type: 'custom', isEvent: true });
    event.update({ output: 'late' });
    event.error(new Error('late'));

    expect(kinds(memory.events)).toEqual(['span_ended']);
    expect(memory.events[0]?.span.output).toBeUndefined();
    expect(memory.events[0]?.span.error).toBeUndefined();
  });

  it('isEvent span 作为子 span:traceId / parentSpanId 照常继承', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const root = tracer.startSpan({ name: 'root', type: AGENT_RUN_SPAN });
    tracer.startSpan({ name: 'tick', type: 'custom', parent: root, isEvent: true });

    const tick = memory.events.at(-1)?.span as ExportedSpan;
    expect(tick.isEvent).toBe(true);
    expect(tick.traceId).toBe(root.traceId);
    expect(tick.parentSpanId).toBe(root.id);
  });
});

describe('采样:只在 root 判定一次', () => {
  it("缺省 'always':每个 root 都记录", () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({ name: 'r', type: 'custom' });

    expect(span).not.toBe(NoOpSpan);
    expect(kinds(memory.events)).toEqual(['span_started']);
  });

  it("'never':root 返回 NoOpSpan,整树零事件,后代仍是同一个 NoOpSpan", () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], sampler: 'never' });

    const root = tracer.startSpan({ name: 'r', type: AGENT_RUN_SPAN });
    const child = tracer.startSpan({ name: 'c', type: AGENT_STEP_SPAN, parent: root });

    expect(root).toBe(NoOpSpan);
    expect(child).toBe(NoOpSpan);
    expect(memory.events).toEqual([]);

    // NoOpSpan 全方法 no-op,不抛错
    expect(() => {
      root.update({ output: 1 });
      root.error(new Error('x'));
      root.end();
    }).not.toThrow();
  });

  it('NoOpSpan 的 startTime 是不可腐蚀的哨兵:外部拿到的 Date 改不动它', () => {
    NoOpSpan.startTime.setTime(123);
    expect(NoOpSpan.startTime.getTime()).toBe(0);
  });

  it('{ ratio: 0 } / { ratio: 1 } 两端确定;中间按 Math.random 阈值判定', () => {
    const random = vi.spyOn(Math, 'random');

    const never = createTracer({ exporters: [], sampler: { ratio: 0 } });
    expect(never.startSpan({ name: 'r', type: 'custom' })).toBe(NoOpSpan);

    const always = createTracer({ exporters: [], sampler: { ratio: 1 } });
    expect(always.startSpan({ name: 'r', type: 'custom' })).not.toBe(NoOpSpan);

    random.mockReturnValue(0.4);
    const half = createTracer({ exporters: [], sampler: { ratio: 0.5 } });
    expect(half.startSpan({ name: 'below', type: 'custom' })).not.toBe(NoOpSpan);
    random.mockReturnValue(0.6);
    expect(half.startSpan({ name: 'above', type: 'custom' })).toBe(NoOpSpan);

    random.mockRestore();
  });

  it('ratio 越界 / 非数字:createTracer 即显式报错(不拖到运行中途)', () => {
    expect(() => createTracer({ exporters: [], sampler: { ratio: 1.5 } })).toThrow(RangeError);
    expect(() => createTracer({ exporters: [], sampler: { ratio: -0.1 } })).toThrow(RangeError);
    expect(() => createTracer({ exporters: [], sampler: { ratio: Number.NaN } })).toThrow(RangeError);
  });

  it('函数采样器:root 判定时调用一次(无外部 parent 时为 undefined),子 span 继承不重判', () => {
    const memory = memoryExporter();
    const sampler = vi.fn(() => true);
    const tracer = createTracer({ exporters: [memory], sampler });

    const root = tracer.startSpan({ name: 'r', type: AGENT_RUN_SPAN });
    const child = tracer.startSpan({ name: 'c', type: AGENT_STEP_SPAN, parent: root });

    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith(undefined);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.id);
    expect(kinds(memory.events)).toEqual(['span_started', 'span_started']);
  });

  it('函数采样器返回 false:root 与后代全 NoOp', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], sampler: () => false });

    const root = tracer.startSpan({ name: 'r', type: 'custom' });
    const child = tracer.startSpan({ name: 'c', type: 'custom', parent: root });

    expect(root).toBe(NoOpSpan);
    expect(child).toBe(NoOpSpan);
    expect(memory.events).toEqual([]);
  });
});

describe('活 span API:update / error / end', () => {
  it('update 设置 name / input / output,浅合并 attributes / metadata,省略字段不动', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({
      name: 'generate',
      type: AGENT_STEP_SPAN,
      attributes: { model: 'gpt-4o', provider: 'openai' },
      metadata: { tenant: 'acme' },
    });
    span.update({
      output: { text: 'done' },
      attributes: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
      metadata: { region: 'eu' },
    });

    const snapshot = memory.events.at(-1)?.span as ExportedSpan;
    expect(snapshot.name).toBe('generate');
    expect(snapshot.output).toEqual({ text: 'done' });
    expect(snapshot.attributes).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(snapshot.metadata).toEqual({ tenant: 'acme', region: 'eu' });
  });

  it('update 可改 name;未提供的字段保持不变', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({ name: 'before', type: 'custom', input: 'kept' });
    span.update({ name: 'after' });

    const snapshot = memory.events.at(-1)?.span as ExportedSpan;
    expect(snapshot.name).toBe('after');
    expect(snapshot.input).toBe('kept');
  });

  it('error(err):导出快照的 error 带 message 与原始 details,派发 span_updated', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const cause = new Error('upstream timeout');

    const span = tracer.startSpan({ name: 'weather', type: TOOL_CALL_SPAN });
    span.error(cause);

    expect(kinds(memory.events)).toEqual(['span_started', 'span_updated']);
    expect(memory.events[1]?.span.error).toEqual({
      message: 'upstream timeout',
      details: cause,
    });
  });

  it('error 非 Error 值:message 取字符串形式', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({ name: 'a', type: 'custom' });
    span.error('boom');

    expect(memory.events[1]?.span.error).toEqual({ message: 'boom', details: 'boom' });
  });

  it('end 幂等:只派发一次 span_ended;end 之后的 update / error 不再派发', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const span = tracer.startSpan({ name: 'a', type: 'custom' });
    span.end();
    span.end();
    span.update({ output: 'late' });
    span.error(new Error('late'));

    expect(kinds(memory.events)).toEqual(['span_started', 'span_ended']);
    expect(memory.events[1]?.span.output).toBeUndefined();
    expect(memory.events[1]?.span.error).toBeUndefined();
  });
});

describe('span 树与 trace 续接', () => {
  it('子 span 继承 traceId,parentSpanId 指向父 span:树结构在 memory exporter 可断言', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const run = tracer.startSpan({
      name: 'assistant',
      type: AGENT_RUN_SPAN,
      attributes: { agentName: 'assistant', runId: 'run-1' },
    });
    const step = tracer.startSpan({
      name: 'generate',
      type: AGENT_STEP_SPAN,
      parent: run,
      attributes: { model: 'gpt-4o', provider: 'openai' },
    });
    const tool = tracer.startSpan({
      name: 'weather',
      type: TOOL_CALL_SPAN,
      parent: step,
      attributes: { toolCallId: 'call-1' },
      input: { city: 'SF' },
    });
    tool.end();
    step.end();
    run.end();

    const spans = memory.spans();
    expect(spans.map((span) => span.name)).toEqual(['assistant', 'generate', 'weather']);
    expect(spans[0]?.traceId).toMatch(TRACE_ID);
    expect(spans[1]?.traceId).toBe(spans[0]?.traceId);
    expect(spans[1]?.parentSpanId).toBe(spans[0]?.id);
    expect(spans[2]?.traceId).toBe(spans[0]?.traceId);
    expect(spans[2]?.parentSpanId).toBe(spans[1]?.id);
    expect(new Set(spans.map((span) => span.id)).size).toBe(3);
    expect(spans[0]?.attributes).toEqual({ agentName: 'assistant', runId: 'run-1' });
  });

  it('显式 traceId / parentSpanId:root 续接外部 trace,sampler 收到该 parent,子 span 沿用', () => {
    const memory = memoryExporter();
    const sampler = vi.fn(() => true);
    const tracer = createTracer({ exporters: [memory], sampler });
    const externalTrace = 'a'.repeat(32);
    const externalParent = 'b'.repeat(16);

    const root = tracer.startSpan({
      name: 'assistant',
      type: AGENT_RUN_SPAN,
      traceId: externalTrace,
      parentSpanId: externalParent,
    });
    const child = tracer.startSpan({ name: 'generate', type: AGENT_STEP_SPAN, parent: root });

    expect(root.traceId).toBe(externalTrace);
    expect(root.parentSpanId).toBe(externalParent);
    expect(child.traceId).toBe(externalTrace);
    expect(child.parentSpanId).toBe(root.id);
    expect(sampler).toHaveBeenCalledWith({ traceId: externalTrace, parentSpanId: externalParent });
  });

  it('只给 traceId:续接同一 trace、没有 parentSpanId;sampler 收到该 trace', () => {
    const memory = memoryExporter();
    const sampler = vi.fn(() => true);
    const tracer = createTracer({ exporters: [memory], sampler });

    const root = tracer.startSpan({
      name: 'assistant',
      type: AGENT_RUN_SPAN,
      traceId: 'c'.repeat(32),
    });

    expect(root.traceId).toBe('c'.repeat(32));
    expect(root.parentSpanId).toBeUndefined();
    expect(sampler).toHaveBeenCalledWith({ traceId: 'c'.repeat(32) });
  });

  it('非法的续接组合在 startSpan 即显式报错:parentSpanId 缺 traceId,parent 与外部 ids 混用', () => {
    const tracer = createTracer({ exporters: [] });
    const root = tracer.startSpan({ name: 'r', type: 'custom' });

    expect(() =>
      tracer.startSpan({ name: 'x', type: 'custom', parentSpanId: 'b'.repeat(16) }),
    ).toThrow(/traceId/);
    expect(() =>
      tracer.startSpan({
        name: 'x',
        type: 'custom',
        parent: root,
        traceId: 'c'.repeat(32),
      }),
    ).toThrow(/parent/);
  });
});

describe('flush / shutdown:转发给每个 exporter', () => {
  it('flush 逐个调用 exporter.flush;shutdown 先 flush 再逐个 shutdown', async () => {
    const calls: string[] = [];
    const tracer = createTracer({
      exporters: [
        {
          export: () => {},
          flush: async () => {
            calls.push('first:flush');
          },
          shutdown: async () => {
            calls.push('first:shutdown');
          },
        },
        {
          export: () => {},
          flush: async () => {
            calls.push('second:flush');
          },
        },
      ],
    });

    await tracer.flush();
    expect(calls).toEqual(['first:flush', 'second:flush']);

    await tracer.shutdown();
    expect(calls).toEqual(['first:flush', 'second:flush', 'first:flush', 'second:flush', 'first:shutdown']);
  });

  it('异步 export 不阻塞调用方;flush 等待在途 export 完成', async () => {
    const lines: string[] = [];
    const tracer = createTracer({
      exporters: [
        {
          export: async (event) => {
            await Promise.resolve();
            lines.push(event.kind);
          },
        },
      ],
    });

    tracer.startSpan({ name: 'a', type: 'custom' }).end();
    expect(lines).toEqual([]);

    await tracer.flush();
    expect(lines).toEqual(['span_started', 'span_ended']);
  });

  it('export 抛错或异步拒绝被吞掉:不打断被观测的代码,flush 不拒绝', async () => {
    const tracer = createTracer({
      exporters: [
        {
          export: () => {
            throw new Error('exporter broke');
          },
        },
        {
          export: async () => {
            throw new Error('exporter rejected');
          },
        },
      ],
    });

    expect(() => {
      tracer.startSpan({ name: 'a', type: 'custom' }).end();
    }).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
  });
});
