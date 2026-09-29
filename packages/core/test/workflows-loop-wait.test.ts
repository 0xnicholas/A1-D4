import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@balsa/core/workflows';
import { WorkflowValidationError } from '@balsa/core/workflows';
import type { RequestContext } from '@balsa/core/agent';
import type { StepContext } from '@balsa/core/workflows';
import { captureError, captureRejection, expectSuccess } from './helpers/assertions.js';

/** 一次性闸门 / 信号:测试自行控制时机,不靠计时器(沿 workflows-control-flow 的 idiom)。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onRelease) => {
    resolve = onRelease;
  });
  return { promise, resolve };
}

/**
 * 循环与等待(M3 #50,`docs/architecture/workflows.md`「控制流算子」「错误、重试与状态机」):
 * dowhile / dountil 两个循环算子、`.sleep()` 条目与 step 级 `retries`。
 *
 * - dowhile:**每次迭代前**求值条件——条件假则该次不执行(可能 0 次迭代,tip 原样透传);
 * - dountil:**每次迭代后**求值条件——至少迭代一次,条件真即停;
 * - 两者:`iterationCount` = 已完成的迭代数(条件里抛错即最大迭代闸),第 N+1 次迭代的输入 =
 *   第 N 次迭代的输出,输出 = 最后一次迭代的输出,块按 step id 记一条(与 foreach 同);
 * - `.sleep(ms | fn)`:进程内 `setTimeout` + AbortSignal、**非 durable**;动态时长 fn 收
 *   `RequestContext`(动态参数约定,`signal` / `runId` 可达),tip 不经它、也不记条目;
 * - `retries`:step 级固定间隔(1000ms)重试,最多 `retries + 1` 次尝试;step 边界的 IO 校验
 *   只做一次(不重试)。
 *
 * 接缝 = 公开 `@balsa/core/workflows` 子路径,不触内部模块。循环条件「迭代前 / 迭代后」的
 * 求值点与 sleep 的动态时长参数包形状是本票的实施期裁决(spec 修订(#50))。循环内每次迭代的事件
 * 与 span 归 workflows-events / workflows-observability(记录仍按块记一条)。
 */

const counter = z.object({ count: z.number() });

describe('dowhile:每次迭代前求值条件', () => {
  it('条件真才执行下一次:iterationCount 从 0 起、输入反馈回环、输出 = 最后一次迭代的输出', async () => {
    const seen: Array<{
      readonly iterationCount: number;
      readonly inputData: unknown;
      readonly runId: string;
      readonly contextRunId: unknown;
      readonly signal: AbortSignal;
    }> = [];
    const ownViews: unknown[] = [];
    const downstream: unknown[] = [];
    const bump = createStep({
      id: 'bump',
      inputSchema: counter,
      outputSchema: counter,
      execute: (ctx) => {
        ownViews.push(ctx.getStepResult('bump'));
        return { count: ctx.inputData.count + 1 };
      },
    });
    const tail = createStep({
      id: 'tail',
      inputSchema: counter,
      outputSchema: z.object({ done: z.boolean() }),
      execute: ({ inputData }) => {
        downstream.push(inputData);
        return { done: true };
      },
    });
    const workflow = createWorkflow({
      id: 'loop',
      inputSchema: counter,
      outputSchema: z.object({ done: z.boolean() }),
    })
      .dowhile(bump, (ctx) => {
        seen.push({
          iterationCount: ctx.iterationCount,
          inputData: ctx.inputData,
          runId: ctx.runId,
          contextRunId: ctx.requestContext.runId,
          signal: ctx.signal,
        });
        return ctx.iterationCount < 3;
      })
      .then(tail)
      .commit();

    const outcome = expectSuccess(
      await workflow.createRun({ runId: 'run-1' }).start({ inputData: { count: 0 } }).result,
    );

    // 迭代前求值:0 / 1 / 2 放行 → 三次迭代;第 4 次求值(3)停
    expect(seen.map((call) => call.iterationCount)).toEqual([0, 1, 2, 3]);
    // 条件看到的是「下一次迭代将要消费的值」:tip,随后每次都是上一次的输出
    expect(seen.map((call) => call.inputData)).toEqual([
      { count: 0 },
      { count: 1 },
      { count: 2 },
      { count: 3 },
    ]);
    // 条件与 execute 收同一个参数包(runId / requestContext / signal 同源)
    expect(seen[0]?.runId).toBe('run-1');
    expect(seen[0]?.contextRunId).toBe('run-1');
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    // 块内查自己:尚无记录(与 foreach 同理)
    expect(ownViews).toEqual([undefined, undefined, undefined]);
    // 输出 = 最后一次迭代的输出,透传给下游
    expect(downstream).toEqual([{ count: 3 }]);
    expect(outcome.output).toEqual({ done: true });
    expect(outcome.stepResults['bump']).toMatchObject({ status: 'success', output: { count: 3 } });
  });

  it('条件在 iterationCount=0 时为假:step 一次都不执行,tip 原样透传', async () => {
    const execute = vi.fn((ctx: StepContext<{ count: number }>) => ({ count: ctx.inputData.count + 1 }));
    const bump = createStep({ id: 'bump', inputSchema: counter, outputSchema: counter, execute });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dowhile(bump, () => false)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 0 } }).result);

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.output).toEqual({ count: 0 });
    expect(outcome.stepResults['bump']).toMatchObject({ status: 'success', output: { count: 0 } });
  });
});

describe('dountil:每次迭代后求值条件', () => {
  it('至少迭代一次:条件收最后一次迭代的输出与已完成的迭代数,真即停', async () => {
    const seen: Array<{ readonly iterationCount: number; readonly inputData: unknown }> = [];
    const bump = createStep({
      id: 'bump',
      inputSchema: counter,
      outputSchema: counter,
      execute: ({ inputData }) => ({ count: inputData.count + 1 }),
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dountil(bump, (ctx) => {
        seen.push({ iterationCount: ctx.iterationCount, inputData: ctx.inputData });
        return ctx.iterationCount >= 2;
      })
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 0 } }).result);

    // 迭代后求值:1 / 2,第 2 次即停
    expect(seen).toEqual([
      { iterationCount: 1, inputData: { count: 1 } },
      { iterationCount: 2, inputData: { count: 2 } },
    ]);
    expect(outcome.output).toEqual({ count: 2 });
    expect(outcome.stepResults['bump']).toMatchObject({ status: 'success', output: { count: 2 } });
  });

  it('第一次求值即为真:恰好迭代一次(do-until 至少一次,不是零次)', async () => {
    const execute = vi.fn((ctx: StepContext<{ count: number }>) => ({ count: ctx.inputData.count + 1 }));
    const bump = createStep({ id: 'bump', inputSchema: counter, outputSchema: counter, execute });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dountil(bump, () => true)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 0 } }).result);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome.output).toEqual({ count: 1 });
  });
});

describe('循环的失败语义', () => {
  it('迭代中 execute 抛错:run 以同一错误失败(原样),不再迭代', async () => {
    const boom = new Error('iteration boom');
    let calls = 0;
    const bump = createStep({
      id: 'bump',
      inputSchema: counter,
      outputSchema: counter,
      execute: ({ inputData }) => {
        calls += 1;
        if (calls === 2) throw boom;
        return { count: inputData.count + 1 };
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dowhile(bump, () => true)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error).toBe(boom);
    expect(calls).toBe(2);
  });

  it('条件抛错 = 最大迭代闸:错误原样失败,迭代次数 = 阈值(iterationCount 计已完成迭代)', async () => {
    const guard = new Error('too many iterations');
    let calls = 0;
    const bump = createStep({
      id: 'bump',
      inputSchema: counter,
      outputSchema: counter,
      execute: ({ inputData }) => {
        calls += 1;
        return { count: inputData.count + 1 };
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dowhile(bump, ({ iterationCount }) => {
        if (iterationCount >= 2) throw guard;
        return true;
      })
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error).toBe(guard);
    expect(calls).toBe(2);
  });

  it('每次迭代的输入边界照常校验:输出不被 inputSchema 接受 → WorkflowValidationError(带 step id)', async () => {
    let calls = 0;
    const messy = createStep({
      id: 'messy',
      inputSchema: counter,
      outputSchema: counter,
      execute: () => {
        calls += 1;
        return { count: 'nope' } as unknown as { count: number };
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .dowhile(messy, ({ iterationCount }) => iterationCount < 5)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('messy');
    expect(calls).toBe(1);
  });
});

describe('sleep:进程内等待,tip 原样透传', () => {
  it('等待毫秒数后继续:tip 不被消费,stepResults 不记条目', async () => {
    const seen: unknown[] = [];
    const draft = createStep({
      id: 'draft',
      inputSchema: counter,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => ({ draft: `count:${inputData.count}` }),
    });
    const tail = createStep({
      id: 'tail',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: counter,
      execute: ({ inputData }) => {
        seen.push(inputData);
        return { count: inputData.draft.length };
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(draft)
      .sleep(30)
      .then(tail)
      .commit();

    const startedAt = Date.now();
    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 1 } }).result);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(20);
    // sleep 是延迟算子:draft 的输出原样成为 tail 的输入
    expect(seen).toEqual([{ draft: 'count:1' }]);
    expect(outcome.output).toEqual({ count: 'count:1'.length });
    // 记录只属于 step:id 表里没有 sleep
    expect(Object.keys(outcome.stepResults).sort()).toEqual(['draft', 'tail']);
  });

  it('动态时长 fn 收 RequestContext(动态参数约定):signal / runId / 用户袋可达,不是 step 参数包', async () => {
    const views: Array<Record<string, unknown>> = [];
    const dynamic = vi.fn((ctx: RequestContext) => {
      views.push({ ...ctx });
      return 10;
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .sleep(dynamic)
      .commit();

    const startedAt = Date.now();
    await workflow
      .createRun({ runId: 'run-1' })
      .start({ inputData: { count: 0 }, requestContext: { userId: 'u-1' } })
      .result;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5);
    expect(dynamic).toHaveBeenCalledTimes(1);
    // 形状 = 动态参数约定(ctx 就是 run 的 requestContext):不是 StepContext
    expect(Object.keys(views[0] ?? {}).sort()).toEqual(['runId', 'signal', 'userId']);
    expect(views[0]?.runId).toBe('run-1');
    expect(views[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(views[0]?.userId).toBe('u-1');
  });

  it('时长非有限数:显式报错(不静默当 0)——workflow id 与原因点名', async () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
        .sleep(() => invalid)
        .commit();

      const error = await captureRejection(async () =>
        workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
      );

      expect(error.message).toMatch(/loop/);
      expect(error.message).toMatch(/sleep duration/);
      expect(error.message).toContain(String(invalid));
    }
  });

  it('负时长(已过的截止点):当 0 处理,run 照常成功', async () => {
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .sleep(() => -5)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 0 } }).result);

    expect(outcome.output).toEqual({ count: 0 });
  });

  it('等待中中止:立刻以 AbortError 失败(长时长不拖到自然醒)', async () => {
    const sleeping = deferred();
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .sleep(() => {
        sleeping.resolve();
        return 30_000;
      })
      .commit();

    const controller = new AbortController();
    const out = workflow.createRun().start({ inputData: { count: 0 }, signal: controller.signal });
    const result = out.result;
    await sleeping.promise;
    controller.abort();

    const error = await captureRejection(() => result.then(() => undefined));

    expect(error.name).toBe('AbortError');
  });
});

describe('retries:step 级固定间隔重试', () => {
  it('失败后按固定间隔(1000ms)重试:最多 retries + 1 次尝试,记录 = 成功那次的输出', async () => {
    let attempts = 0;
    const flaky = createStep({
      id: 'flaky',
      inputSchema: counter,
      outputSchema: counter,
      retries: 1,
      execute: ({ inputData }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return { count: inputData.count + 1 };
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(flaky)
      .commit();

    const startedAt = Date.now();
    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { count: 0 } }).result);
    const elapsed = Date.now() - startedAt;

    expect(attempts).toBe(2);
    expect(outcome.output).toEqual({ count: 1 });
    expect(outcome.stepResults['flaky']).toMatchObject({ status: 'success', output: { count: 1 } });
    // 固定间隔 1000ms：只断言下界(真实计时只会更慢)
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('重试次数用尽:run 以最后一次的错误失败(原样),尝试次数 = retries + 1', async () => {
    let attempts = 0;
    const failing = createStep({
      id: 'failing',
      inputSchema: counter,
      outputSchema: counter,
      retries: 1,
      execute: () => {
        attempts += 1;
        throw new Error(`attempt ${attempts}`);
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(failing)
      .commit();

    const startedAt = Date.now();
    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error.message).toBe('attempt 2');
    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it('step 边界的 IO 校验只做一次:校验失败不重试(不白等间隔)', async () => {
    const strict = createStep({
      id: 'strict',
      inputSchema: z.object({ count: z.number().min(5) }),
      outputSchema: counter,
      retries: 3,
      execute: ({ inputData }) => ({ count: inputData.count }),
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(strict)
      .commit();

    const startedAt = Date.now();
    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('strict');
    // 校验在重试之外：3 次重试一次都没发生(用 1000ms 间隔的下界反证)
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it('等待间隔可被取消:中止后立刻以 AbortError 失败(不再重试)', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const aborting = createStep({
      id: 'aborting',
      inputSchema: counter,
      outputSchema: counter,
      retries: 5,
      execute: () => {
        attempts += 1;
        controller.abort();
        throw new Error('boom');
      },
    });
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(aborting)
      .commit();

    const startedAt = Date.now();
    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { count: 0 }, signal: controller.signal })
        .result.then(() => undefined),
    );

    expect(error.name).toBe('AbortError');
    expect(attempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it('retries 配置:非负整数以外的值在定义期显式报错(不静默)', () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureError(() =>
        createStep({
          id: 'flaky',
          inputSchema: counter,
          outputSchema: counter,
          retries: invalid,
          execute: () => ({ count: 0 }),
        }),
      );
      expect(error.message).toMatch(/flaky/);
      expect(error.message).toMatch(/retries/);
    }

    // 0 与正整数合法
    const none = createStep({
      id: 'flaky',
      inputSchema: counter,
      outputSchema: counter,
      retries: 0,
      execute: () => ({ count: 0 }),
    });
    expect(none.retries).toBe(0);
  });

  it('手搓 step 字面量绕过工厂时读数仍须收口:NaN 不变成无限重试(尝试一次即失败)', async () => {
    let attempts = 0;
    const handBuilt = {
      id: 'hand-built',
      inputSchema: counter,
      outputSchema: counter,
      retries: Number.NaN,
      execute: () => {
        attempts += 1;
        throw new Error('boom');
      },
    };
    const workflow = createWorkflow({ id: 'loop', inputSchema: counter, outputSchema: counter })
      .then(handBuilt)
      .commit();

    const startedAt = Date.now();
    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { count: 0 } }).result.then(() => undefined),
    );

    expect(error.message).toBe('boom');
    expect(attempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });
});
