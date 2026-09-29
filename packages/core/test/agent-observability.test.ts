import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@balsa/core/agent';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@balsa/core/observability';
import { createTool } from '@balsa/core/tools';
import type { ToolContext } from '@balsa/core/tools';
import { fakeModel } from './helpers/fake-model.js';
import { SPAN_ID, TRACE_ID, eventsOfType, kinds, spanOfType } from './helpers/spans.js';

/**
 * 三边界自动埋点与 trace 续接(M1-09 #30):挂上 tracer 后 agent run / agent step / tool call
 * 三边界自动开 span,parent 沿执行树显式传播(无 AsyncLocalStorage);root span attribute 带
 * runId;agent-step 携带 model / provider / usage / finishReason / timeToFirstChunk;tool-call
 * 携带 toolCallId、失败落 error;run option traceId / parentSpanId 续接外部 trace;ToolContext 的
 * traceId / spanId 为真值;不挂 tracer 时整个子系统零开销。
 *
 * 断言只走公开面(@balsa/core 子路径导出)与规范钦定的 memory exporter 抓手(issue #21 测试
 * 决策):span 树结构、三事件序列与 span 快照都在这里读。
 */

const INSTRUCTIONS = 'You are concise.';

describe('agent run span:root 边界', () => {
  it('挂 tracer 后 generate() 自动开 agent-run root span:name / 三事件序列 / input / output / runId', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([{ text: 'hello' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tracer });

    await agent.generate('Hi.');

    // 三事件:started → updated → ended,每类各一次
    expect(kinds(eventsOfType(memory, AGENT_RUN_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_ended',
    ]);

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    expect(run.name).toBe('assistant');
    expect(run.id).toMatch(SPAN_ID);
    expect(run.traceId).toMatch(TRACE_ID);
    // root span:无父
    expect(run.parentSpanId).toBeUndefined();
    // root span attribute 带 runId(runId 是执行身份,traceId 是观测身份)
    expect(run.attributes).toEqual({ agentName: 'assistant', runId: expect.any(String) });
    const runId = (run.attributes as { runId?: string }).runId ?? '';
    expect(runId).not.toBe('');
    // input = 入参消息(prompt),output = 终值 text
    expect(run.input).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
    expect(run.output).toBe('hello');
    expect(run.endTime).toBeInstanceOf(Date);
    expect(run.endTime?.getTime()).toBeGreaterThanOrEqual(run.startTime.getTime());
  });
});

describe('agent step span:模型调用边界', () => {
  it('每轮模型调用一个 agent-step span,parent 为 agent-run,attributes 完整', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([{ text: 'hello', usage: { inputTokens: 3, outputTokens: 4 } }], {
      provider: 'openai',
      modelId: 'gpt-4o',
    });
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tracer });

    await agent.generate('Hi.', { modelSettings: { temperature: 0.2 } });

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const step = spanOfType(memory, AGENT_STEP_SPAN);
    expect(step.parentSpanId).toBe(run.id);
    expect(step.traceId).toBe(run.traceId);
    expect(step.name).toBe('gpt-4o');
    expect(step.attributes).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
      parameters: { temperature: 0.2 },
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      finishReason: 'stop',
      timeToFirstChunk: expect.any(Number),
    });
    expect(step.input).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
    expect(step.output).toBe('hello');
    expect(kinds(eventsOfType(memory, AGENT_STEP_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_ended',
    ]);
  });

  it('未传 modelSettings 时 parameters 属性缺席(不写空袋)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'hello' }]),
      tracer,
    });

    await agent.generate('Hi.');

    const step = spanOfType(memory, AGENT_STEP_SPAN);
    expect(step.attributes).not.toHaveProperty('parameters');
  });
});

describe('tool call span:工具执行边界', () => {
  it('工具执行自动开 tool-call span(parent = 所属 step span);ToolContext 的 traceId / spanId 为真值', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'provider-call-7', toolName: 'weather', input: { city: 'SF' } }],
      },
      { text: 'It is 21°C.' },
    ]);
    const seen: ToolContext[] = [];
    const weather = createTool({
      description: 'Looks up the weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: (_input, ctx) => {
        seen.push(ctx);
        return { celsius: 21 };
      },
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { weather },
      tracer,
    });

    await agent.generate('Weather in SF?');

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const steps = memory.spans().filter((span) => span.type === AGENT_STEP_SPAN);
    const tool = spanOfType(memory, TOOL_CALL_SPAN);

    // 每轮模型调用一个 step span,都挂 root 下;tool span 挂它所属的 step 下
    expect(steps).toHaveLength(2);
    expect(steps.map((span) => span.parentSpanId)).toEqual([run.id, run.id]);
    expect(tool.parentSpanId).toBe(steps[0]?.id);
    expect(tool.traceId).toBe(run.traceId);
    expect(tool.name).toBe('weather');
    expect(tool.attributes).toEqual({ toolCallId: 'provider-call-7' });
    expect(tool.input).toEqual({ city: 'SF' });
    expect(tool.output).toEqual({ celsius: 21 });
    expect(tool.error).toBeUndefined();
    expect(tool.endTime).toBeInstanceOf(Date);
    expect(kinds(eventsOfType(memory, TOOL_CALL_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_ended',
    ]);

    // 工具 ctx 六件套:traceId = run 的 trace,spanId = 当前 tool-call span,toolCallId = provider 真值
    const context = seen[0];
    expect(context?.traceId).toBe(run.traceId);
    expect(context?.spanId).toBe(tool.id);
    expect(context?.toolCallId).toBe('provider-call-7');
    expect(context?.spanId).toMatch(SPAN_ID);
    // runId 双向互查:root span attribute(runId)与工具 ctx 一致
    expect((run.attributes as { runId?: string }).runId).toBe(context?.runId);
  });

  it('工具 execute 抛错:tool-call span 落 error(原错误进 details),run 照常继续', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'boom', input: {} }] },
      { text: 'recovered' },
    ]);
    const explosion = new Error('upstream 500');
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        boom: {
          description: 'Always fails.',
          execute: () => {
            throw explosion;
          },
        },
      },
      tracer,
    });

    const result = await agent.generate('Go.');

    expect(result.text).toBe('recovered');
    const tool = spanOfType(memory, TOOL_CALL_SPAN);
    expect(tool.error).toEqual({ message: 'upstream 500', details: explosion });
    expect(tool.endTime).toBeInstanceOf(Date);
    // 失败路径的事件序列:error 与结果各发一次 updated,ended 收尾
    expect(kinds(eventsOfType(memory, TOOL_CALL_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_updated',
      'span_ended',
    ]);
  });

  it('模型调用失败:run 与 step span 都落 error 并闭合', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([{ fail: new Error('provider down') }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tracer });

    await expect(agent.generate('Hi.')).rejects.toThrow('provider down');

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const step = spanOfType(memory, AGENT_STEP_SPAN);
    expect(run.error?.message).toBe('provider down');
    expect(step.error?.message).toBe('provider down');
    expect(run.endTime).toBeInstanceOf(Date);
    expect(step.endTime).toBeInstanceOf(Date);
    expect(kinds(eventsOfType(memory, AGENT_RUN_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_ended',
    ]);
    expect(kinds(eventsOfType(memory, AGENT_STEP_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_ended',
    ]);
  });
});

describe('run option:trace 续接(traceId / parentSpanId)', () => {
  const TRACE = 'a'.repeat(32);
  const PARENT = 'b'.repeat(16);

  it('root span 挂到指定 trace 与父 span;子代继承同一 trace', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'hi' }]),
      tracer,
    });

    await agent.generate('Hi.', { traceId: TRACE, parentSpanId: PARENT });

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    expect(run.traceId).toBe(TRACE);
    expect(run.parentSpanId).toBe(PARENT);
    const step = spanOfType(memory, AGENT_STEP_SPAN);
    expect(step.traceId).toBe(TRACE);
    expect(step.parentSpanId).toBe(run.id);
  });

  it('只给 traceId:root span 续接该 trace、无父 span', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'hi' }]),
      tracer,
    });

    await agent.generate('Hi.', { traceId: TRACE });

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    expect(run.traceId).toBe(TRACE);
    expect(run.parentSpanId).toBeUndefined();
    expect(spanOfType(memory, AGENT_STEP_SPAN).traceId).toBe(TRACE);
  });

  it('空串 = 无 trace:起自己的新 trace;空 traceId + 真 parentSpanId 的混合对也不接', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'a' }, { text: 'b' }]),
      tracer,
    });

    // 工具 ctx 对“无 trace”的编码;混合的半截续接(trace 空、parent 真)同样不成接,不报 tracer 契约错
    await agent.generate('first', { traceId: '', parentSpanId: '' });
    await agent.generate('second', { traceId: '', parentSpanId: PARENT });

    const runs = memory.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.traceId).toMatch(TRACE_ID);
      expect(run.parentSpanId).toBeUndefined();
    }
    // 各自起新 trace,互不续接
    expect(runs[0]?.traceId).not.toBe(runs[1]?.traceId);
  });

  it('采样函数收到续接的外部 parent;起新 trace 时收到 undefined', async () => {
    const parents: Array<{ traceId: string; parentSpanId?: string } | undefined> = [];
    const memory = memoryExporter();
    const tracer = createTracer({
      exporters: [memory],
      sampler: (parent) => {
        parents.push(parent);
        return true;
      },
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'a' }, { text: 'b' }]),
      tracer,
    });

    await agent.generate('continued', { traceId: TRACE, parentSpanId: PARENT });
    await agent.generate('fresh');

    expect(parents).toEqual([{ traceId: TRACE, parentSpanId: PARENT }, undefined]);
  });

  it('parentSpanId 无 traceId:tracer 在 run 起点显式报错(不静默起新 trace)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'hi' }]),
      tracer,
    });

    await expect(agent.generate('Hi.', { parentSpanId: PARENT })).rejects.toThrow(/traceId/);
  });
});

describe('run option:hideInput / hideOutput 覆盖', () => {
  const PROMPT = [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
  ];

  it('run option 覆盖 tracer 默认:hideInput 擦掉整条 trace 的 input,output 保留', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] }); // 默认不擦
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: { q: 'x' } }] },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
      tracer,
    });

    await agent.generate('Hi.', { hideInput: true });

    // 三边界全部生效(子代继承 root 的决定),exporters 看不到被擦字段
    expect(memory.events.map((event) => event.span.type)).toContain(TOOL_CALL_SPAN);
    for (const event of memory.events) expect(event.span).not.toHaveProperty('input');
    expect(spanOfType(memory, AGENT_RUN_SPAN).output).toBe('done');
    expect(spanOfType(memory, TOOL_CALL_SPAN).output).toBe('ok');
  });

  it('反向覆盖:tracer 默认 hideInput,run option hideInput: false 恢复 input、擦 output', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'hello' }]),
      tracer,
    });

    await agent.generate('Hi.', { hideInput: false, hideOutput: true });

    for (const event of memory.events) expect(event.span).not.toHaveProperty('output');
    expect(spanOfType(memory, AGENT_RUN_SPAN).input).toEqual(PROMPT);
  });
});

describe('不挂 tracer:零开销', () => {
  it('一整轮带工具的 run 不创建任何 span 对象(不触碰 span id 生成)', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
    });
    // span / trace id 由 crypto.getRandomValues 生成(runId 走 randomUUID,不受影响);不挂 tracer
    // 时这个生成器一次都不应被碰到——这是“无 span 对象创建”可观察的边界。
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

    try {
      const result = await agent.generate('Go.');
      expect(result.text).toBe('done');
      expect(getRandomValues).not.toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it('对照:挂上 tracer 后同一路径确实生成 span id(探针可观测,不是恒假)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'done' }]),
      tracer,
    });
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

    try {
      await agent.generate('Go.');
      expect(getRandomValues).toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
    }
  });
});

describe('采样不通过:全树 NoOpSpan', () => {
  it('sampler never 时三边界不开 span,工具 ctx 的 traceId / spanId 仍为空串', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], sampler: 'never' });
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    const seen: ToolContext[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        probe: {
          description: 'Probes.',
          execute: (_input, ctx) => {
            seen.push(ctx);
            return 'ok';
          },
        },
      },
      tracer,
    });

    const result = await agent.generate('Go.');

    expect(result.text).toBe('done');
    expect(memory.events).toEqual([]);
    expect(seen[0]?.traceId).toBe('');
    expect(seen[0]?.spanId).toBe('');
  });
});

describe('整树:agent-run → agent-step → tool-call 的结构与三事件序列', () => {
  it('两次 step 一次工具调用:生命周期包含关系正确,每个 span started → … → ended', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
      tracer,
    });

    await agent.generate('Go.');

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const steps = memory.spans().filter((span) => span.type === AGENT_STEP_SPAN);
    const tool = spanOfType(memory, TOOL_CALL_SPAN);
    const [firstStep, secondStep] = steps;
    if (firstStep === undefined || secondStep === undefined) throw new Error('expected two step spans');

    const at = (kind: string, id: string): number =>
      memory.events.findIndex((event) => event.kind === kind && event.span.id === id);
    // 父子生命周期:父先开、子先结;同层按执行顺序
    expect(at('span_started', run.id)).toBeLessThan(at('span_started', firstStep.id));
    expect(at('span_started', firstStep.id)).toBeLessThan(at('span_started', tool.id));
    expect(at('span_ended', tool.id)).toBeLessThan(at('span_ended', firstStep.id));
    expect(at('span_ended', firstStep.id)).toBeLessThan(at('span_started', secondStep.id));
    expect(at('span_ended', secondStep.id)).toBeLessThan(at('span_ended', run.id));

    // 每个 span 恰好一次 span_started 与一次 span_ended,且 ended 是最后一个事件
    for (const span of [run, firstStep, secondStep, tool]) {
      const kinds = memory.events
        .filter((event) => event.span.id === span.id)
        .map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'span_started')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'span_ended')).toHaveLength(1);
      expect(kinds.at(-1)).toBe('span_ended');
    }
  });
});
