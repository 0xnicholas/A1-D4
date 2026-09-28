import { describe, expect, it } from 'vitest';
import { Agent } from '@balsa/core/agent';
import type { ModelSettings } from '@balsa/core/agent';
import { ModelContractError } from '@balsa/core/model';
import type { ModelMessage } from '@balsa/core/model';
import { fakeModel } from './helpers/fake-model.js';

/**
 * generate() 文本闭环(M1-04 #25):Agent 挂单个模型实例,generate() 把自有 chunk 协议流收敛
 * 为 text / usage / finishReason。断言只走公开面(`@balsa/core/agent`)与脚本化假模型接缝
 * (@see helpers/fake-model.ts),不触内部实现。
 */
describe('Agent.generate:纯文本闭环', () => {
  it('脚本化假模型的文本回答收敛为 text / usage / finishReason', async () => {
    const model = fakeModel([
      { text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 7 } },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
    });

    const result = await agent.generate('Say hi.');

    expect(result).toEqual({
      text: 'Hello',
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      finishReason: 'stop',
    });
  });

  it('发给模型的 prompt = instructions(system)+ 输入(user 文本)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
    });

    await agent.generate('Say hi.');

    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hi.' }] },
    ]);
  });

  it('Message[] 输入原样直通 vendor prompt 类型,instructions 仍为前置 system 消息', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
    });
    const history: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];

    await agent.generate(history);

    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      ...history,
    ]);
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['error', 'error'],
  ] as const)('模型报告 finish reason %s 时终值为 %s', async (reported, expected) => {
    const model = fakeModel([{ text: 'partial', finishReason: reported }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    const result = await agent.generate('Say hi.');

    expect(result.finishReason).toBe(expected);
  });

  it('模型流中途报错:generate() 以该错误拒绝,不返回半截结果', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    await expect(agent.generate('Say hi.')).rejects.toThrow('upstream exploded');
  });

  it('模型流没有 finish part 时显式报契约错误,不静默给默认值', async () => {
    const model = fakeModel([{ text: 'no finish', omitFinish: true }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    await expect(agent.generate('Say hi.')).rejects.toThrow(ModelContractError);
  });
});

describe('Agent.generate:执行选项透传', () => {
  it('modelSettings 透传至模型调用(prompt 之外的字段原样带过去)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    await agent.generate('Say hi.', {
      modelSettings: { temperature: 0.4, maxOutputTokens: 64, topP: 0.9 },
    });

    expect(model.streamCalls[0]).toMatchObject({
      temperature: 0.4,
      maxOutputTokens: 64,
      topP: 0.9,
    });
  });

  it('providerOptions 原样透传至模型调用', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    await agent.generate('Say hi.', { providerOptions: { fake: { trace: 'on' } } });

    expect(model.streamCalls[0]?.providerOptions).toEqual({ fake: { trace: 'on' } });
  });

  it('modelSettings 不能覆盖框架写入的字段(prompt / abortSignal 归框架)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });
    const controller = new AbortController();
    const hijack = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hijacked' }] }],
      abortSignal: new AbortController().signal,
    } as unknown as ModelSettings;

    await agent.generate('Say hi.', { modelSettings: hijack, signal: controller.signal });

    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Say hi.' }] },
    ]);
    expect(model.streamCalls[0]?.abortSignal).toBe(controller.signal);
  });

  it('per-call signal 原样传给模型调用', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });
    const controller = new AbortController();

    await agent.generate('Say hi.', { signal: controller.signal });

    expect(model.streamCalls[0]?.abortSignal).toBe(controller.signal);
  });

  it('调用前已中止的 signal:generate() 以中止原因拒绝', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });
    const controller = new AbortController();
    controller.abort(new Error('cancelled by host'));

    await expect(agent.generate('Say hi.', { signal: controller.signal })).rejects.toThrow(
      'cancelled by host',
    );
  });

  it('不传执行选项时模型调用只带 prompt', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    await agent.generate('Say hi.');

    expect(model.streamCalls[0]).toEqual({
      prompt: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: [{ type: 'text', text: 'Say hi.' }] },
      ],
    });
  });
});
