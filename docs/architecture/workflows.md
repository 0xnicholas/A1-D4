# Workflow 引擎语义

> 来源:wayfinder ticket #11(决策:Workflow 引擎语义)。本文件是 Workflows 子系统的架构规范。
> 决策记录见 `docs/adr/0006-workflow-engine-semantics.md`;术语见 `CONTEXT.md`。
> 修订(#49):控制流算子表补钉两处实施期裁决——branch 无真分支输出空 keyed 对象 `{}`(tip 值不穿透);foreach concurrency 须为正整数,迭代失败后不再开新迭代。
> 修订(#50):循环与等待补钉实施期裁决——dowhile 条件在**迭代前**求值(条件在 tip 上为假即可 0 次迭代,块输出 = tip 原样透传)、dountil 在**迭代后**求值(至少一次);两者 `iterationCount` = 已完成迭代数(条件里抛错即最大迭代闸),块按 step id 记一条(记录 = 最后一次迭代的输出)。sleep 的动态时长 fn 收 `RequestContext`(动态参数约定,非 step 参数包;非有限数报错,负值当 0);`retries` = **额外**尝试数(最多 `retries + 1` 次),固定间隔 1000ms、可被中止打断,step 边界校验只做一次不重试,定义期须为非负整数。
> 修订(#51):suspend/resume 落地时补钉实施期裁决——v1 的 suspend 只成立在**顶层 then 条目**的 step 内,块内(parallel / branch 臂 / foreach / 循环)调用 suspend 显式报错(块内迭代现场不在快照形状内,升级为新 ticket);`position` = 重进下标(suspend 时 = 挂起条目,running 时 = 下一条目,终态 success = 条目数);resume 把前序条目**按记录回放**重建 tip(不重执行、不重估条件),`input` 用快照里已校验的值;无 storage 时只写 suspend 与终态(step 边界写只随真实 storage)。

## 定位

Workflows 是框架的编排子系统:把 step 组合成可重复执行的图。API 形状与词汇对齐 mastra(`createStep` / `createWorkflow` builder),但语义内核只是「扁平 step-flow 条目列表 + for 循环 walker」——调研(#3)证明 mastra 的语义核心即此,其体量几乎全来自持久化钩子、streaming、tracing 与多引擎适配,而非语义本身。轻量落法:**存储做成 port,引擎本体零依赖、纯内存可跑**;durable 重启与调度的裁决见 Harness 规范(`docs/architecture/harness.md`),外部 runner 适配是可能的能力包方向。

## 定义表面

### Step

```ts
const step = createStep({
  id: string,                    // 必填,快照与 parallel/branch 输出的 key
  inputSchema: StandardSchema,   // ADR-0003 双接口契约,无适配器
  outputSchema: StandardSchema,
  resumeSchema?,                 // resume 时校验 resumeData
  suspendSchema?,                // suspend(payload) 的类型
  retries?: number,              // 固定间隔重试,见「错误、重试与状态机」
  execute: (ctx: StepContext) => output | Promise<output>,
})
```

execute 的参数包 `StepContext`:`inputData` / `runId` / `signal` / `requestContext` / `getStepResult(stepId)` / `resumeData` / `suspend(payload)`。

- **无 `createStep(agent)` / `createStep(tool)` 特化重载**:agent 包装是一行手写——`execute: ({ inputData }) => agent.generate(inputData)`;文档给范式。
- **无 `state` / `setState` 黑板**:跨 step 共享用 `getStepResult` + 显式管道;黑板是可后加的 minor。

### Workflow 与 builder

```ts
const wf = createWorkflow({ id, inputSchema, outputSchema })
  .then(step1)
  .parallel([a, b])
  .branch([[condFn, stepA], [condFn2, stepB]])
  .foreach(step, { concurrency: 4 })
  .dowhile(step, condFn) / .dountil(step, condFn)
  .sleep(ms | ((ctx) => ms))
  .commit()                      // 冻结定义;未 commit 不可 createRun
```

- builder 可变链式,每个算子往条目列表 push 一条 `{type, ...}` 条目;`.commit()` 冻结。**没有 DAG**:执行就是对扁平条目数组的 for 循环解释。
- 类型安全靠 type-state(`TPrevSchema` 逐链传递),只在 then 主轴严格;parallel/branch 用 keyed 对象推断。
- condFn 收与 execute 相同的参数包(只读语义);dowhile/dountil 的 cond 另收 `iterationCount`,可在其中抛错设最大迭代。
- **嵌套 workflow as step 裁出 v1**(后加是 minor)。

### Run

```ts
const run = wf.createRun({ runId? })
const out = run.start({ inputData, requestContext?, signal? })
await out.result                 // 终值
for await (const ev of out)      // 最小 lifecycle 事件流,见「流式事件」
await run.resume({ step, resumeData? })   // 见「suspend/resume 与快照」
```

- run 输出对象与 Agent 输出对象同一心智:**await 终值 / for-await 事件流,双消费单路径**。
- `requestContext` 沿用 Agent 规范的开放袋约定;`signal`(AbortSignal)沿 execute 与动态时长函数传播。

## 控制流算子

| 算子 | 语义 | 输出形状 |
| --- | --- | --- |
| `.then(step)` | 顺序执行;上一步 output(校验后)作为下一步 input | 透传 |
| `.parallel([a,b])` | `Promise.all` 全并发,无并发上限;任一步失败整块失败;同步点 | `{ [step.id]: output }` |
| `.branch([[cond,step]...])` | 按定义序求值,第一个真分支执行;各分支 IO schema 一致;无真分支时输出空 keyed 对象 `{}`(tip 值不穿透) | keyed 对象,只有一个 key 有值 |
| `.foreach(step, {concurrency})` | 输入必须是数组;默认 concurrency=1(须为正整数);>1 用并发闸,保序收集;同步点;任一次迭代失败整块失败,失败后不再开新迭代(在飞迭代完成) | 输出数组 |
| `.dowhile` / `.dountil(step, cond)` | 循环至条件不满足/满足;dowhile 迭代**前**求值(可 0 次迭代)、dountil 迭代**后**求值(至少 1 次);输出 = 最后一次迭代的输出 | 透传 |
| `.sleep(ms\|fn)` | 进程内 setTimeout + AbortSignal,**非 durable**(进程死即丢);fn 动态算时长(收 `RequestContext`) | — |

## suspend/resume 与快照

**收 suspend/resume,形态 = suspend 控制信号 + step 边界 JSON 快照 + storage port**(ADR-0006)。

- `suspend(payload)` 在 execute 内调用:当前 step 标记 suspended → 快照写 port → 引擎展开退出;run 状态 = `suspended`。suspend 是控制信号不是失败:不经过 step 重试,也不落 failed 记录。
- 快照 = JSON 可序列化的 `{ runId, status, input, stepResults, position }`(stepResults 记录每步 status / output / 起止时间 / suspendPayload;position 即 mastra 的 startIdx 等价物)。**JSON-only 约束**:大数据只存引用。
- 恢复 = `run.resume({ step, resumeData? })`:load 快照 → resumeData 过 resumeSchema → 从 position 重进同一个 for 循环。time-travel / restart / restartAllActiveWorkflowRuns 是同一机制的变种,**全部裁出 v1**;引擎只暴露「load → 重进」原语,durable 重启归 Harness(#18)。
- 持久化时机:有 storage 时**每个 step 完成后** + suspend + 终态,固定写;无 shouldPersistSnapshot / prune 钩子。
- resume 并发去重:进程内锁;跨进程 CAS = adapter 可选扩展(`compareAndSave`,见 `docs/architecture/storage.md`)。

### 实施钉死(#51)

- **v1 的 suspend 只在顶层 `then` 条目**:`parallel` / `branch` 臂 / `foreach` / `dowhile` / `dountil` 体内调用 suspend → 显式报错(点名块类型与 step id),run 落 failed。迭代现场(第几次迭代、已收集多少、多少在飞)不在 `stepResults + position` 形状内;块内 suspend 语义是新 ticket 的事。条件里调用 suspend 同样显式报错(条件是只读的)。
- **position = 重进下标**:suspend 快照 = 挂起条目;`running` 快照 = 已完成条目的下一条;终态 `success` = 条目数。只写 `running` 快照当 `createWorkflow` 附了真实 storage;无 storage 时只写 suspend 与终态(内存默认实现,进程内可恢复)。
- **resume 的回放**:从快照 `input`(start 边界已校验过的值)起,按记录重建前序条目的输出得到 tip——前序 step 不重执行、条件不重估;`getStepResult` 由快照记录种子恢复。`resumeData` 过挂起 step 的 `resumeSchema` 是第三处固定 IO 校验,校验值替换原数据;声眀无 `resumeSchema` 的 step 不接受 resumeData(显式报错)。`step`(step 对象或 id)必须与快照里挂起的 step 一致,否则显式报错。resume 选项可再传 `signal` / `requestContext`(跨进程恢复时;缺省用 start 的)。
- **信封与去重**:挂起终态 = `{ status: 'suspended', stepId, stepResults }`(payload 在 `stepResults[stepId].suspendPayload`);resume 与 start 返回同一终态信封。进程内锁按 runId 去重:同一 run 的并发 resume 合并为一次调用(后到者拿到同一 promise),锁在 settle 后释放(再次挂起可再次 resume)。
- **写失败语义**:快照写失败随 run 失败(除 failed 终态那一写为 best-effort——run 自身的错误永远原样上抛)。

### storage port(#15 已定)

```ts
interface WorkflowSnapshotStore {
  load(runId: string): Promise<WorkflowRunSnapshot | null>
  save(runId: string, snapshot: WorkflowRunSnapshot): Promise<void>
}
```

核心自带内存 Map 默认实现——不接 storage 即纯内存,无运行时负担。基础形状冻结;adapter 家族与 delete / list / CAS 可选扩展见 `docs/architecture/storage.md`。

## IO 校验

- 契约 = Standard Schema 双接口(ADR-0003),零适配器。
- 校验点固定三处:start 输入、每个 step 边界(上步 output → 下步 input)、resumeData;**无 validateInputs 开关**,永远校验。
- 失败语义:start 校验失败 → 抛错不启动;step 边界失败 → 该 step failed → run failed。
- 校验返回值替换原数据(schema 的 default / transform 生效)。

## 流式事件

最小 lifecycle 事件流,粒度 = run / step 边界(run-start / step-start / step-end / run-end 量级),事件包络与词汇复用 chunk 协议(模型层已定共用,见 `docs/architecture/model.md`)。**chunk 级透传(step 内 agent 的 token 流)裁出 v1**:step 内用户可自行消费 agent 的 stream 输出对象。

## 错误、重试与状态机

- run 状态机三态:`success | failed | suspended`。sleep 期间状态保持 running(无 waiting);AbortSignal 取消落 `failed`(AbortError),不单设 canceled / tripwire。
- `retries?: number`:step 级,最多 `retries + 1` 次尝试、固定间隔 1000ms;重试只包 `execute`(step 边界的 IO 校验只做一次),间隔等待可被 AbortSignal 打断,最后一次的错误原样抛出;backoff 策略对象留扩展位。
- `bail(payload)` 裁出 v1:提前成功终止用 branch 建模,后加是 minor。

## 砍单与承载缝

| 砍单项 | 承载缝 |
| --- | --- |
| map / sleepUntil | 内联 step / 一行算术 |
| createStep(agent\|tool) 特化重载 | 一行手写包装(文档范式) |
| 嵌套 workflow as step | 后加 minor |
| state / setState 黑板 | getStepResult + 显式管道;后加 minor |
| bail | branch 建模;后加 minor |
| validateInputs 开关 | 永远校验 |
| time-travel / restart / restartAll | 引擎 load→重进原语;durable 归 Harness(#18) |
| 块内(parallel / branch 臂 / foreach / 循环)的 suspend | 显式报错 + 迭代现场快照机制归后续 ticket(快照形状需先演化) |
| shouldPersistSnapshot / prune 钩子 | 固定 step 边界写 |
| resume CAS / serializedStepGraph / 多引擎适配 | adapter 可选扩展(`docs/architecture/storage.md`)/ 外部 runner 能力包方向 |
| chunk 级流式透传 | step 内自行消费;后加 minor |
| durable sleep / 长延时等待 | schedules + suspend 组合(`docs/architecture/harness.md`);调度触发归平台 cron / tick 原语 |
| tripwire / canceled 状态 | AbortSignal → failed |

## 与其它子系统的关系

- **模型层(#9,已定)**:事件流与快照中的流式词汇复用 chunk 协议;step 内用模型走 `ModelInput` 三形状。
- **Agent(#10,已定)**:不复用 agent loop;agent 由用户一行包装进 step;agent 级审批/挂起归 Harness,本规范的快照机制是其底层机器。
- **存储(#15,已定)**:本规范钉 `WorkflowSnapshotStore` port(两个方法 + JSON-only);adapter 家族与扩展面见 `docs/architecture/storage.md`。
- **Harness(#18,已定)**:跨进程恢复与 durable timer 明确裁出;durable 重启 = 应用层用 load→重进原语 + `listSnapshots` 自举;agent 侧审批挂起机器与 schedules 见 `docs/architecture/harness.md`。
- **Observability(#14,已定)**:span 挂在 run / step 边界,lifecycle 事件流是其事件锚点,traceId 随快照持久化;见 `docs/architecture/observability.md`。
- **Memory(#12)**:无直接耦合。

## 依赖预算

核心(含 Workflows)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。storage adapter 与可能的外部 runner 适配归能力包。
