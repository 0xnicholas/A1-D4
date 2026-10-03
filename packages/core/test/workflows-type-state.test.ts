import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@oribos/core/workflows';
import type { Step, Workflow, WorkflowBuilder } from '@oribos/core/workflows';
import { expectAssignable } from './helpers/assertions.js';

/**
 * type-state 链(M3 #47,`docs/architecture/workflows.md`「Workflow 与 builder」):`TPrevSchema` 逐链
 * 传递——只 then 主轴严格(上一步 output 必须被下一步 input schema 接受);parallel / branch 用 keyed
 * 对象推断;foreach 数组;循环透传;sleep 不变;builder 与 committed Workflow 分界。
 *
 * 全部断言在编译期生效(tsc 阶段),运行期只建对象不执行:
 * - 正向用例用 `expectAssignable`;
 * - 反向用例用 `@ts-expect-error`(错误发生即通过;类型意外放宽则报 unused directive)。
 * 每条链都从工厂取新 builder——builder 可变,commit 后即冻结(定义面语义,见 surface 测试)。
 */
const topicInput = z.object({ topic: z.string() });
const articleOutput = z.object({ polished: z.string() });

const draft = createStep({
  id: 'draft',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ draft: z.string() }),
  execute: ({ inputData }) => ({ draft: inputData.topic }),
});
const polish = createStep({
  id: 'polish',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.object({ polished: z.string() }),
  execute: ({ inputData }) => ({ polished: inputData.draft }),
});
const factCheck = createStep({
  id: 'fact-check',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.object({ checked: z.boolean() }),
  execute: () => ({ checked: true }),
});
const revise = createStep({
  id: 'revise',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.object({ revised: z.string() }),
  execute: ({ inputData }) => ({ revised: inputData.draft }),
});
const article = () => createWorkflow({ id: 'article', inputSchema: topicInput, outputSchema: articleOutput });

describe('type-state:then 主轴严格', () => {
  it('首步 input 必须接受 workflow 输入;后续步接受上一步 output', () => {
    const wf = article().then(draft).then(polish).commit();

    expectAssignable<Workflow<typeof topicInput, typeof articleOutput>>(wf);
    expect(wf.entries).toHaveLength(2);
  });

  it('下一步 input 是上一步 output 的宽松形状(多收)也通过', () => {
    const acceptExtra = createStep({
      id: 'accept-extra',
      inputSchema: z.object({ topic: z.string(), note: z.string().optional() }),
      outputSchema: z.object({ done: z.boolean() }),
      execute: () => ({ done: true }),
    });

    article().then(acceptExtra);
  });

  it('上一步 output 不被下一步 input schema 接受 = 编译错误', () => {
    // @ts-expect-error workflow 输入是 {topic},polish 要吃 {draft}
    article().then(polish);

    const chained = article().then(draft);
    // @ts-expect-error 上一步 output 是 {draft},draft 要吃 {topic}
    chained.then(draft);
  });
});

describe('type-state:parallel / branch 用 keyed 对象推断', () => {
  it('parallel:tip = { [step.id]: output },下游按 keyed 对象接', () => {
    const parallelDownstream = createStep({
      id: 'parallel-downstream',
      inputSchema: z.object({
        draft: z.object({ draft: z.string() }),
        'fact-check': z.object({ checked: z.boolean() }),
      }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });
    const wrongShape = createStep({
      id: 'wrong-shape',
      inputSchema: z.object({
        draft: z.object({ polished: z.string() }),
        'fact-check': z.object({ checked: z.boolean() }),
      }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });

    article().parallel([draft, factCheck]).then(parallelDownstream).commit();

    // @ts-expect-error keyed 值的形状由各 step 的 outputSchema 推出,不是别的形状
    article().parallel([draft, factCheck]).then(wrongShape);
  });

  it('branch:tip = 只有一个 key 有值的 keyed 对象(下游用 optional 字段接)', () => {
    const branchDownstream = createStep({
      id: 'branch-downstream',
      inputSchema: z.object({
        'fact-check': z.object({ checked: z.boolean() }).optional(),
        revise: z.object({ revised: z.string() }).optional(),
      }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });
    const requiredKey = createStep({
      id: 'required-key',
      inputSchema: z.object({ 'fact-check': z.object({ checked: z.boolean() }) }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });

    article()
      .then(draft)
      .branch([
        [() => true, factCheck],
        [(ctx) => ctx.inputData.draft.length > 3, revise],
      ])
      .then(branchDownstream)
      .commit();

    const branched = article()
      .then(draft)
      .branch([[(ctx) => ctx.inputData.draft.length > 3, factCheck]]);
    // @ts-expect-error 分支 key 可能没有值,下游当必填接 = 编译错误
    branched.then(requiredKey);
  });

  it('branch:cond 收当前 tip 数据(只读包),按定义序', () => {
    const badCond = article()
      .then(draft)
      // @ts-expect-error cond 的 inputData 是当前 tip,不是别的形状
      .branch([[(ctx) => ctx.inputData.missing === undefined, factCheck]]);

    article()
      .then(draft)
      .branch([
        [
          (ctx) => {
            expectAssignable<{ draft: string }>(ctx.inputData);
            return ctx.inputData.draft.length > 0;
          },
          factCheck,
        ],
      ])
      .commit();
    expect(badCond).toBeDefined();
  });
});

describe('type-state:foreach / 循环 / sleep', () => {
  it('foreach:tip = output 数组', () => {
    const arrayDownstream = createStep({
      id: 'array-downstream',
      inputSchema: z.array(z.object({ polished: z.string() })),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });
    const notArray = createStep({
      id: 'not-array',
      inputSchema: z.object({ polished: z.string() }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });

    article().then(draft).foreach(polish, { concurrency: 4 }).then(arrayDownstream).commit();

    const fannedOut = article().then(draft).foreach(polish);
    // @ts-expect-error 下游把数组当单值 = 编译错误
    fannedOut.then(notArray);
  });

  it('dowhile / dountil:tip = 最后一次迭代的输出;cond 收 iterationCount', () => {
    const loopDownstream = createStep({
      id: 'loop-downstream',
      inputSchema: z.object({ revised: z.string() }),
      outputSchema: articleOutput,
      execute: () => ({ polished: '' }),
    });

    article()
      .then(draft)
      .dowhile(revise, (ctx) => {
        expectAssignable<number>(ctx.iterationCount);
        expectAssignable<{ draft: string }>(ctx.inputData);
        return ctx.iterationCount < 3;
      })
      .dountil(revise, (ctx) => {
        expectAssignable<number>(ctx.iterationCount);
        expectAssignable<{ revised: string }>(ctx.inputData);
        return ctx.iterationCount > 0;
      })
      .then(loopDownstream)
      .commit();

    const looped = article().then(draft);
    // @ts-expect-error loop cond 的包里没有这个字段
    looped.dowhile(revise, (ctx) => ctx.missing === undefined);
  });

  it('sleep:tip 不变,链上可继续 then', () => {
    const wf = article().then(draft).sleep(200).sleep((ctx) => ctx.runId.length).then(polish).commit();

    expect(wf.entries.map((entry) => entry.type)).toEqual(['then', 'sleep', 'sleep', 'then']);
  });
});

describe('type-state:builder 与 committed Workflow 的分界', () => {
  it('createWorkflow 返回 builder;commit 返回 Workflow', () => {
    const builder = createWorkflow({ id: 'article', inputSchema: topicInput, outputSchema: articleOutput });

    expectAssignable<
      WorkflowBuilder<typeof topicInput, typeof articleOutput, typeof topicInput>
    >(builder);
    expectAssignable<Workflow<typeof topicInput, typeof articleOutput>>(builder.commit());
  });

  it('未 commit 不可 createRun:运行面只属于 commit 后的 Workflow(#48 落地)', () => {
    const builder = createWorkflow({ id: 'article', inputSchema: topicInput, outputSchema: articleOutput });

    // @ts-expect-error builder 不是可运行对象
    expectAssignable<{ createRun(): unknown }>(builder);
  });

  it('Step 容器视图接受带 resume / suspend schema 的具体步骤', () => {
    const withResume = createStep({
      id: 'approval',
      inputSchema: z.object({ request: z.string() }),
      outputSchema: z.object({ approved: z.boolean() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ question: z.string() }),
      execute: () => ({ approved: true }),
    });

    expectAssignable<Step[]>([]);
    expectAssignable<readonly Step[]>([draft, factCheck]);
    expectAssignable<readonly Step[]>([draft, withResume]);
  });
});
