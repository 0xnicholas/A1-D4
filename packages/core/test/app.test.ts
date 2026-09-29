import { describe, expect, it } from 'vitest';
import { createApp } from '@balsa/core';
import type { App, AppConfig } from '@balsa/core';
import { Agent } from '@balsa/core/agent';
import type { AgentConfig } from '@balsa/core/agent';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@balsa/core/observability';
import { expectAssignable } from './helpers/assertions.js';
import { INSTRUCTIONS } from './helpers/agent.js';
import { fakeModel } from './helpers/fake-model.js';
import { spanOfType, withSpanIdProbe } from './helpers/spans.js';

/**
 * 组合根(M1-15 #36,ADR-0002):`createApp({ tracer })` 是可选薄组装点,把横切依赖分发给挂上来的
 * 子系统——经 `app.agent(config)` 建出的 Agent 被动接受分发的 tracer,无需逐 agent 传入;独立
 * `new Agent` 不挂组合根仍是一等用法,缺席零开销。M1 只分发 tracer(logger/storage 的位留给后续
 * 里程碑)。断言只走公开面(根入口与子路径导出)与规范钦定的 memory exporter 抓手(issue #21
 * 测试决策)。
 */
describe('createApp:横切依赖分发', () => {
  it('经 app.agent() 建出的 agent 无需逐 agent 传 tracer:run 自动开三边界 span', async () => {
    const memory = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [memory] }) });
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: { q: 'x' } }],
      },
      { text: 'done' },
    ]);

    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
    });

    const result = await agent.generate('Go.');

    expect(result.text).toBe('done');
    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const step = spanOfType(memory, AGENT_STEP_SPAN);
    const tool = spanOfType(memory, TOOL_CALL_SPAN);
    expect(run.name).toBe('assistant');
    expect(run.attributes).toEqual({ agentName: 'assistant', runId: expect.any(String) });
    // 子树沿显式 parent 传播:step 挂 run,tool 挂所属 step
    expect(step.parentSpanId).toBe(run.id);
    expect(tool.parentSpanId).toBe(step.id);
    expect(tool.traceId).toBe(run.traceId);
  });

  it('同一 app 的多个 agent 共用分发的 tracer:各自 run 都落在同一 exporter', async () => {
    const memory = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [memory] }) });
    const first = app.agent({
      name: 'first',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'a' }]),
    });
    const second = app.agent({
      name: 'second',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'b' }]),
    });

    await Promise.all([first.generate('Hi.'), second.generate('Hi.')]);

    const runs = memory.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runs.map((run) => run.name).sort()).toEqual(['first', 'second']);
  });

  it('AgentConfig 自带的 tracer 优先于组合根分发:显式装配不被接管', async () => {
    const byApp = memoryExporter();
    const byAgent = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [byApp] }) });
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'done' }]),
      tracer: createTracer({ exporters: [byAgent] }),
    });

    await agent.generate('Hi.');

    expect(byApp.events).toEqual([]);
    expect(spanOfType(byAgent, AGENT_RUN_SPAN).name).toBe('assistant');
  });
});

describe('不挂组合根:一等用法与零开销', () => {
  it('app.agent() 建出真正的 Agent:五字段原样,动态字段照常逐次解析', async () => {
    const model = fakeModel([{ text: 'done' }]);
    const agent = createApp().agent({
      name: 'assistant',
      instructions: (ctx) => `tenant ${String(ctx.tenant)}`,
      model,
      description: 'Answers.',
    });

    expect(agent).toBeInstanceOf(Agent);
    expect(agent.name).toBe('assistant');
    const result = await agent.generate('Hi.', { tenant: 'acme' });
    expect(result.text).toBe('done');
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: 'tenant acme' },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
  });

  it('组合根缺席与独立 new Agent 同一零开销:一整轮带工具的 run 都不创建任何 span 对象', async () => {
    const viaApp = createApp().agent(noTracerRun('via-app'));
    // 不挂组合根的独立用法(本票不改 Agent 代码):与组合根路径在同一探针下对照
    const standalone = new Agent(noTracerRun('standalone'));

    const appRun = await withSpanIdProbe(() => viaApp.generate('Go.'));
    const standaloneRun = await withSpanIdProbe(() => standalone.generate('Go.'));

    expect(appRun.result.text).toBe('done');
    expect(standaloneRun.result.text).toBe('done');
    expect([appRun.spanIdsCreated, standaloneRun.spanIdsCreated]).toEqual([false, false]);
  });
});

describe('组合根类型表面', () => {
  it('AppConfig 全字段可选;M1 只分发 tracer,logger/storage 的位不提前开', () => {
    expectAssignable<AppConfig>({});
    expectAssignable<AppConfig>({ tracer: createTracer({ exporters: [] }) });
    // @ts-expect-error M1 只分发 tracer:logger 的位留给后续里程碑
    expectAssignable<AppConfig>({ logger: {} });
  });

  it('App 暴露 agent 工厂;工厂接受完整 AgentConfig(含动态形状)', () => {
    const app: App = createApp();

    expectAssignable<Agent>(
      app.agent({ name: 'assistant', instructions: 'You are concise.', model: fakeModel([]) }),
    );
    expectAssignable<Agent>(
      app.agent({
        name: 'assistant',
        instructions: (ctx) => `tenant ${String(ctx.tenant)}`,
        model: () => fakeModel([]),
        tools: async () => ({ probe: { description: 'Probes.', execute: () => 'ok' } }),
      }),
    );
  });
});

/** 一次带工具调用的无 tracer run 配置;组合根路径与独立 new 路径各用一份模型实例。 */
function noTracerRun(name: string): AgentConfig {
  return {
    name,
    instructions: INSTRUCTIONS,
    model: fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]),
    tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
  };
}
