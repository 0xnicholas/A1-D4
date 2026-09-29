import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, createWorkflowRun } from '@balsa/core/workflows';
import { WorkflowValidationError } from '@balsa/core/workflows';
import type {
  StepContext,
  WorkflowEntry,
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowStepResultSnapshot,
} from '@balsa/core/workflows';
import { captureError, captureRejection, expectAssignable, expectSuccess } from './helpers/assertions.js';

/**
 * walker 语义内核(M3 #48,`docs/architecture/workflows.md`「Run」「IO 校验」「错误、重试与状态
 * 机」):`createRun` / `start` 输出对象骨架、then 主轴 for 循环解释执行、前两处 IO 校验(start 输入、
 * step 边界)、状态机 success / failed(suspend / resume 与第三处 resumeData 校验归
 * workflows-suspend-resume)、`getStepResult`、AbortSignal 沿 execute 传播。
 *
 * 接缝 = 公开 `@balsa/core/workflows` 子路径:定义 → `createRun` → `run.start` → `out.result`,
 * 以及 step `execute` / 动态函数收到的 ctx;不触内部模块。
 */

const topicInput = z.object({ topic: z.string() });
const articleOutput = z.object({ polished: z.string() });

describe('run.start:then 主轴 for 循环解释执行', () => {
  it('按条目顺序执行;上一步(校验后)的 output 作为下一步 inputData;result 落终值信封', async () => {
    const seen: unknown[] = [];
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => {
        seen.push(inputData);
        return { draft: inputData.topic.toUpperCase() };
      },
    });
    const polish = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: articleOutput,
      execute: ({ inputData }) => {
        seen.push(inputData);
        return { polished: `«${inputData.draft}»` };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(polish)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    const outcome = expectSuccess(await out.result);

    expect(outcome.status).toBe('success');
    expect(outcome.output).toEqual({ polished: '«TS»' });
    expect(seen).toEqual([{ topic: 'ts' }, { draft: 'TS' }]);
  });

  it('stepResults:按 step id 记录每步 status / output / 起止时间', async () => {
    const step = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
    })
      .then(step)
      .commit();

    const before = Date.now();
    const outcome = await workflow.createRun().start({ inputData: { topic: 'ts' } }).result;
    const after = Date.now();

    expect(Object.keys(outcome.stepResults)).toEqual(['draft']);
    const record: WorkflowStepResultSnapshot | undefined = outcome.stepResults['draft'];
    expect(record?.status).toBe('success');
    expect(record?.output).toEqual({ draft: 'ts' });
    expect(record?.startedAt).toBeGreaterThanOrEqual(before);
    expect(record?.endedAt).toBeGreaterThanOrEqual(record?.startedAt ?? 0);
    expect(record?.endedAt).toBeLessThanOrEqual(after);
  });

  it('空条目列表:终值 = 输入原值(无 step 消费),stepResults 为空表', async () => {
    const workflow = createWorkflow({
      id: 'pass-through',
      inputSchema: topicInput,
      outputSchema: topicInput,
    }).commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { topic: 'ts' } }).result);

    expect(outcome.status).toBe('success');
    expect(outcome.output).toEqual({ topic: 'ts' });
    expect(outcome.stepResults).toEqual({});
  });
});

describe('step ctx:框架参数包', () => {
  it('runId / signal / requestContext / resumeData / getStepResult 按语义交给 execute', async () => {
    const controller = new AbortController();
    let captured: StepContext | undefined;
    let seenDraft: unknown;
    let seenSelf: unknown;
    let seenMissing: unknown;
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => ({ draft: inputData.topic.toUpperCase() }),
    });
    const polish = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: articleOutput,
      execute: (ctx) => {
        captured = ctx;
        // getStepResult 是执行期即时查询:已运行 step 的记录输出可见,当前 step 自己还没记录
        seenDraft = ctx.getStepResult('draft');
        seenSelf = ctx.getStepResult('polish');
        seenMissing = ctx.getStepResult('never-ran');
        return { polished: ctx.inputData.draft };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(polish)
      .commit();

    const run = workflow.createRun({ runId: 'run-1' });
    await run
      .start({
        inputData: { topic: 'ts' },
        requestContext: { userId: 'u-1' },
        signal: controller.signal,
      })
      .result;

    expect(run.runId).toBe('run-1');
    expect(captured?.runId).toBe('run-1');
    // per-call signal 原样传播(同一引用),requestContext 也是同一对象
    expect(captured?.signal).toBe(controller.signal);
    expect(captured?.requestContext.signal).toBe(controller.signal);
    expect(captured?.requestContext.runId).toBe('run-1');
    // 用户开放袋属性原样带上,框架字段最后写入(不可被用户键劫持)
    expect(captured?.requestContext['userId']).toBe('u-1');
    // 首次执行(非 resume):resumeData 为空
    expect(captured?.resumeData).toBeUndefined();
    // getStepResult:已运行 step 的记录输出;未运行 / 正在运行的一律 undefined
    expect(seenDraft).toEqual({ draft: 'TS' });
    expect(seenMissing).toBeUndefined();
    expect(seenSelf).toBeUndefined();
  });

  it('不传 signal / requestContext:每步拿到同一个永不中止的 signal 与同一个 context 对象', async () => {
    const seen: StepContext[] = [];
    const step = (id: string) =>
      createStep({
        id,
        inputSchema: topicInput,
        outputSchema: topicInput,
        execute: (ctx) => {
          seen.push(ctx);
          return ctx.inputData;
        },
      });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(step('a'))
      .then(step('b'))
      .commit();

    await workflow.createRun().start({ inputData: { topic: 'ts' } }).result;

    expect(seen).toHaveLength(2);
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(seen[1]?.signal).toBe(seen[0]?.signal);
    expect(seen[1]?.requestContext).toBe(seen[0]?.requestContext);
  });
});

describe('IO 校验:start 输入与 step 边界(固定三处中的前两处;第三处 resumeData 归 suspend/resume 套件)', () => {
  it('start 校验失败:抛错不启动,任何 step 都不执行', async () => {
    const execute = vi.fn(() => ({ draft: 'x' }));
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
    })
      .then(draft)
      .commit();

    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { topic: 42 } as unknown as { topic: string } })
        .result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).issues.length).toBeGreaterThan(0);
    expect(error.message).toMatch(/article/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('start 校验的返回值替换原数据:schema default / transform 对第一步生效', async () => {
    const input = z.object({
      topic: z.string().transform((value) => value.trim().toLowerCase()),
      note: z.string().default('none'),
    });
    let received: unknown;
    const draft = createStep({
      id: 'draft',
      inputSchema: z.object({ topic: z.string(), note: z.string() }),
      outputSchema: topicInput,
      execute: (ctx) => {
        received = ctx.inputData;
        return { topic: ctx.inputData.topic };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: input,
      outputSchema: topicInput,
    })
      .then(draft)
      .commit();

    await workflow.createRun().start({ inputData: { topic: '  TS  ' } }).result;

    expect(received).toEqual({ topic: 'ts', note: 'none' });
  });

  it('step 边界:上一步 output 过下一步 inputSchema,校验值(transform 后)替换原数据', async () => {
    let received: unknown;
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: () => ({ draft: 'ts' }),
    });
    const polish = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string().transform((value) => value.toUpperCase()) }),
      outputSchema: articleOutput,
      execute: (ctx) => {
        received = ctx.inputData.draft;
        return { polished: ctx.inputData.draft };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(polish)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { topic: 'ts' } }).result);

    expect(received).toBe('TS');
    expect(outcome.output).toEqual({ polished: 'TS' });
  });

  it('step 边界校验失败:以 WorkflowValidationError 拒绝、带 step id,后续 step 不执行', async () => {
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: () => ({ draft: 'ab' }),
    });
    const polishExecute = vi.fn(() => ({ polished: 'x' }));
    const polish = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string().min(5) }),
      outputSchema: articleOutput,
      execute: polishExecute,
    });
    const afterExecute = vi.fn(() => ({ polished: 'y' }));
    const after = createStep({
      id: 'after',
      inputSchema: articleOutput,
      outputSchema: articleOutput,
      execute: afterExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(polish)
      .then(after)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('polish');
    expect((error as WorkflowValidationError).issues.length).toBeGreaterThan(0);
    expect(polishExecute).not.toHaveBeenCalled();
    expect(afterExecute).not.toHaveBeenCalled();
  });
});

describe('失败语义:step 失败 → run failed', () => {
  it('execute 抛错:run 以同一错误拒绝(原样不包装),后续 step 不执行', async () => {
    const boom = new Error('boom');
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: () => {
        throw boom;
      },
    });
    const afterExecute = vi.fn(() => ({ polished: 'y' }));
    const after = createStep({
      id: 'after',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: articleOutput,
      execute: afterExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(after)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    expect(error).toBe(boom);
    expect(afterExecute).not.toHaveBeenCalled();
  });
});

describe('AbortSignal:取消落 failed(AbortError),不单设 canceled', () => {
  it('启动前已中止:以中止原因拒绝,不执行任何 step', async () => {
    const execute = vi.fn(() => ({ draft: 'x' }));
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
    })
      .then(draft)
      .commit();
    const controller = new AbortController();
    controller.abort();

    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { topic: 'ts' }, signal: controller.signal })
        .result.then(() => undefined),
    );

    expect(error.name).toBe('AbortError');
    expect(execute).not.toHaveBeenCalled();
  });

  it('执行中中止(当前 step 无视 signal):当前 step 完成后 run 以 AbortError 失败,后续 step 不执行', async () => {
    const controller = new AbortController();
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: () => {
        controller.abort();
        return { draft: 'x' };
      },
    });
    const afterExecute = vi.fn(() => ({ polished: 'y' }));
    const after = createStep({
      id: 'after',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: articleOutput,
      execute: afterExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(after)
      .commit();

    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { topic: 'ts' }, signal: controller.signal })
        .result.then(() => undefined),
    );

    expect(error.name).toBe('AbortError');
    expect(afterExecute).not.toHaveBeenCalled();
  });

  it('自定义中止原因:原样作为 run 的失败错误', async () => {
    const reason = new RangeError('cancelled by host');
    const controller = new AbortController();
    controller.abort(reason);
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: () => ({ draft: 'x' }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
    })
      .then(draft)
      .commit();

    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { topic: 'ts' }, signal: controller.signal })
        .result.then(() => undefined),
    );

    expect(error).toBe(reason);
  });
});

describe('输出对象:懒启动 + 单路径终值', () => {
  it('start 本身不执行任何 step;首次读 out.result 才驱动执行', async () => {
    const execute = vi.fn(() => ({ draft: 'x' }));
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
    })
      .then(draft)
      .commit();

    const out = workflow.createRun().start({ inputData: { topic: 'ts' } });
    // 让出事件循环:无人消费的输出对象不得产生任何副作用
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();

    const outcome = await out.result;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('success');
  });

  it('重复读 result:同一 promise,一次运行一个终值', async () => {
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    }).commit();
    const out = workflow.createRun().start({ inputData: { topic: 'ts' } });

    expect(out.result).toBe(out.result);
    await out.result;
    expect(out.result).toBe(out.result);
  });
});

describe('createRun / start 约束', () => {
  it('runId:显式值原样,缺省生成非空身份', () => {
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    }).commit();

    expect(workflow.createRun({ runId: 'run-1' }).runId).toBe('run-1');
    const generated = workflow.createRun().runId;
    expect(generated).toBeTypeOf('string');
    expect(generated.length).toBeGreaterThan(0);
    expect(captureError(() => workflow.createRun({ runId: '' })).message).toMatch(/runId/);
  });

  it('同一 run 只能 start 一次:第二次 start 同步抛错', () => {
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    }).commit();
    const run = workflow.createRun();
    run.start({ inputData: { topic: 'ts' } });

    expect(captureError(() => run.start({ inputData: { topic: 'ts' } })).message).toMatch(
      /already started/,
    );
    // 同一 workflow 可另起一个 run
    expect(workflow.createRun()).not.toBe(run);
  });

  it('未知条目类型:执行到该条目时报错点名条目类型(非静默跳过)', async () => {
    const draftExecute = vi.fn(() => ({ draft: 'x' }));
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: draftExecute,
    });
    // 七算子齐备后公开面造不出未知条目(#50 落地后 walker 覆盖全部条目类型):用底层
    // createWorkflowRun 手搓一条,钉住「解释器不认识就显式报错」的语义。
    const forged = {
      id: 'article',
      inputSchema: topicInput,
      entries: [{ type: 'then', step: draft }, { type: 'map' }] as unknown as readonly WorkflowEntry[],
    };

    const error = await captureRejection(async () =>
      createWorkflowRun(forged, {})
        .start({ inputData: { topic: 'ts' } })
        .result.then(() => undefined),
    );

    expect(error.message).toMatch(/map/);
    expect(error.message).toMatch(/article/);
    // then 条目先执行(报错发生在执行到未知条目的时刻)
    expect(draftExecute).toHaveBeenCalledTimes(1);
  });
});

/**
 * run 面的类型(断言均在编译期生效,tsc 阶段):`createRun` 的入参 / 终值由 workflow 声明的
 * IO schema 推出;`result` 是终值信封。运行期只建对象不执行(懒启动)。
 */
describe('run 面类型(编译期)', () => {
  it('createRun / start / result 的类型由声明 schema 推出', () => {
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .commit();

    const run = workflow.createRun({ runId: 'run-1' });
    expectAssignable<WorkflowRun<{ topic: string }, { polished: string }>>(run);
    expectAssignable<string>(run.runId);

    const out = run.start({ inputData: { topic: 'ts' } });
    expectAssignable<Promise<WorkflowRunOutcome<{ polished: string }>>>(out.result);
    expectAssignable<Promise<WorkflowRunOutcome<{ polished: string }>>>(out.result);

    // requestContext 是用户开放袋;signal 是 AbortSignal
    workflow.createRun().start({ inputData: { topic: 'ts' }, requestContext: { userId: 'u-1' } });
    workflow
      .createRun()
      .start({ inputData: { topic: 'ts' }, signal: new AbortController().signal });

    // @ts-expect-error inputData 形状由 workflow 的 inputSchema 推出,不是别的形状
    workflow.createRun().start({ inputData: { topic: 42 } });
    // 「未 commit 不可 createRun」由 workflows-type-state.test.ts 的 builder 分界测试钉住
  });

  it('outcome 的收窄面:status / output / stepResults', async () => {
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    }).commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { topic: 'ts' } }).result);
    expectAssignable<'success'>(outcome.status);
    expectAssignable<{ polished: string }>(outcome.output);
    expectAssignable<Readonly<Record<string, WorkflowStepResultSnapshot>>>(outcome.stepResults);
  });
});
