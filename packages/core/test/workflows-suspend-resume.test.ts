import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemorySnapshotStore, createStep, createWorkflow } from '@balsa/core/workflows';
import type {
  StepContext,
  Workflow,
  WorkflowResumeOptions,
  WorkflowRunOutcome,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@balsa/core/workflows';
import { captureRejection, expectAssignable, expectSuccess, expectSuspended } from './helpers/assertions.js';

/**
 * suspend/resume(M3 #51,`docs/architecture/workflows.md`「suspend/resume 与快照」):suspend 控制
 * 信号 + step 边界 JSON 快照 + `WorkflowSnapshotStore` port(内存 Map 默认实现)、固定持久化时机
 * (有 storage 时每个条目完成 + suspend + 终态)、`run.resume({ step, resumeData? })` 的 load →
 * resumeSchema 校验 → 从 position 重进、resume 进程内锁去重。
 *
 * 本票裁决(v1):suspend 只在**顶层 then 条目**的 step 内成立;parallel / branch / foreach /
 * dowhile / dountil 体内调用 suspend 显式报错(该边界的 `step-end` 读 `failed`、记录不落
 * `suspended`,归一 workflows-events;迭代现场语义按地图升级为新 ticket)。
 *
 * 接缝 = 公开 `@balsa/core/workflows` 子路径:定义 → `createRun` → `run.start` / `run.resume`,
 * 以及 step `execute` 收到的 ctx 与注入的 store 观察到的快照。
 */

const topicInput = z.object({ topic: z.string() });
const draftOutput = z.object({ draft: z.string() });
const articleOutput = z.object({ polished: z.string() });

/** 记录每次 save 的快照(深拷贝,模拟真实序列化后端),load 返回最近一份。 */
function recordingStore(): {
  readonly store: WorkflowSnapshotStore;
  readonly saves: WorkflowRunSnapshot[];
} {
  const saves: WorkflowRunSnapshot[] = [];
  let latest: WorkflowRunSnapshot | null = null;
  return {
    saves,
    store: {
      load: async (runId) =>
        latest !== null && latest.runId === runId ? structuredClone(latest) : null,
      save: async (_runId, snapshot) => {
        saves.push(structuredClone(snapshot));
        latest = snapshot;
      },
    },
  };
}

/** draft → approval(suspend) → polish 三条目链:主轴的挂起/恢复叙事。 */
function approvalWorkflow(options: { readonly storage?: WorkflowSnapshotStore } = {}): {
  readonly workflow: Workflow<typeof topicInput, typeof articleOutput>;
  readonly draftExecute: ReturnType<typeof vi.fn>;
  readonly approvalExecute: ReturnType<typeof vi.fn>;
  readonly polishExecute: ReturnType<typeof vi.fn>;
} {
  const draftExecute = vi.fn((ctx: StepContext<{ topic: string }>) => ({
    draft: ctx.inputData.topic.toUpperCase(),
  }));
  const draft = createStep({
    id: 'draft',
    inputSchema: topicInput,
    outputSchema: draftOutput,
    execute: draftExecute,
  });
  const approvalExecute = vi.fn(
    (ctx: StepContext<{ draft: string }, { approved: boolean }, { question: string }>) => {
      if (ctx.resumeData === undefined) {
        ctx.suspend({ question: `approve ${ctx.inputData.draft}?` });
      }
      return { polished: `${ctx.inputData.draft}:${String(ctx.resumeData.approved)}` };
    },
  );
  const approval = createStep({
    id: 'approval',
    inputSchema: draftOutput,
    outputSchema: articleOutput,
    resumeSchema: z.object({ approved: z.boolean() }),
    suspendSchema: z.object({ question: z.string() }),
    execute: approvalExecute,
  });
  const polishExecute = vi.fn((ctx: StepContext<{ polished: string }>) => ({
    polished: `«${ctx.inputData.polished}»`,
  }));
  const polish = createStep({
    id: 'polish',
    inputSchema: articleOutput,
    outputSchema: articleOutput,
    execute: polishExecute,
  });
  const workflow = createWorkflow({
    id: 'article',
    inputSchema: topicInput,
    outputSchema: articleOutput,
    ...options,
  })
    .then(draft)
    .then(approval)
    .then(polish)
    .commit();
  return { workflow, draftExecute, approvalExecute, polishExecute };
}

describe('suspend:控制信号展开 + 记录 + 终态信封', () => {
  it('suspend(payload) 展开 run:result 落 suspended 信封,当前 step 记录 suspended,后续条目不执行', async () => {
    const { workflow, approvalExecute, polishExecute } = approvalWorkflow();
    const before = Date.now();

    const outcome = expectSuspended(
      await workflow.createRun().start({ inputData: { topic: 'ts' } }).result,
    );
    const after = Date.now();
    // 挂起点:信封点名 step,后续条目不再执行
    expect(outcome.stepId).toBe('approval');
    expect(approvalExecute).toHaveBeenCalledTimes(1);
    expect(polishExecute).not.toHaveBeenCalled();

    expect(Object.keys(outcome.stepResults)).toEqual(['draft', 'approval']);
    const record = outcome.stepResults['approval'];
    expect(record?.status).toBe('suspended');
    expect(record?.suspendPayload).toEqual({ question: 'approve TS?' });
    // 挂起的 step 没有 output(未完成)
    expect(record !== undefined && 'output' in record).toBe(false);
    expect(record?.startedAt).toBeGreaterThanOrEqual(before);
    expect(record?.endedAt).toBeLessThanOrEqual(after);
    // 前序条目照常记录
    expect(outcome.stepResults['draft']).toMatchObject({
      status: 'success',
      output: { draft: 'TS' },
    });
  });

  it('suspend 不经过重试:挂起不是失败,retries 不重跑挂起的 step', async () => {
    const execute = vi.fn((ctx: StepContext<{ draft: string }, undefined, { question: string }>) =>
      ctx.suspend({ question: 'anyone?' }),
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      retries: 3,
      execute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();

    const outcome = await workflow.createRun().start({ inputData: { draft: 'ts' } }).result;

    expect(outcome.status).toBe('suspended');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('无 storage 即纯内存:内存默认实现让同一 run 的 suspend → resume 跑通', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();

    const run = workflow.createRun();
    const suspended = expectSuspended(await run.start({ inputData: { topic: 'ts' } }).result);
    expect(suspended.stepId).toBe('approval');

    const outcome = expectSuccess(
      await run.resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(outcome.output).toEqual({ polished: '«TS:true»' });
    expect(approvalExecute).toHaveBeenCalledTimes(2);
  });
});

describe('快照形状与持久化时机', () => {
  it('字段恰为 {runId,status,input,stepResults,position}:input 是校验后的运行输入,position = 重进下标', async () => {
    const input = z.object({ topic: z.string().transform((value) => value.toUpperCase()) });
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ topic: string }, { approved: boolean }, { question: string }>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'go?' });
        return { polished: `${ctx.inputData.topic}:${String(ctx.resumeData.approved)}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ question: z.string() }),
      execute: approvalExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: input,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(approval)
      .commit();

    const runId = 'shape-run';
    const run = workflow.createRun({ runId });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const suspended = saves.at(-1);
    expect(suspended).toEqual({
      runId,
      status: 'suspended',
      // 校验后的输入(transform 已生效),不是原始 inputData
      input: { topic: 'TS' },
      stepResults: {
        approval: {
          status: 'suspended',
          suspendPayload: { question: 'go?' },
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
        },
      },
      // position = 挂起条目下标(从该条目重进);startIdx 等价物
      position: 0,
    });

    await run.resume({ step: approval, resumeData: { approved: false } });

    // resume 后重进的 tip 来自快照的校验输入(不重跑 transform,也不重复校验 start 输入)
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { topic: 'TS' }, resumeData: { approved: false } }),
    );
    expect(saves.at(-1)).toMatchObject({
      runId,
      status: 'success',
      input: { topic: 'TS' },
      position: 1,
      stepResults: { approval: { status: 'success', output: { polished: 'TS:false' } } },
    });
  });

  it('有 storage:每个条目完成后写 running 快照(position = 下一条目),suspend / 终态固定写', async () => {
    const { store, saves } = recordingStore();
    const { workflow } = approvalWorkflow({ storage: store });

    const run = workflow.createRun({ runId: 'timing-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;
    expect(saves.map((snapshot) => [snapshot.status, snapshot.position])).toEqual([
      ['running', 1],
      ['suspended', 1],
    ]);

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(saves.map((snapshot) => [snapshot.status, snapshot.position])).toEqual([
      ['running', 1],
      ['suspended', 1],
      ['running', 2],
      ['running', 3],
      ['success', 3],
    ]);
    // running 快照带已完成条目的记录(每步 status / output / 起止时间)
    expect(saves[0]?.stepResults['draft']).toMatchObject({
      status: 'success',
      output: { draft: 'TS' },
    });
    expect(saves.at(-1)?.stepResults['polish']).toMatchObject({ status: 'success' });
  });

  it('失败终态写:step 抛错 → failed 快照(position = 失败条目),原错误原样拒绝', async () => {
    const boom = new Error('boom');
    const brokenExecute = vi.fn(() => {
      throw boom;
    });
    const broken = createStep({
      id: 'broken',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      execute: brokenExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(broken)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun({ runId: 'failed-run' }).start({ inputData: { topic: 'ts' } }).result,
    );

    expect(error).toBe(boom);
    expect(saves.map((snapshot) => snapshot.status)).toEqual(['failed']);
    expect(saves[0]).toMatchObject({ position: 0, stepResults: { broken: { status: 'failed' } } });
  });
});

describe('run.resume:load 快照 → resumeData 校验 → 从 position 重进', () => {
  it('恢复挂起条目:resumeData 过 resumeSchema、前序条目回放、后续条目继续', async () => {
    const { workflow, draftExecute, approvalExecute, polishExecute } = approvalWorkflow();
    const run = workflow.createRun({ runId: 'resume-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = expectSuccess(
      await run.resume({
        step: 'approval',
        resumeData: { approved: true },
      }),
    );

    expect(outcome.output).toEqual({ polished: '«TS:true»' });
    expect(outcome.stepResults['approval']).toMatchObject({
      status: 'success',
      output: { polished: 'TS:true' },
    });
    // 前序条目只执行一次(记录回放,不重跑);挂起 step 两次(挂起 + 恢复);后续条目恢复后继续
    expect(draftExecute).toHaveBeenCalledTimes(1);
    expect(approvalExecute).toHaveBeenCalledTimes(2);
    expect(polishExecute).toHaveBeenCalledTimes(1);
    // 恢复的 step 拿到的 inputData 是回放的 tip(上一条目记录输出)
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { draft: 'TS' }, resumeData: { approved: true } }),
    );
  });

  it('resumeData 过 resumeSchema 的返回值替换原数据(default 生效)', async () => {
    let seen: unknown;
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ draft: string }, { approved: boolean; note: string }, unknown>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'go?' });
        seen = ctx.resumeData;
        return { polished: ctx.inputData.draft };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({
        approved: z.boolean(),
        note: z.string().default('none'),
      }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { draft: 'ts' } }).result;

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(seen).toEqual({ approved: true, note: 'none' });
  });

  it('tip 回放:then / parallel / sleep 前缀的已记录输出重建 tip,一条都不重跑', async () => {
    const aExecute = vi.fn((ctx: StepContext<{ topic: string }>) => ({
      a: ctx.inputData.topic.length,
    }));
    const a = createStep({
      id: 'a',
      inputSchema: topicInput,
      outputSchema: z.object({ a: z.number() }),
      execute: aExecute,
    });
    const bExecute = vi.fn(() => ({ b: 'b' }));
    const b = createStep({
      id: 'b',
      inputSchema: topicInput,
      outputSchema: z.object({ b: z.string() }),
      execute: bExecute,
    });
    const approvalExecute = vi.fn(
      (
        ctx: StepContext<
          { a: { a: number }; b: { b: string } },
          { approved: boolean },
          { question: string }
        >,
      ) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'bundle ok?' });
        return { polished: `${String(ctx.inputData.a.a)}:${ctx.inputData.b.b}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: z.object({
        a: z.object({ a: z.number() }),
        b: z.object({ b: z.string() }),
      }),
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .parallel([a, b])
      .sleep(1)
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(outcome.status).toBe('success');
    // parallel 的 keyed 输出 + sleep 透传,全部由记录回放
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { a: { a: 2 }, b: { b: 'b' } } }),
    );
    expect(aExecute).toHaveBeenCalledTimes(1);
    expect(bExecute).toHaveBeenCalledTimes(1);
  });

  it('tip 回放:branch 前缀取已执行臂的记录(条件不重估、臂不重跑)', async () => {
    const cond = vi.fn(() => true);
    const armExecute = vi.fn((ctx: StepContext<{ draft: string }>) => ({
      revised: `r:${ctx.inputData.draft}`,
    }));
    const arm = createStep({
      id: 'revise',
      inputSchema: draftOutput,
      outputSchema: z.object({ revised: z.string() }),
      execute: armExecute,
    });
    const approvalExecute = vi.fn(
      (
        ctx: StepContext<
          { revise?: { revised: string } | undefined },
          { approved: boolean },
          { question: string }
        >,
      ) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
        return { polished: ctx.inputData.revise?.revised ?? '' };
      },
    );
    const approval = createStep({
      id: 'approval',
      // branch 块的 keyed 输出每个键都可缺席(未执行分支无值),下游按 optional 接
      inputSchema: z.object({ revise: z.object({ revised: z.string() }).optional() }),
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: draftOutput,
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .branch([[cond, arm]])
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(outcome.status).toBe('success');
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { revise: { revised: 'r:ts' } } }),
    );
    expect(cond).toHaveBeenCalledTimes(1);
    expect(armExecute).toHaveBeenCalledTimes(1);
  });

  it('恢复的 step 看得到前序记录:getStepResult 从快照种子恢复', async () => {
    let seenDraft: unknown;
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ draft: string }, { approved: boolean }, unknown>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
        seenDraft = ctx.getStepResult('draft');
        return { polished: ctx.inputData.draft };
      },
    );
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: draftOutput,
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(seenDraft).toEqual({ draft: 'ts' });
  });

  it('resumeData 校验失败(第三处 IO):带 stepId 的 WorkflowValidationError,execute 不执行且快照仍可恢复', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: 'yes' } }),
    );

    expect(error.name).toBe('WorkflowValidationError');
    expect((error as { stepId?: string }).stepId).toBe('approval');
    expect(error.message).toMatch(/resumeSchema/);
    expect(approvalExecute).toHaveBeenCalledTimes(1);

    // 校验失败不消费挂起快照:换合法 resumeData 仍可恢复
    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });
    expect(outcome.status).toBe('success');
  });

  it('无 resumeSchema 的 step 不接受 resumeData(显式报错,不静默丢弃);不传 resumeData 则可恢复', async () => {
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      execute: (ctx: StepContext<{ draft: string }, undefined, { question: string }>) =>
        ctx.suspend({ question: 'ok?' }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { draft: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/resumeSchema/);
    const outcome = await run.resume({ step: 'approval' });
    expect(outcome.status).toBe('suspended');
  });

  it('resume 目标校验:step 名不是挂起 step → 显式报错,不执行任何 step', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'polish', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/approval/);
    expect(error.message).toMatch(/polish/);
    expect(approvalExecute).toHaveBeenCalledTimes(1);
  });

  it('resume 非挂起 run:未启动(无快照)与终态都显式报错', async () => {
    const { workflow } = approvalWorkflow();

    const neverStarted = await captureRejection(() =>
      workflow.createRun({ runId: 'never-started' }).resume({ step: 'approval' }),
    );
    expect(neverStarted.message).toMatch(/never-started/);
    expect(neverStarted.message).toMatch(/snapshot/);

    const run = workflow.createRun({ runId: 'finished' });
    await run.start({ inputData: { topic: 'ts' } }).result;
    await run.resume({ step: 'approval', resumeData: { approved: true } });
    const afterSuccess = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true } }),
    );
    expect(afterSuccess.message).toMatch(/success/);
    expect(afterSuccess.message).toMatch(/suspended/);
  });

  it('快照与定义不匹配:position 指向的不是挂起 step 的 then 条目 → 显式报错(快照不被消费)', async () => {
    const store: WorkflowSnapshotStore = {
      load: async () => ({
        runId: 'stale',
        status: 'suspended',
        input: { draft: 'ts' },
        stepResults: { approval: { status: 'suspended', suspendPayload: { question: 'go?' } } },
        position: 0,
      }),
      save: async () => {},
    };
    const replaced = createStep({
      id: 'replaced',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      execute: () => ({ polished: 'x' }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(replaced)
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'stale' }).resume({ step: 'approval', resumeData: {} }),
    );

    expect(error.message).toMatch(/approval/);
    expect(error.message).toMatch(/position 0/);
  });

  it('无 storage 的内存默认按 run 对象持有:新 run 对象恢复报 no snapshot(跨对象要接真实 storage)', async () => {
    const { workflow } = approvalWorkflow();
    const runId = 'memory-only';
    await workflow.createRun({ runId }).start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      workflow.createRun({ runId }).resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/no snapshot/);
  });

  it('resume 并发去重:同一 runId 的并发 resume 返回同一 promise,step 只恢复一次', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun({ runId: 'dedupe-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const first = run.resume({ step: 'approval', resumeData: { approved: true } });
    const second = run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(second).toBe(first);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.status).toBe('success');
    expect(secondOutcome.status).toBe('success');
    expect(approvalExecute).toHaveBeenCalledTimes(2);
  });

  it('resume 进程内锁在失败后释放:中止的 resume 不消费快照,下一次仍可恢复', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;
    const controller = new AbortController();
    controller.abort();

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true }, signal: controller.signal }),
    );

    expect(error.name).toBe('AbortError');
    expect(approvalExecute).toHaveBeenCalledTimes(1);

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });
    expect(outcome.status).toBe('success');
  });

  it('resume 走 storage 的跨 run 对象路径:同一 runId 新 run 恢复,requestContext 传给 resumed step', async () => {
    const { store } = recordingStore();
    const { workflow, approvalExecute } = approvalWorkflow({ storage: store });
    const runId = 'durable-run';
    await workflow.createRun({ runId }).start({ inputData: { topic: 'ts' } }).result;

    const resumed = workflow.createRun({ runId });
    const outcome = await resumed.resume({
      step: 'approval',
      resumeData: { approved: true },
      requestContext: { userId: 'u-1' },
    });

    expect(outcome.status).toBe('success');
    const lastCtx = approvalExecute.mock.calls.at(-1)?.[0] as
      | { readonly requestContext: { readonly userId?: unknown; readonly runId?: unknown } }
      | undefined;
    expect(lastCtx?.requestContext['userId']).toBe('u-1');
    expect(lastCtx?.requestContext['runId']).toBe(runId);
  });

  it('再次挂起:resume 后 step 再 suspend → 再落 suspended 快照,可二次 resume', async () => {
    const rounds: number[] = [];
    const execute = vi.fn(
      (
        ctx: StepContext<{ draft: string }, { verdict: string; round: number }, { round: number }>,
      ) => {
        rounds.push(ctx.resumeData?.round ?? 0);
        if (ctx.resumeData === undefined) ctx.suspend({ round: 1 });
        if (ctx.resumeData.round === 1) ctx.suspend({ round: 2 });
        return { polished: `${ctx.inputData.draft}:${ctx.resumeData.verdict}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ verdict: z.string(), round: z.number() }),
      suspendSchema: z.object({ round: z.number() }),
      execute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun({ runId: 'two-rounds' });

    const first = await run.start({ inputData: { draft: 'ts' } }).result;
    expect(first.status).toBe('suspended');
    const second = expectSuspended(
      await run.resume({ step: 'approval', resumeData: { verdict: 'ok', round: 1 } }),
    );
    expect(second.stepResults['approval']?.suspendPayload).toEqual({ round: 2 });
    expect(saves.at(-1)).toMatchObject({ status: 'suspended', position: 0 });

    const third = await run.resume({ step: 'approval', resumeData: { verdict: 'ok', round: 2 } });
    expect(third.status).toBe('success');
    expect(rounds).toEqual([0, 1, 2]);
    expect(saves.at(-1)?.status).toBe('success');
  });
});

describe('块内 suspend:v1 只放 then 主轴,其余条目显式报错', () => {
  function suspendingStep(id: string): ReturnType<typeof createStep> {
    return createStep({
      id,
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: (ctx: StepContext<string, undefined, { question: string }>) =>
        ctx.suspend({ question: `${id}?` }),
    });
  }

  it('foreach 体内 suspend:点名 foreach 与 step id,且该块不落 failed 记录', async () => {
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'batch',
      inputSchema: z.array(z.string()),
      outputSchema: z.array(z.string()),
      storage: store,
    })
      .foreach(suspendingStep('item'))
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'foreach-suspend' }).start({ inputData: ['a'] }).result,
    );

    expect(error.message).toMatch(/foreach/);
    expect(error.message).toMatch(/item/);
    expect(error.message).toMatch(/then/);
    // 挂起信号不是 step 失败:块没有落记录,run 仍以 failed 终态落库
    expect(saves.at(-1)?.status).toBe('failed');
    expect(saves.at(-1)?.stepResults['item']).toBeUndefined();
  });

  it('parallel 内 suspend:点名 parallel 与 step id,且挂起 step 不落记录(挂在失败 run 的快照上)', async () => {
    const { store, saves } = recordingStore();
    const ok = createStep({
      id: 'ok',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: () => 'ok',
    });
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.string(),
      outputSchema: z.string(),
      storage: store,
    })
      .parallel([ok, suspendingStep('needs-human')])
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'parallel-suspend' }).start({ inputData: 'x' }).result,
    );

    expect(error.message).toMatch(/parallel/);
    expect(error.message).toMatch(/needs-human/);
    // 挂起只在可恢复条目(then)落 suspended 记录:失败 run 的快照里没有 suspended 记录
    const failed = saves.at(-1);
    expect(failed?.status).toBe('failed');
    expect(failed?.stepResults['needs-human']).toBeUndefined();
    expect(failed?.stepResults['ok']).toMatchObject({ status: 'success' });
  });

  it('dowhile 体内 suspend:点名 dowhile 与 step id;branch 臂同样报错', async () => {
    const loop = createWorkflow({
      id: 'loop',
      inputSchema: z.string(),
      outputSchema: z.string(),
    })
      .dowhile(suspendingStep('body'), () => true)
      .commit();

    const loopError = await captureRejection(() =>
      loop.createRun().start({ inputData: 'x' }).result,
    );
    expect(loopError.message).toMatch(/dowhile/);
    expect(loopError.message).toMatch(/body/);

    const branch = createWorkflow({
      id: 'branch',
      inputSchema: z.string(),
      outputSchema: z.string(),
    })
      .branch([[(ctx) => ctx.inputData === 'x', suspendingStep('arm')]])
      .commit();

    const branchError = await captureRejection(() =>
      branch.createRun().start({ inputData: 'x' }).result,
    );
    expect(branchError.message).toMatch(/branch/);
    expect(branchError.message).toMatch(/arm/);
  });

  it('条件里调用 suspend:显式报错(不是可恢复的挂起)', async () => {
    const arm = createStep({
      id: 'arm',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: () => 'x',
    });
    const workflow = createWorkflow({
      id: 'cond',
      inputSchema: z.string(),
      outputSchema: z.string(),
    })
      .branch([
        [
          (ctx) => {
            ctx.suspend({ question: 'never' });
            return true;
          },
          arm,
        ],
      ])
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun().start({ inputData: 'x' }).result,
    );
    expect(error.message).toMatch(/condition/);
  });
});

describe('createInMemorySnapshotStore:内存默认实现', () => {
  it('深拷贝:save 后改写原快照不影响 load;未知 runId 返回 null;同 runId 覆盖', async () => {
    const store = createInMemorySnapshotStore();
    const snapshot = {
      runId: 'r-1',
      status: 'suspended' as const,
      input: { topic: 'ts' },
      stepResults: { approval: { status: 'suspended' as const, suspendPayload: { q: 'q?' } } },
      position: 0,
    };

    await store.save('r-1', snapshot);
    // 写入后改写调用方对象:内存实现像序列化后端一样隔离
    snapshot.stepResults.approval.suspendPayload.q = 'mutated';

    const loaded = await store.load('r-1');
    expect(loaded).toEqual({
      runId: 'r-1',
      status: 'suspended',
      input: { topic: 'ts' },
      stepResults: { approval: { status: 'suspended', suspendPayload: { q: 'q?' } } },
      position: 0,
    });
    expect(await store.load('r-2')).toBeNull();

    await store.save('r-1', { ...snapshot, status: 'success', position: 1 });
    expect((await store.load('r-1'))?.status).toBe('success');
  });
});

describe('公开面:suspend/resume 的形状与类型(断言在编译期,tsc 阶段生效)', () => {
  it('run 面 = runId / start / resume;resume 选项收 step 对象或 id', () => {
    const { workflow } = approvalWorkflow();
    const run = workflow.createRun();

    expect(Object.keys(run).sort()).toEqual(['resume', 'runId', 'start']);
    expectAssignable<WorkflowResumeOptions>({ step: 'approval' });
    expectAssignable<WorkflowResumeOptions>({ step: 'approval', resumeData: { approved: true } });
    expectAssignable<ReturnType<typeof run.resume>>(
      Promise.resolve({ status: 'suspended' as const, stepId: 'approval', stepResults: {} }),
    );

    const suspendedOutcome: WorkflowRunOutcome = {
      status: 'suspended',
      stepId: 'approval',
      stepResults: {},
    };
    if (suspendedOutcome.status === 'suspended') {
      expectAssignable<string>(suspendedOutcome.stepId);
    }
    const successOutcome: WorkflowRunOutcome<{ polished: string }> = {
      status: 'success',
      output: { polished: 'x' },
      stepResults: {},
    };
    if (successOutcome.status === 'success') {
      expectAssignable<{ polished: string }>(successOutcome.output);
    }
  });
});
