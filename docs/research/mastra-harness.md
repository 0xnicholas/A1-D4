# 调研:Mastra Harness 子系统

> 研究 ticket:#17。日期:2026-09-28。调研时的 mastra 版本:`@mastra/core@1.72.0-alpha.4`。
> 一手来源:mastra 官方文档 Harness 栏目 7 个页面 + GitHub 仓库 `mastra-ai/mastra` 的 `packages/core/src` 源码。文中每个论断附来源链接。
>
> 定位提醒:本框架的设计目标是"极致轻量",本文只做事实呈现 + 轻量化取舍含义,不做架构决策。

## TL;DR

Mastra 文档中的 "Harness" 是把 agent 从"请求-响应式调用"升级为"长期在线协作者"的一组能力的总称,含 7 个文档页:Durable Agents、Background Tasks、Goals、Schedules、Signals、Signal Providers、Agent Controller。值得注意的是,**在 mastra 源码里 `packages/core/src/harness` 模块本身只是 `AgentController` 的废弃别名**(`Harness = AgentController`,标注 "will be removed in a future major release")——"Harness" 如今只是文档分类名,不是一个统一模块。

这套能力的重量集中在三个底层原语上:**存储域(storage domains)、PubSub(+缓存+租约)、长驻 worker 循环(调度轮询、租约心跳、provider 轮询)**。7 项能力里 6 项标注 Beta,均在 `@mastra/core@1.29.0`–`1.50.0`(2025 下半年至 2026)间新增,API 仍在快速变动。对一个最小持久化、edge/serverless 友好的轻量框架,合理的分层是:基础 Signals(sendMessage/sendSignal + 内存 pubsub)与 Goals 成本最低可早做;Background Tasks 与 Durable Agents 的崩溃恢复层最重,可砍到"无恢复的内存版"或延后;Schedules 在 serverless 下应改为"平台 cron 打 endpoint"模型;AgentController 是面向编码 agent 产品的成品级运行时,整体超出轻量框架范围。

## 1. 总览:Harness 在 mastra 里到底是什么

- 文档侧:`docs/harness/` 下 7 页([llms.txt 索引](https://mastra.ai/llms.txt))。
- 源码侧:[`packages/core/src/harness/index.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/harness/index.ts) 全文是 deprecated 注解:"The canonical implementation now lives in `@mastra/core/agent-controller`… provides the deprecated `Harness`/`Harness*` aliases." 即 **Harness 类已更名 AgentController**,harness 目录只留兼容层。
- 各能力的实际源码位置:`agent/durable/`、`background-tasks/`、`schedules/`、`signals/`、`agent-controller/`,以及存储侧 `storage/domains/{background-tasks,schedules,notifications,harness,thread-state,memory,workflows}`([源码目录](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/storage/domains))。
- 版本与稳定性([各文档页页首](https://mastra.ai/docs/harness/durable-agents)):Background Tasks `@mastra/core@1.29.0`;Signals/Signal Providers `1.39.0`;Goals `1.42.0`;Durable Agents `1.45.0`;Schedules `1.50.0`。除 Background Tasks 外全部标注 **Beta**:"Breaking changes may occur without a major version bump until the API is stable."
- 重量参照:[`packages/core/package.json`](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json) 有 30 个直接依赖(`hono`、`execa`、`ws`、`posthog-node`、`croner`、`re2js`、3 个 `@ai-sdk` 主版本并存等)。

## 2. 逐项能力

### 2.1 Durable Agents([文档](https://mastra.ai/docs/harness/durable-agents))

**与普通 agent 的区别**:普通 `Agent` 的 `stream()/generate()` 是请求作用域的——客户端断开即丢失流、进程崩溃即丢失运行。durable agent 用 `createDurableAgent({ agent })` 包装普通 agent,把 agentic loop 放进一个 workflow 里跑,叠加三层:

1. **Workflow 执行**:`stream()` 把消息与选项序列化为 workflow input,loop 在 durable workflow 中执行,每步可 memoize/replay。
2. **PubSub 流式**:chunk 发布到以 runId 为键的 PubSub topic,调用方订阅并管道进 `ReadableStream`。
3. **缓存层**:默认内存缓存,生产用 Redis;存已发布事件,迟到订阅者可补播(resumable stream)。

**API 形状**:`stream()` 返回 `{ output, runId, cleanup }`;`observe(runId)` 从另一客户端重接流(返回 `{ output, detach }`);`resume(runId, { approved })` 恢复工具审批挂起;`cleanupTimeoutMs` 自动清理。**三个工厂对应三种执行体**:`createDurableAgent()`(进程内,`@mastra/core`)、`createEventedAgent()`(fire-and-forget 后台执行)、`createInngestAgent()`(`@mastra/inngest`,步级 memoize/重试/监控面板,面向生产)。

**持久化与崩溃恢复**(这是最关键的事实):

- 默认持久化策略(`recovery.durableAgents: 'off'`,默认):**只写 `pending`/`paused`/`suspended` 快照**(人机回环 resume 所需),**不写每步 `running` 检查点**。即默认配置下崩溃后 in-flight run 不可恢复。
- `recovery.durableAgents: 'auto'`:每步写 `running` 检查点到 storage;启动时 `recoverAllDurableAgents()` 发现卡在 `running` 的 run 并从最近快照重跑。也可手动 `recoverActiveRuns()`。
- 文档明确警告:恢复 = 从快照重跑 loop,**会重发 LLM 调用(真实成本)并可能重放工具副作用**;子 agent 委派不独立检查点,重放时整个子 run 重跑。结论:工具必须幂等。
- 多副本部署:Mastra 不提供分布式锁,各副本 `auto` 会抢同一批 run,需自行 leader election。
- resumable stream 的缓存默认是内存的,跨进程恢复需要 Redis;缓存写失败时事件仍实时投递但不可补播;发布延迟受缓存往返约束。

**事件溯源**:evented agent 永远持久化全量快照(其执行模型以 storage 协调 worker);Inngest agent 只持久化 `suspended`(durability 交给 Inngest replay)。

### 2.2 Background Tasks([文档](https://mastra.ai/docs/harness/background-tasks);源码 [`background-tasks/manager.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/background-tasks/manager.ts))

**抽象**:工具调用不再阻塞 agentic loop——工具立即返回 ack,LLM 继续输出;任务在后台跑完,结果写入 memory;若 `stream({ untilIdle: true })`,agent 被自动重新唤起处理结果,同一条流里出现"初始轮 + 后续 continuation 轮"。

**API 形状**:

- 开关在 Mastra 实例:`backgroundTasks: { enabled, globalConcurrency, perAgentConcurrency, backpressure: 'queue', defaultTimeoutMs }`。
- 资格判定三层:工具级 `background: { enabled, defaultDisposition, timeoutMs, maxRetries }` → agent 级 `backgroundTasks.tools`(可按工具覆盖或 `'all'`)→ LLM 单次调用参数里的 `_background` 字段(disposition `foreground|deferred|awaited`,只能修改已 opt-in 的工具,不能新启用)。
- 挂起/恢复:工具在 `execute` 内调 `suspend(data)`(持久化 `suspended` 状态 + workflow 快照,释放并发槽);外部 `mastra.backgroundTaskManager.resume(taskId, resumeData)` 恢复。**进程重启后 executor 闭包丢失,resume 前必须 `registerTaskContext(taskId, …)` 重新注册**。
- 观测:`manager.stream({ agentId, runId, threadId, resourceId, taskId, abortSignal })` SSE(7 种 manager chunk:running/output/completed/failed/cancelled/suspended/resumed;agent 流自身另有 started/progress);`getTask`/`listTasks` 直接读 storage。

**持久化机制(源码证实)**:文档页首注明 "Background tasks require a configured storage backend… Tasks are persisted so they survive process restarts"。manager.ts 实现了**执行租约**:`ownerId` + `leaseExpiresAt` 持久化在任务行上,`leaseDurationMs` 默认 30s(下限 3s),心跳每 `leaseDurationMs/3` 续租;worker 死亡 → 停续 → 租约过期 → 其他 worker 安全回收任务。崩溃恢复不靠重放,靠租约过期 + 重新认领。

### 2.3 Goals([文档](https://mastra.ai/docs/harness/goals))

**抽象**:durable、thread 作用域的"持续目标"——一条站立指令,agent 跨 loop 迭代持续朝它工作,直到 judge 模型判定满足或预算(`maxRuns`,默认 50)耗尽。与 `isTaskComplete`(单次 `stream()` 调用级的完成判定)共用 LLM-as-judge 机制,区别在于 goal **持久化在 thread state**、通过 `Agent` 方法而非每次调用选项来设置。

**API 形状**:`new Agent({ goal: { judge, maxRuns, prompt?, scorer? } })`;`agent.setObjective(text, { threadId, resourceId })` / `getObjective` / `updateObjectiveOptions` / `clearObjective`(非 memory-backed 时全部 no-op)。配置解析优先级:per-objective 记录 → agent `goal` config → 内置默认。`goal` 配置自动注册 state-signal 投影,模型上下文中始终可见 `<current-objective>`。

**运行语义**:goal step 在 loop 内 `isTaskComplete` 之后执行;不满足且有余量 → 注入反馈继续;满足 → 停并标记 `done`;预算耗尽 → 停并标记 `paused`(可调高 maxRuns 后恢复)。对 background-task、tool-loop 中途、working-memory-only 的迭代是 no-op。**judge 模型是激活开关**:解析不出 judge 则整步 no-op。每次评估发 `goal` 流 chunk(`GoalEvaluationPayload`)供 UI 显示进度。

**依赖**:必须有 storage + memory-backed thread;每轮迭代一次 judge LLM 调用(持续成本)。

### 2.4 Schedules([文档](https://mastra.ai/docs/harness/schedules);源码 [`schedules/schedules.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/schedules/schedules.ts)、[`workflows/scheduler/scheduler.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/scheduler/scheduler.ts))

**抽象**:cron 驱动的 agent 触发器。每次触发两种模式:无 `threadId` → 隔离的 `agent.generate()`(threadless);有 `threadId`(必须带 `resourceId`)→ 以 signal 形式注入会话(threaded),可带 signal type、XML tagName/attributes、`ifActive`/`ifIdle` 行为(deliver/persist/discard、wake/persist/discard),全部要求 JSON 可序列化。同一服务也管 workflow schedule(传 `workflowId`)。

**API 形状**:`mastra.schedules.create/get/list/update/pause/resume/run/delete`;cron 支持 5/6/7 段表达式 + croner 昵称(`@hourly` 等),`timezone` 用 IANA 时区;可传自定义 `id`(规范化加前缀)。Mastra 级生命周期 hooks:`prepare`(可覆盖本次触发参数或跳过)/`onFinish`/`onError`/`onAbort`,扁平一组、按 `agentId` 区分。client-js 有对应 `/api/schedules` 路由。

**持久化与运行时(源码证实)**:

- 调度行持久化(`nextFireAt` 等字段),survive restarts/redeploys;**要求 storage adapter 实现 schedules domain**。
- 调度器是**轮询循环**:`setInterval` 定期从 storage 捞 `nextFireAt <= now` 的行,用 compare-and-swap 原子推进 `nextFireAt` 来认领本次触发——**多实例安全来自存储 CAS,不是分布式锁**;注释明确 "Only one instance across many polling the same storage can claim a fire"。
- 认领后向 PubSub topic(`agent-schedules`)发 fire 事件,`AgentScheduleWorker`(pull transport,分组消费)执行 `sendSignal` 或 `agent.generate`,并回写 trigger 记录关联 runId。
- 这意味着:**必须有一个长驻进程跑轮询循环**(或外部东西驱动 tick);serverless 平台上 mastra 自己没有替代方案。cron 解析用 `croner`(core 直接依赖)。

### 2.5 Signals / Webhooks([Signals 文档](https://mastra.ai/docs/harness/signals)、[Signal Providers 文档](https://mastra.ai/docs/harness/signal-providers);源码 [`signals/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/signals))

**抽象**:把与 agent 的交互从"每次 `agent.stream()`"改为"订阅 thread + 向 thread 投递"。分层 API:

- 用户消息:`sendMessage()`(活跃 run 立即注入;空闲则唤醒新 run)、`queueMessage()`(等当前 run 完再开新 run,保序)、`cancelQueuedMessages()`(经 PubSub 广播,跨进程生效但不确认远端)、`abortThreadStream({ clearPendingSignals })`。
- 系统信号 `sendSignal()`:`type`(user/notification/reactive/state)+ LLM 侧 `tagName`,渲染成 XML(`<notification source="github" pr="123">…</notification>`);`ifActive`/`ifIdle` 分支行为 + 分支 attributes;`ifIdle.streamOptions` 可给唤醒 run 传参。返回 `{ persisted }` 等可 await 的确认。
- State signals:`sendStateSignal()` 命名的 thread 作用域状态车道(snapshot/delta + 生产者 cacheKey 去重);processor 侧 `computeStateSignal()` 每个 input step 调用一次,负责 diff/merge,`contextWindow.hasSnapshot` 提示是否需要补快照。
- Notification signals:`sendNotificationSignal()` 写**持久化 inbox 记录**,两阶段投递(ingress 存记录 + 解析投递策略;dispatch 消费到期记录,紧急直发、低优批量摘要 `<notification-summary pending="10">…`);`createNotificationInboxTool()` 给 agent 一个 inbox 工具;投递策略 agent 级配置,定时 dispatch 在 Mastra 级开启。**inbox 存储只有 libSQL/PostgreSQL/MongoDB 三个 adapter 支持**(`getStore('notifications')`)。
- 订阅:`agent.subscribeToThread({ resourceId, threadId })` 拿活跃流;HTTP 路由 `POST /api/agents/:id/send-message` 等;serverless 下自建 SSE 需要 heartbeat 帧保活。

**分布式语义(对轻量框架最重要的一段)**:signals 靠 PubSub 协调。默认内存 pub/sub **不能跨实例**;serverless/多实例下 follow-up signal 可能被路由到另一个实例,导致"够不到活跃 run、各开新 run、thread 被处理两遍"。解法:`RedisStreamsPubSub`(同时实现事件投递与 `LeaseProvider` 分布式租约,单进程一个 owner)。无 leasing 的后端退化为"永远授予所有权"的 no-op——单进程没问题,多实例不安全。

**Signal Providers(webhook 入口)**:`SignalProvider` 基类 = 订阅登记簿(**内存、进程内**;要持久化需自己存并在 `start()` 里 rehydrate)+ 摄取(覆盖 `poll()` 或 `handleWebhook()`)+ 投递(`notify()` 保护方法)。`pollInterval` 驱动轮询(跳过无订阅周期、不重叠)。`handleWebhook()` **只是方法不是自动挂载的路由**,要从自己的 endpoint 调它。通用场景有现成 `WebhookSignalProvider`(配置 `extractResourceId` + 可选 `buildNotification`)。provider 可附 processors/tools 合并进 agent。

### 2.6 AgentController Sessions([文档](https://mastra.ai/docs/harness/agent-controller);源码 [`agent-controller/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/agent-controller)、[`storage/domains/harness/types.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/harness/types.ts))

**三层寿命模型**:

- **Controller**:共享宿主(配置、storage、workspace、modes、channels),`init()` 一次复用。
- **Session**:一个用户/任务/scope 的**隔离 live 运行时**——持有活跃 mode、model、任意 `session.state`、事件总线、run 状态、权限授予、当前 thread 绑定。`createSession({ resourceId, scope?, threadId? })` 按 `resourceId+scope` get-or-create;不同 scope 的 session 互不可见(独立事件总线/状态/模式选择),但底层 thread 同属一个 resourceId。
- **Thread**:持久化会话(消息 + thread settings),可跨进程存活。

**持久化边界(文档原话级事实)**:"A Session is live state. Arbitrary session.state, permission grants, pending approvals, and active runs don't automatically survive process recreation. Thread messages and selected thread settings, including mode and per-mode model choices, can persist through storage." 审批闸在内存:"every approval answered after a restart is stale. Mastra never runs the tool for a stale action"(配 `onStaleToolApproval` 钩子善后)。文档明确建议 channel 场景"use a long-lived server"。源码侧 `HarnessStorage` 域确实有 `SessionRecord` 持久化(loadSession/saveSession/listSessions,含 modeId/modelId/pending 项/closing/closed 生命周期),但 live 闸门与 run 状态仍是内存的。

**事件与 API**:`session.subscribe(event => …)`(`message_start`/`message_update` 增量 delta/`message_end`、`display_state_changed`、`tool_approval_required`、`tool_suspended`);`sendMessage`、`mode.switch/get`、`model.switch({ scope: 'thread'|'global' })`、`thread.create/list/switch`、`state.get/set`(可配 `stateSchema` 校验)、`permissions.setForCategory/setForTool`(allow/deny/ask)、`respondToToolApproval` / `respondToToolSuspension`、`subagents.model.set/get`。Modes 支持 `transitionsTo`(plan→build)与每模式工具面(`additionalTools`/`availableTools`)。子 agent 支持 `forked: true`(克隆父 thread)。Channels(Slack 等)经 `/api/agent-controllers/<id>/channels/<platform>/webhook` 接入,`resolveResourceId`/`resolveSession`(可拒绝建会话)/`onSessionStart` 钩子。浏览器端走 client-js(`subscribe({ reconnect: true })`,**断线期间事件不重播**,`onReconnect` 里需重读 `session.state()`)。

**定位**:这是 mastra 自家产品(Mastra Code、Factory)抽出的成品级交互式编码 agent 运行时,文档自承"You could assemble all of this yourself on top of the Agent class"。

## 3. 依赖矩阵:什么必须持久化,什么必须长驻

| 能力 | 存储依赖 | 长驻进程依赖 | 跨实例依赖 |
|---|---|---|---|
| Durable Agent(默认策略) | workflow 快照(仅 pending/paused/suspended,HITL 必需) | 否(无恢复时同普通 agent) | 否 |
| Durable Agent(崩溃恢复) | + 每步 `running` 检查点(仅 `recovery:'auto'` 时写) | 需 boot 时跑 `recoverAllDurableAgents()`;多副本需自建 leader election | 恢复竞态需自管 |
| Durable Agent(resumable stream) | 事件缓存(默认内存,生产 Redis) | 单进程内可玩;跨进程重连需 Redis | PubSub + cache 共享 |
| Background Tasks | **必须** storage(任务行 + 执行租约 ownerId/leaseExpiresAt) | **必须**:30s 租约 + /3 心跳;轮询/回收循环 | 租约过期天然支持多 worker 回收 |
| Goals | **必须** storage + memory thread | 否(judge 在 loop 内同步跑) | 否 |
| Schedules | **必须** storage schedules domain(nextFireAt + CAS) | **必须**:setInterval 轮询循环;无 serverless 替代 | 存储 CAS 认领,多实例安全 |
| Signals(基础) | thread/消息经 memory(可选) | 单进程内存 pubsub 即可 | **跨实例必须共享 PubSub + LeaseProvider(如 Redis Streams)**,否则 thread 双跑 |
| Notification inbox | **必须** notifications 域(仅 libsql/pg/mongo 三 adapter) | 定时 dispatch 需长驻 | 同上 |
| Signal Providers | 订阅登记簿默认内存,持久化 DIY | `poll()` 模式必须;webhook 模式只需 HTTP 路由 | 否(每进程各自登记) |
| AgentController | thread + thread settings + SessionRecord | **强烈建议**:live session/审批闸全在内存,重启后审批一律 stale | 否 |

## 4. 轻量化含义(保留 / 裁剪 / 延后)

按"mastra 的实现重量来自哪"拆解,给后续决策的事实输入:

**成本最低、价值核心,适合早做**
- **基础 Signals**(`sendMessage`/`queueMessage`/`sendSignal` + `subscribeToThread`):单进程下只需一个内存 PubSub + 线程注册表,是"长期在线 agent"交互模型的地基;mastra 的分布式复杂性(租约、Redis Streams)全部来自多实例,单进程/单实例下可以完全不做。
- **Goals**:机制 = thread state 里一条记录 + loop 内一个 judge 调用 + 预算计数,无新基础设施(复用 memory 即可)。成本是每轮一次 judge LLM 调用(可裁剪点:允许 pluggable scorer,用户可换规则判定)。

**可大幅裁剪后保留**
- **Durable Agents**:mastra 默认策略本身就揭示了最小有用子集——**只持久化 pending/paused/suspended 快照**就能支持 HITL 挂起/恢复,这是轻量框架值得做的部分;每步 `running` 检查点 + 崩溃重跑(重发 LLM/工具副作用的幂等负担转嫁给用户)+ resumable stream 缓存 + 多副本恢复租约,是重量级部分,可整体延后。Inngest 变体的存在说明 mastra 自己把"真生产 durability"外包给了外部执行平台——轻量框架可以同样声明"durability 交给平台/用户"。
- **Background Tasks**:mastra 版 = 存储域 + 执行租约 + 心跳 + 恢复 + SSE 管理流,是 Harness 里最重的一块。轻量替代:进程内 deferred 执行(立即 ack、完成写 memory、`untilIdle` 续轮)不要崩溃恢复;租约/回收整个砍掉,进程死 = 任务丢(文档化语义)。suspend/resume 若不做持久化则退化为进程内 promise 闸。
- **Schedules**:轮询调度器 + 存储 CAS 是为多实例长驻服务器设计的。edge/serverless 友好的形态:**只保留 schedule 记录的 CRUD 与"到期计算"(croner 或等价),触发交给平台 cron(Cloudflare Cron Triggers、Vercel Cron)打 HTTP endpoint**;单实例自托管时再给一个可选的内存 ticker。mastra 的 threaded 触发完全复用 signals,说明 schedule 本身不需要新运行时。

**整体超出轻量范围,建议延后/不做**
- **Notification inbox + 投递策略**:持久化 inbox、优先级批量摘要、定时 dispatch,且 mastra 只有 3 个存储 adapter 支持——明显的产品级功能。轻量框架保留 `sendSignal({ type: 'notification' })` 的即时注入即可覆盖大部分场景。
- **Signal Providers**:基类很薄(登记簿 + poll/webhook + notify),但订阅持久化是 DIY 的;可作为示例模式而非框架内置。
- **AgentController**:成品级应用运行时(modes、权限策略、channels、workspace、display state),官方定位是 Mastra Code/Factory 的宿主,且明示可用 Agent 类自行组装。轻量框架最多吸收其"Session = resourceId+scope 的 get-or-create 句柄"与"thread 持久化 / session 内存"的寿命分层这两个概念。

**一条贯穿性事实**:mastra Harness 的每一项能力都是"在 Agent/Memory/Workflow 原语之上的编排层",没有一项需要改动 agent loop 本体——这验证了轻量框架可以按能力逐个增量落地,而不必先建一个大运行时。同时 6/7 项 Beta、源码内 Harness→AgentController 的整体改名,说明这套 API 面仍在快速漂移,过早对齐其具体 API 形状有跟随成本。

## 5. 来源清单

文档(抓取于 2026-09-28):
- [Durable agents](https://mastra.ai/docs/harness/durable-agents) · [Background tasks](https://mastra.ai/docs/harness/background-tasks) · [Goals](https://mastra.ai/docs/harness/goals) · [Schedules](https://mastra.ai/docs/harness/schedules) · [Signals](https://mastra.ai/docs/harness/signals) · [Signal providers](https://mastra.ai/docs/harness/signal-providers) · [Agent Controller](https://mastra.ai/docs/harness/agent-controller) · [llms.txt 索引](https://mastra.ai/llms.txt)

源码(`mastra-ai/mastra`,`main` 分支):
- [`packages/core/src/harness/index.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/harness/index.ts)(Harness = AgentController 废弃别名)
- [`packages/core/src/agent/durable/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/agent/durable)(create-durable-agent / create-evented-agent / run-registry / types)
- [`packages/core/src/background-tasks/manager.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/background-tasks/manager.ts)(执行租约、心跳、回收)
- [`packages/core/src/schedules/schedules.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/schedules/schedules.ts) · [`schedules/worker.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/schedules/worker.ts) · [`workflows/scheduler/scheduler.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/scheduler/scheduler.ts) · [`workflows/scheduler/cron.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/scheduler/cron.ts)(轮询 + CAS 认领 + croner)
- [`packages/core/src/storage/domains/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/storage/domains)(background-tasks / schedules / notifications / harness / thread-state 等域)与 [`harness/types.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/harness/types.ts)(SessionRecord)
- [`packages/core/package.json`](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)(v1.72.0-alpha.4,30 个直接依赖)
