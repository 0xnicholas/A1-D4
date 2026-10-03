import { describe, expect, it, vi } from 'vitest';
import { AGENT_RUN_SPAN, consoleExporter, createTracer, memoryExporter } from '@oribos/core/observability';
import type { TracingEvent } from '@oribos/core/observability';

/**
 * 导出前整形与 console exporter(M1-08 #29,observability.md):
 * - spanProcessors:同步、逐事件生效——原地改写或返回 undefined 丢弃;有序链。
 * - hideInput / hideOutput:trace 级开关,导出时擦字段;root 决定、后代继承。
 * - console exporter:开发调试的美化打印,可注入 logger 供断言。
 */

describe('spanProcessors:同步逐事件改写或丢弃', () => {
  it('原地改写:处理器改字段并返回事件,exporter 看到改写后的快照', () => {
    const memory = memoryExporter();
    const tracer = createTracer({
      exporters: [memory],
      spanProcessors: [
        (event) => {
          event.span.name = 'redacted';
          return event;
        },
      ],
    });

    tracer.startSpan({ name: 'assistant', type: AGENT_RUN_SPAN }).end();

    expect(memory.events.map((event) => event.span.name)).toEqual(['redacted', 'redacted']);
  });

  it('返回 undefined 丢弃事件:后续处理器与 exporter 都看不到', () => {
    const memory = memoryExporter();
    const seen: string[] = [];
    const tracer = createTracer({
      exporters: [memory],
      spanProcessors: [
        (event) => {
          seen.push(`first:${event.kind}`);
          return undefined;
        },
        (event) => {
          seen.push(`second:${event.kind}`);
          return event;
        },
      ],
    });

    tracer.startSpan({ name: 'a', type: 'custom' }).end();

    expect(memory.events).toEqual([]);
    expect(seen).toEqual(['first:span_started', 'first:span_ended']);
  });

  it('有序链:后一个处理器收到前一个的产出(替换事件同样生效)', () => {
    const memory = memoryExporter();
    const tracer = createTracer({
      exporters: [memory],
      spanProcessors: [
        (event) => ({ ...event, span: { ...event.span, name: `${event.span.name}:first` } }),
        (event) => {
          event.span.name = `${event.span.name}:second`;
          return event;
        },
      ],
    });

    tracer.startSpan({ name: 'a', type: 'custom' });

    expect(memory.events[0]?.span.name).toBe('a:first:second');
  });

  it('导出快照与活 span 隔离:处理器改写快照不影响 span 本身', () => {
    const memory = memoryExporter();
    const tracer = createTracer({
      exporters: [memory],
      spanProcessors: [
        (event) => {
          event.span.name = 'rewritten';
          return event;
        },
      ],
    });

    const span = tracer.startSpan({ name: 'original', type: 'custom' });
    span.end();

    expect(span.name).toBe('original');
    expect(memory.events.map((event) => event.span.name)).toEqual(['rewritten', 'rewritten']);
  });
});

describe('hideInput / hideOutput:导出时擦字段', () => {
  /** 事件的 input / output 字段是否在快照上存在(擦除 = 字段不存在,不是 undefined)。 */
  function hiddenFields(events: readonly TracingEvent[]): { input: boolean; output: boolean }[] {
    return events.map((event) => ({
      input: 'input' in event.span,
      output: 'output' in event.span,
    }));
  }

  it('trace 级开关:所有事件的 input / output 字段被擦除', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true, hideOutput: true });

    tracer
      .startSpan({ name: 'a', type: 'custom', input: 'secret-in', output: 'secret-out' })
      .end();

    expect(hiddenFields(memory.events)).toEqual([
      { input: false, output: false },
      { input: false, output: false },
    ]);
  });

  it('只开 hideInput:output 照常导出', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true });

    tracer.startSpan({ name: 'a', type: 'custom', input: 'secret', output: 'ok' }).end();

    expect(hiddenFields(memory.events)).toEqual([
      { input: false, output: true },
      { input: false, output: true },
    ]);
    expect(memory.events[1]?.span.output).toBe('ok');
  });

  it('root 覆盖被后代继承:trace 级开而 root 显式关,整条子链保留字段', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true });

    const root = tracer.startSpan({ name: 'root', type: AGENT_RUN_SPAN, input: 'kept', hideInput: false });
    const child = tracer.startSpan({ name: 'child', type: 'custom', parent: root, input: 'also-kept' });

    expect(['input' in root, 'input' in child]).toEqual([true, true]);
    expect(memory.events.map((event) => 'input' in event.span)).toEqual([true, true]);
  });

  it('root 覆盖:trace 级关而 root 显式开,root 与后代都擦', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });

    const root = tracer.startSpan({ name: 'root', type: AGENT_RUN_SPAN, input: 'secret', hideInput: true });
    tracer.startSpan({ name: 'child', type: 'custom', parent: root, input: 'secret' });

    expect(memory.events.map((event) => 'input' in event.span)).toEqual([false, false]);
  });

  it('hide 是 trace 级:子 span 传 hideInput / hideOutput 直接报错,不能改写继承的决定', () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true });
    const root = tracer.startSpan({ name: 'root', type: AGENT_RUN_SPAN, input: 'secret' });

    expect(() =>
      tracer.startSpan({ name: 'child', type: 'custom', parent: root, hideInput: false }),
    ).toThrow(/hideInput/);
    expect(() =>
      tracer.startSpan({ name: 'child', type: 'custom', parent: root, hideOutput: false }),
    ).toThrow(/hideOutput/);
    // 已记录的事件不受影响,决定依旧是 root 的
    expect(memory.events.map((event) => 'input' in event.span)).toEqual([false]);
  });

  it('hide 在 spanProcessors 之后生效:处理器补回的字段同样被擦(exporters 永远看不到)', () => {
    const memory = memoryExporter();
    const tracer = createTracer({
      exporters: [memory],
      hideInput: true,
      spanProcessors: [
        (event) => {
          event.span.input = 're-added';
          return event;
        },
      ],
    });

    tracer.startSpan({ name: 'a', type: 'custom' });

    expect(memory.events[0]?.span.input).toBeUndefined();
    expect('input' in (memory.events[0]?.span ?? {})).toBe(false);
  });
});

describe('console exporter:开发调试美化打印', () => {
  function capture(): { lines: string[]; logger: { log: (line: string) => void } } {
    const lines: string[] = [];
    return { lines, logger: { log: (line) => lines.push(line) } };
  }

  it('每个事件一行头部:事件类型 / span 类型 / 名称 / id;结束事件带 duration', () => {
    const { lines, logger } = capture();
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory, consoleExporter({ logger })] });

    const span = tracer.startSpan({ name: 'assistant', type: AGENT_RUN_SPAN });
    span.end();

    const text = lines.join('\n');
    expect(text).toContain(`span_started agent-run "assistant" id=${span.id}`);
    expect(text).toContain(`span_ended agent-run "assistant" id=${span.id}`);
    expect(text).toContain(`trace=${span.traceId}`);
    expect(lines.find((line) => line.includes('span_ended'))).toMatch(/duration=\d+ms/);
  });

  it('父 span 与事件 span 在头部标出', () => {
    const { lines, logger } = capture();
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory, consoleExporter({ logger })] });

    const root = tracer.startSpan({ name: 'root', type: AGENT_RUN_SPAN });
    tracer.startSpan({ name: 'tick', type: 'custom', parent: root, isEvent: true });

    expect(lines.join('\n')).toContain(`parent=${root.id}`);
    expect(lines.join('\n')).toContain('event');
  });

  it('input / output / attributes / metadata / error 作为缩进详情行打印', () => {
    const { lines, logger } = capture();
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory, consoleExporter({ logger })] });

    const span = tracer.startSpan({
      name: 'weather',
      type: 'tool-call',
      input: { city: 'SF' },
      attributes: { toolCallId: 'call-1' },
      metadata: { tenant: 'acme' },
    });
    span.update({ output: { celsius: 21 } });
    span.error(new Error('upstream timeout'));
    span.end();

    const text = lines.join('\n');
    expect(text).toContain('"city": "SF"');
    expect(text).toContain('"toolCallId": "call-1"');
    expect(text).toContain('"tenant": "acme"');
    expect(text).toContain('"celsius": 21');
    expect(text).toContain('upstream timeout');
  });

  it('缺省 logger 走 console.log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createTracer({ exporters: [consoleExporter()] }).startSpan({ name: 'a', type: 'custom' });
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
