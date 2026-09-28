import { describe, expect, it } from 'vitest';
import { Agent } from '@balsa/core/agent';
import type { AgentConfig, AgentRunOptions } from '@balsa/core/agent';
import { ModelContractError, ModelSpecificationVersionError } from '@balsa/core/model';
import type { Model } from '@balsa/core/model';
import { createTracer } from '@balsa/core/observability';
import { captureError, expectAssignable } from './helpers/assertions.js';
import { fakeModel } from './helpers/fake-model.js';

/**
 * Agent 五字段配置表面与解析期模型断言(M1-04 #25,ADR-0004/0005):
 * 表面之外无一物;模型 specificationVersion 不匹配在构造期(解析期)显式报错,不拖到运行中途。
 */
describe('Agent 五字段配置表面', () => {
  it('name / instructions / model 必填,tools / description 可选(静态值)', () => {
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
    });

    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
      tools: {
        search: { description: 'Searches the web.', execute: () => 'ok' },
        weather: {
          description: 'Looks up the weather.',
          execute: (input: { city: string }) => input.city,
        },
      },
      description: 'Answers questions about the knowledge base.',
    });
  });

  it('instructions 仅 string —— 数组 / 函数形状被类型拒绝', () => {
    // @ts-expect-error instructions 只接受 string
    expectAssignable<AgentConfig>({ name: 'a', instructions: ['You are concise.'], model: fakeModel([]) });
    // @ts-expect-error instructions 的动态函数形状留给 M1-10(#31)
    expectAssignable<AgentConfig>({ name: 'a', instructions: () => 'You are concise.', model: fakeModel([]) });
  });

  it('五字段之外无一物——多余字段被类型拒绝', () => {
    expectAssignable<AgentConfig>({
      name: 'a',
      instructions: 'You are concise.',
      model: fakeModel([]),
      // @ts-expect-error 六号字段不存在(memory 归 M2)
      memory: {},
    });
  });

  it('tracer 注入缝:横切依赖经配置传入(组合根分发或独立 new 显式传入),不进实例表面', () => {
    const tracer = createTracer({ exporters: [] });

    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      tracer,
    });

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      tracer,
    });
    // 注入缝不占实例表面(五字段之外无一物);挂上后自动埋点的断言在 agent-observability.test.ts
    expect(agent).not.toHaveProperty('tracer');
  });

  it('trace 续接与 hide 覆盖是 run option 的一部分', () => {
    expectAssignable<AgentRunOptions>({
      traceId: '0'.repeat(32),
      parentSpanId: '0'.repeat(16),
      hideInput: true,
      hideOutput: true,
    });
  });

  it('构造后的实例原样持有配置字段', () => {
    const model = fakeModel([{ text: 'hi' }]);
    const tools = { search: { description: 'Searches the web.', execute: () => 'ok' } };

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools,
      description: 'Answers questions.',
    });

    expect(agent.name).toBe('assistant');
    expect(agent.instructions).toBe('You are concise.');
    expect(agent.model).toBe(model);
    expect(agent.tools).toBe(tools);
    expect(agent.description).toBe('Answers questions.');
  });

  it('缺省 tools / description 时两者为 undefined', () => {
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
    });

    expect(agent.tools).toBeUndefined();
    expect(agent.description).toBeUndefined();
  });
});

describe('解析期模型断言', () => {
  /** 结构上像模型、但 spec 版本属于上一代的实例(模拟旧 provider 包)。 */
  function outdatedModel(): unknown {
    return {
      specificationVersion: 'v3',
      provider: 'openai',
      modelId: 'gpt-4o',
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    };
  }

  it('specificationVersion 不匹配:构造 Agent 即抛显式错误(不是运行中途)', () => {
    const error = captureError(
      () =>
        new Agent({
          name: 'assistant',
          instructions: 'You are concise.',
          model: outdatedModel() as Model,
        }),
    );

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'v3'");
    expect(error.message).toContain("'v4'");
    expect(error.message).toMatch(/upgrade the provider package/);
  });

  it('不是语言模型(如 embedding 模型):构造 Agent 即抛契约错误', () => {
    expect(
      () =>
        new Agent({
          name: 'assistant',
          instructions: 'You are concise.',
          model: { specificationVersion: 'v4', provider: 'openai', modelId: 'text-embedding-3-small' } as Model,
        }),
    ).toThrow(ModelContractError);
  });

});
