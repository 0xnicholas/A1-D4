# 调研:mastra Workflows 引擎语义

- 调研日期:2026-09-28
- 来源:mastra 官方文档(mastra.ai/docs,`.md` 端点)+ GitHub `mastra-ai/mastra` 仓库 `main` 分支源码。源码快照版本:`@mastra/core@1.72.0-alpha.4`(main 分支 `packages/core/package.json`)。mastra 演进很快,行号与细节以该版本为准。
- 定位:事实呈现 + 对"极致轻量 workflow 引擎"的取舍含义,不做架构决策。

## TL;DR

mastra 的 workflow 不是 DAG 执行器,而是一个**扁平 step-flow 条目列表 + 单进程顺序 walker**。`createStep`/`createWorkflow` 只是带 Standard Schema 校验的配置对象与可变 builder;所有控制流(`.then/.parallel/.branch/.foreach/.dowhile/.map/.sleep`)都编译成 `{type, ...}` 条目,由 `DefaultExecutionEngine.execute()` 用一个 `for` 循环原地解释执行——parallel 是 `Promise.all`,foreach 是 `fastq` 并发队列,sleep 是 `setTimeout`。**suspend/resume、time-travel、崩溃重启三类"高级"语义全部建立在同一件事上:每个 step 边界把一份 JSON 快照(`WorkflowRunState`)写进 storage,恢复 = 读快照 + 从 `startIdx` 重进同一个 for 循环。** 外部 runner(Inngest/Temporal)通过 4 个引擎接缝(`executeSleepDuration`/`executeSleepUntilDate`/`wrapDurableOperation`/`getEngineContext`)把 sleep 与 step 执行换成对方的 durable 原语。对轻量引擎的含义:语义核心(step 模型 + builder + 边界校验 + 状态机结果)可以非常小;mastra 的体量(`workflow.ts` 单文件 20 万字符)几乎全来自持久化、流式、可观测性与多引擎适配。

## 1. API 形状

### 1.1 `createStep`

来源:[Step class 参考](https://mastra.ai/reference/workflows/step)、[`packages/core/src/workflows/step.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/step.ts)。

```ts
const step = createStep({
  id: 'step-1',                    // 必填,快照与 parallel 输出的 key
  description?: string,
  inputSchema,                     // StandardSchemaWithJSON
  outputSchema,
  resumeSchema?,                   // resume 时校验 resumeData
  suspendSchema?,                  // suspend() payload 的类型
  stateSchema?,                    // 必须是 workflow stateSchema 的子集
  requestContextSchema?,
  retries?: number,                // 覆盖 workflow 级 retryConfig
  execute: async (params) => output,
});
```

`execute` 的参数包(`ExecuteFunctionParams`,step.ts:24-72):`inputData`、`state`/`setState`(workflow 级共享状态)、`resumeData`、`suspendData`、`suspend(payload, {resumeLabel?})`、`bail(result)`(提前成功终止整个 workflow)、`abort()`、`getStepResult(step|id)`、`getInitData()`、`runId`、`retryCount`、`mastra`、`requestContext`、`writer`、`engine`、`abortSignal`。`suspend`/`bail` 返回带 brand 的 `InnerOutput` 类型,让 TS 强制你 `return await suspend(...)`。

重载:`createStep(agent)`(输出默认 `{text: string}`,`structuredOutput.schema` 可改)、`createStep(tool)`、`createStep(classifier)`——agent/tool/classifier 都被包装成普通 step。

### 1.2 `createWorkflow` + builder

来源:[Workflow class 参考](https://mastra.ai/reference/workflows/workflow)、[`workflow.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/workflow.ts)(202,869 字符 / 5,425 行)、[`create.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/create.ts)。

```ts
const wf = createWorkflow({ id, inputSchema, outputSchema, stateSchema?, options?, schedule? })
  .then(step1)
  .parallel([a, b])
  .branch([[condFn, stepA], [condFn2, stepB]])
  .foreach(step, { concurrency: 4 })
  .dowhile(step, condFn) / .dountil(step, condFn)
  .map(fnOrConfig)
  .sleep(ms | fn) / .sleepUntil(date | fn)
  .commit();                       // 必须调用,否则 createRun 抛错
```

关键实现事实:

- **builder 是可变的**:每个链式方法往 `this.stepFlow: StepFlowEntry[]` push 一条 `{type, ...}` 条目并返回 `this`(workflow.ts:2037-2049)。类型安全靠 type-state:返回类型里 `TPrevSchema` 被替换为上一步输出,从而在编译期校验"上一步 outputSchema 匹配下一步 inputSchema"。
- **没有 DAG**。`.commit()` 只做 `this.executionGraph = { id, steps: this.stepFlow }`(workflow.ts:2799-2824)。"图"就是这个线性条目数组;parallel/branch 把子条目数组嵌在单条 entry 里(`StepFlowEntry`,types.ts:704-772:`step|agent|tool|classifier|mapping|sleep|sleepUntil|parallel|conditional|loop|foreach`)。
- 同时维护 `serializedStepFlow`(可 JSON 化的条目镜像),随快照持久化,time-travel 时用它比对"图是否变过"。`.map()` 还会生成确定性 id `mapping_<workflowId>_<n>`,因为随机 id 会让跨进程 time-travel 失配(workflow.ts:2381-2389)。
- 声明 `schedule` 会让 `createWorkflow` 直接返回 evented 引擎的 workflow(create.ts:55-66)。

### 1.3 Run

`const run = await workflow.createRun({ runId?, resourceId? })`(workflow.ts:2842)。`createRun` 若开启持久化,会立刻写一条 `status: 'pending'` 的初始快照。Run 方法:`start({inputData, initialState?})`、`startAsync`、`stream`/`observeStream`、`resume({step, resumeData})`、`resumeAsync`、`restart()`、`timeTravel({step, inputData?, context?})`、`cancel()`(workflow.ts:3733-5304)。run 结果状态机:`success | failed | suspended | tripwire`(另有内部 `canceled/waiting`)。

## 2. Standard Schema IO 校验

来源:[`@mastra/schema-compat` 的 `standard-schema/standard-schema.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/standard-schema/standard-schema.ts)、[`standard-schema.types.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/standard-schema/standard-schema.types.ts)、[`workflows/utils.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/utils.ts)、[Workflow 参考](https://mastra.ai/reference/workflows/workflow)。

- 内部契约是 **`StandardSchemaWithJSON = StandardSchemaV1 & StandardJSONSchemaV1`**(`@standard-schema/spec` 的类型):`~standard.validate(data)` 负责校验,`~standard.jsonSchema.input/output({target})` 负责出 JSON Schema(发给 LLM provider 等场景)。
- `toStandardSchema()` 归一化各种输入:已实现双接口的直接透传(ArkType、Zod ≥ 4.2、Valibot + `@valibot/to-json-schema` 的 `toStandardJsonSchema`);Zod v4 / Zod v3 / Vercel AI SDK `Schema` / 裸 JSON Schema 对象分别走适配器包装。
- 校验点(utils.ts:27-47 + `handlers/step.ts`):workflow 输入(start 时)、**每个 step 的 input(= 上一步输出)**、resumeData、suspendData、state、requestContext。总开关 `options.validateInputs`(引擎侧默认 `true`)。
- 失败语义:start/resume 的数据校验失败 → 直接抛错、run 不启动;**step 执行期 input 校验失败 → 该 step failed → workflow failed**(文档 [Workflow 参考](https://mastra.ai/reference/workflows/workflow) `validateInputs` 条目)。
- 校验返回值会**替换**原始数据,所以 Zod default/transform 会生效。
- 轻量含义:这层 vendor-neutral 校验的全部运行时成本就是一次 `schema['~standard'].validate(data)` 调用 + 结果归一化,约 20 行(utils.ts:27-47)。重量在 schema-compat 包里给 Zod v3/AI SDK/JSON Schema 互转准备的数千行适配器——只规定"必须实现 Standard Schema"即可全部裁掉。

## 3. 图执行语义(DefaultExecutionEngine)

来源:[Control flow 文档](https://mastra.ai/docs/workflows/control-flow)、[`default.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/default.ts)、[`handlers/control-flow.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/handlers/control-flow.ts)、[`handlers/sleep.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/handlers/sleep.ts)。

`execute()` 的核心就是 `for (let i = startIdx; i < steps.length; i++)`(default.ts:828),按 entry.type 分发到 handler。`startIdx` 在正常启动时是 0;resume/restart/timeTravel 时从快照算出。`stepResults: Record<stepId, StepResult>` 是全执行期的累积表,也是快照的主体。

| 算子 | 运行时语义 | 输出形状 |
| --- | --- | --- |
| `.then(step)` | 顺序执行;上一步输出(校验+transform 后)作为下一步 `inputData` | 透传 |
| `.parallel([a,b])` | `Promise.all` 全并发,无并发上限;任一步抛错则整块失败(容错需在 step 内 try/catch);是同步点,下一步等全部完成 | `{ [step.id]: output }` |
| `.branch([[cond,step]...])` | 条件按定义顺序求值,第一个为真的分支执行;要求各分支 step 的 input/output schema 一致 | 同 parallel 的 keyed 对象,但只有一个 key 有值(下游用 optional 字段接) |
| `.foreach(step, {concurrency})` | 输入必须是数组;默认 concurrency=1(顺序);>1 时用 `fastq` 队列做流式并发(一个槽位空出立刻补下一个,不是分批 `Promise.all`,handlers/control-flow.ts:1054-1226);保序收集;同步点 | 输出数组 |
| `.dowhile/.dountil(step, cond)` | 循环执行直到条件不满足/满足;`cond` 收到 `iterationCount`,可在里面抛错来设最大迭代 | 最后一次迭代的输出 |
| `.map(fn\|config)` | 伪 step:执行期解释声明式映射(`{step, path}`、`{value, schema}`、`{initData, path}`、`{requestContextPath, schema}`、`{template: '${scope.a.b}'}`)或直接跑一个 fn;辅助函数 `getStepResult()/getInitData()/mapVariable()` | 任意 |
| `.sleep(ms\|fn)` / `.sleepUntil(date\|fn)` | 引擎接缝;**default 引擎 = 进程内 `abortableSleep`(setTimeout + AbortSignal,utils.ts:230)**,状态 `waiting`;可被 cancel 打断;fn 形式先跑 fn 动态算时长 | — |

其他语义:

- **重试**:`executeStepWithRetry`(default.ts:436)就是 `for (i <= retries)` + `setTimeout(delay)` 的固定间隔重试;step 级 `retries` 覆盖 workflow 级 `retryConfig {attempts, delay}`。`MastraNonRetryableError` 标记不可重试。
- **嵌套 workflow**:workflow 本身可当 step 用(`.then(nestedWorkflow)`、`.foreach(nestedWorkflow)`),嵌套 run 独立执行,输出汇入父 run。
- **state**:`stateSchema` + `setState` 提供跨 step 共享存储,与 input/output 管道分离,随快照持久化([Workflow state](https://mastra.ai/docs/workflows/workflow-state))。
- **生命周期回调**:`options.onStart`(在首个 step 前,异常会中止启动,可作前置闸门)/`onFinish`/`onError`(异常只记日志不影响结果)。
- **错误出路的两种显式形式**:step 内 `return bail(payload)`(整个 workflow 以该 payload 成功结束)或 `throw`(失败)。

## 4. suspend/resume、快照、time-travel、崩溃重启

来源:[Suspend and Resume](https://mastra.ai/docs/workflows/suspend-and-resume)、[Snapshots](https://mastra.ai/docs/workflows/snapshots)、[Time travel](https://mastra.ai/docs/workflows/time-travel)、[`workflow.ts` Run 方法](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/workflow.ts)、[`types.ts` WorkflowRunState](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/types.ts)。

### 4.1 快照模型

`suspend(payload)` 做的事:当前 step 标记 `suspended` → 捕获 `WorkflowRunState` → `workflowsStore.persistWorkflowSnapshot()` 写入 storage 的 `workflow_snapshots` 表(按 runId)→ 引擎展开退出。快照解剖(types.ts:397-422):

```ts
interface WorkflowRunState {
  runId; status; result?; error?; requestContext?;
  value;               // workflow state
  context: { input } & Record<stepId, SerializedStepResult>;  // 每步的 payload/output/status/起止时间/suspendPayload/resumePayload
  serializedStepGraph; // 可 JSON 化的图镜像,用于 time-travel 校验图未变
  activePaths; activeStepsPath; suspendedPaths; resumeLabels; waitingPaths;
  timestamp; tripwire?; stepExecutionPath?; tracingContext?;
}
```

持久化时机:`createRun`(pending)→ **每个 step 完成后 `persistStepUpdate`**(default.ts 830/968/1052/1127)→ suspend/finish。两个阀门:`options.shouldPersistSnapshot({stepResults, workflowStatus})` 谓词(可按状态裁剪,比如不写 `running`),`options.pruneSnapshot` 写前变换。一切必须 JSON 可序列化,官方建议大数据只存引用。

### 4.2 resume / time-travel / restart:同一机制的三个入口

三者都是"**读快照 → 重建 stepResults → 以非零 startIdx 重进同一个 for 循环**"(default.ts:800-823):

- `run.resume({step, resumeData})`:resumeData 过 `resumeSchema` 校验;`_resume` 先用 CAS(`updateWorkflowState({status:'running', expectedStatus:'suspended'})`)对 suspended run 做**并发 resume 去重**,store 不支持并发更新时降级为警告(workflow.ts:4605-4686)。suspended step 的 `suspendData` 在恢复时回灌给 execute。
- `run.timeTravel({step, inputData?, context?, resumeData?, initialState?})`:从快照(或手工给的 `context`)重建目标步之前的 stepResults,从任意 step 起跳——可以跳到从未执行过的位置(用于单步测试/调试/失败恢复)。**图变了(如 step 改名)会直接报错**,要求 storage。
- `run.restart()`:读快照;若已是终态(success/failed/tripwire)直接重建结果返回、**不重跑**;否则从最后活跃 step 继续(workflow.ts:5000-5119)。只支持 default/evented 引擎。
- `Mastra.restartAllActiveWorkflowRuns()` / `workflow.restartAllActiveWorkflowRuns()`:启动恢复——查 storage 里 `running + waiting` 的 run,逐个 `createRun({runId}).restart()`(workflow.ts:3285-3303)。只对 default 引擎生效;`options.autoRestartActiveRuns: false` 可按 workflow 退出(有不可重入副作用的 workflow 必须退出,因为语义是 **at-least-once:崩溃瞬间正在执行的 step 会整体重跑**)。

### 4.3 持久化依赖矩阵

| 语义 | 无 storage 时 | 依赖 |
| --- | --- | --- |
| then/parallel/branch/foreach/loop/map、校验、重试、bail | 完全可用 | 纯内存 |
| `.sleep()`(default 引擎) | 可用,但进程死则丢失 | 进程内 setTimeout |
| suspend/resume | 不可用 | 快照写/读 + resumeSchema;并发安全还依赖 store 的 CAS |
| time-travel | 不可用(文档明说 "requires storage") | 快照 + serializedStepGraph |
| restart / restartAllActiveWorkflowRuns | 不可用 | 快照 + `running/waiting` 状态扫描 |
| sleep 跨重启存活 | 不可用 | 需要 durable timer(见 §5) |
| run 列表/审计 | 不可用 | storage 查询 |

## 5. 内置引擎 vs 外部 runner 的边界

来源:[Workflow runners](https://mastra.ai/docs/deployment/workflow-runners)、[Inngest 集成](https://mastra.ai/integrations/deploy/inngest)、[Temporal 集成](https://mastra.ai/integrations/deploy/temporal)、[`execution-engine.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/execution-engine.ts)、[`workflows/inngest/src/execution-engine.ts`](https://github.com/mastra-ai/mastra/blob/main/workflows/inngest/src/execution-engine.ts)、[`evented/execution-engine.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/evented/execution-engine.ts)。

mastra 有三个引擎,边界划在 `ExecutionEngine` 抽象类 + DefaultExecutionEngine 的可覆写接缝上:

- **DefaultExecutionEngine**(内置):单进程、单 promise 链;持久化只是把快照写进 mastra storage(默认 libSQL),执行本身不出进程。接缝方法默认实现:`executeSleepDuration/executeSleepUntilDate` = 进程内 sleep;`wrapDurableOperation(id, fn)` = 直接调 fn;`getEngineContext()` = `{}`(default.ts:138-183)。
- **EventedExecutionEngine**(内置,core 包内):同一套语义搬到 `mastra.pubsub` 上——`execute()` 往 `workflows` 主题发 `workflow.start/workflow.resume` 事件、订阅 `workflows-finish` 等结果(evented/execution-engine.ts:61-231)。声明 `schedule` 的 workflow 自动用它。它把"驱动权"从单个 promise 换成事件总线,使多进程/重启后继续成为可能,但要求 PubSub adapter。
- **Inngest**(`@mastra/inngest`):`init(inngest)` 给出 Inngest 版 `createWorkflow/createStep`。`InngestExecutionEngine extends DefaultExecutionEngine`,只覆写接缝(inngest/execution-engine.ts:200-284):
  - sleep/sleepUntil → `inngestStep.sleep/sleepUntil`(durable timer,进程死了也能醒)
  - `wrapDurableOperation` → `inngestStep.run`(step 结果 memoize;重放时跳过已完成 step)
  - `getEngineContext` → `{ step: inngestStep }`
  - 崩溃恢复语义整体换成 Inngest 的 function 级 `retries`(进程崩溃 → Inngest 重新调用函数 → memoized step 跳过 → 从断点继续),控制流(循环/分支/嵌套)仍由 mastra 的解释器跑,只是每个原语落在 Inngest step 上;suspend/resume、监控走 Inngest 的事件与 dashboard。mastra storage 仍用于状态跟踪。
- **Temporal**(`@mastra/temporal`,官方标注 experimental):思路不同——构建期插件把每个 `createStep` 改写成 Temporal activity、每个 `createWorkflow` 改写成 Temporal workflow;durable execution/重试/状态全归 Temporal。约束:workflow id 必须是静态字符串字面量、worker 必须是长驻进程。

**哪些语义本质上依赖持久化层**:suspend/resume(等待态必须比进程长寿)、跨重启的 sleep(durable timer)、崩溃后续跑(memoization 或快照+restart)、time-travel(历史快照)、resume 去重(原子 CAS)。**不依赖的**:图结构、控制流、校验、重试、并发——这些都是纯解释器逻辑,Inngest/Temporal 集成也仍然复用 mastra 的解释器(Temporal 除外,它连解释器都换掉)。

## 6. 对"极致轻量"引擎的含义

事实侧的体量证据(本版本 main):`workflow.ts` 202,869 字符,`default.ts` 45,820,`handlers/` 合计约 97,000,`types.ts` 51,402;这还没算 evented 引擎(~150,000 含 100KB 的 evented/workflow.ts)、schema-compat 的 JSON Schema 互转器、streaming/observability。也就是说,**绝大部分重量不在语义,而在持久化钩子、流式事件、tracing、多引擎适配与类型体操**。

**语义核心的最小集**(从 mastra 的事实里抽出来的必要条件):

1. **Step = { id, inputSchema, outputSchema, execute(ctx) }**,ctx 至少含 `inputData/getStepResult/runId/abortSignal`。
2. **Builder → 扁平 entry 列表**(then/parallel/branch/foreach 四件套即可覆盖绝大多数图;dowhile/dountil 是带条件的循环糖,map 是纯函数糖)。`.commit()` 冻结定义,类型上用 type-state 串联 IO。
3. **边界校验 = Standard Schema `~standard.validate`**,vendor-neutral、零适配器(不支持裸 JSON Schema/Zod v3 归一化即可砍掉整个 schema-compat 层)。
4. **执行器 = 一个 for 循环**;parallel 用 `Promise.all`,foreach 用一个并发闸;结果是 `{status, steps: Record<id, StepResult>}`。
5. **(可选,也是最大的分叉点)suspend/resume**:如果要做人工介入/长等待,语义上只需三件事——step 内的 `suspend(payload)` 控制信号、一个可 JSON 化的 `stepResults + 位置` 快照、一个 `load → 从 startIdx 重进循环` 的恢复路径。**把快照存储做成 port(接口)而非内置实现**,引擎本体就保持轻量;time-travel、restart、restartAllActiveWorkflowRuns 都是同一快照机制上的免费变种(各约几十行),要或不要可以独立决策。
6. **durable sleep 是引擎接缝而非核心语义**:default 实现用 setTimeout,要 durable 的人去对接外部 runner——mastra 自己的接缝划分(§5)就是现成证据。

**可以裁掉的重量**:多 storage adapter、快照 prune/shouldPersist 钩子体系、resume CAS 去重(单进程内用 Map 即可)、serializedStepGraph 与确定性 mapping id(只有跨进程 time-travel 才需要)、streaming/observeStream、tracing 上下文序列化、scorers、evented 引擎、Inngest/Temporal 适配、schedule/cron、agent/tool/classifier 特化 step。

## 附:源码索引(main @ 2026-09-28)

| 文件 | 职责 |
| --- | --- |
| `packages/core/src/workflows/create.ts` | `createWorkflow`/`cloneWorkflow`;schedule → evented 引擎 |
| `packages/core/src/workflows/step.ts` | `Step` 接口、`ExecuteFunctionParams`、`getStepResult` |
| `packages/core/src/workflows/workflow.ts` | `Workflow` builder + `Run`(start/resume/restart/timeTravel/cancel/stream) |
| `packages/core/src/workflows/execution-engine.ts` | `ExecutionEngine` 抽象类、生命周期回调 |
| `packages/core/src/workflows/default.ts` | `DefaultExecutionEngine`:for 循环 walker、重试、引擎接缝默认实现 |
| `packages/core/src/workflows/handlers/{step,control-flow,sleep,entry}.ts` | 各 entry 类型的执行 + `persistStepUpdate` |
| `packages/core/src/workflows/evented/` | pub/sub 事件驱动引擎 |
| `packages/core/src/workflows/types.ts` | `StepFlowEntry`、`WorkflowRunState` 等类型 |
| `packages/core/src/workflows/utils.ts` | `validateWithStandardSchema`、`abortableSleep` 等 |
| `packages/schema-compat/src/standard-schema/` | Standard Schema 双接口契约与归一化 |
| `workflows/inngest/src/execution-engine.ts` | Inngest 引擎:接缝覆写 = Inngest 原语 |
