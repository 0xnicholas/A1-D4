# Harness 语义集:文档分类非模块;收 durable 挂起/基础 signals/schedules tick 三件套最小集

Harness = **文档分类**,不是统一模块——mastra 源码里 `Harness` 已只是 `AgentController` 的废弃别名,7 项能力相互独立、6 项 Beta,重量集中在存储域、PubSub+租约、长驻 worker 循环三个底层原语。轻量落法:收三件套最小集——**durable agents 只留工具调用边界的审批挂起**(loop 快照 = 消息列表 + step 计数 + 挂起点,走新增 `AgentRunSnapshotStore` port;`createDurableAgent` 包装,Harness 持有 agent;`finishReason` 增 `'suspended'`,仅包装内产生;`approved: false` 以工具结果回喂模型);**基础 signals 进核心**(sendMessage/queueMessage/sendSignal/subscribeToThread,内存 pubsub + thread 注册表,注入内容落消息历史故零新存储;agent loop 唯一改动 = step 边界注入缝,缺席零开销);**schedules 只留记录 CRUD + `tick` 原语**(新增 `ScheduleStore` port;cron 解析注入、核心零依赖;平台 cron 打 endpoint 是一等形态,`startTicker` 为可选单进程便利件)。存储面遵守 #15 的 port 集合哲学:port 清单扩为四个、统一 adapter 家族、无 CAS、无 harness 专属域。runtime 立场:核心永远不要求长驻进程,跨实例能力(共享 PubSub、租约、leader election)整体归能力包。background tasks / goals / state signals 延后入雾;notification inbox / signal providers / AgentController 出域。

## Considered Options

- **Harness 作统一子系统(Harness 类持有各能力)**:被否——mastra 自己已把 Harness 降为文档分类名;统一模块与按需组合直接冲突。
- **durable 收全量(每步 running 检查点 + 崩溃重跑 + resumable stream + 多副本恢复)**:被否——重发 LLM/工具副作用的幂等负担转嫁用户,多副本需自建 leader election;mastra 自己也把生产 durability 外包给 Inngest。崩溃恢复、resumable stream、`observe()`、工具内 `suspend()` 同裁。
- **HITL 审批留在核心 agent 内建**:被否——#10 已定移交;核心 loop 保持无快照,挂起语义只存在于 durable 包装内。
- **审批声明放 Tool 字段(requireApproval)**:被否——#13 钉死核心零权限、Tool 四字段冻结;声明归 durable 层 `approval.tools`。
- **background tasks 收进程内 deferred 版(无恢复)**:被否(延后)——`untilIdle` 续轮改动 agent 流的完成语义,而「工具 ack + sendSignal 唤醒」已从原语组合出同等效果;mastra 该 API 仍 Beta 漂移。
- **goals 收**:被否(延后)——mastra 侧「无新基础设施」的前提是有 thread-state 存储域,本框架 MemoryStore 无此域且形状冻结;judge 每轮一次 LLM 调用是常驻成本;可先用 Processor + working memory 原型化。
- **schedules 收 mastra 式轮询调度器 + 存储 CAS 认领**:被否——长驻轮询假设违反 ADR-0001,serverless 下 mastra 自身无替代;cron 解析(croner 级)进核心破零依赖红线。触发记录(trigger history)同裁,observability span 已覆盖。
- **state signals / notification inbox / signal providers 收**:被否——state signals 可被 working memory + Processor 组合(延后);inbox 需专属存储域且 mastra 仅 3 adapter 支持(裁出);providers 订阅登记簿持久化要 DIY(示例模式)。
- **AgentController / session 语义进规范**:被否——成品级编码 agent 运行时,官方自承可用 Agent 类组装;「thread 持久 / live 内存」分层已隐含于既有决议。
- **Harness 持久化自带一层(harness 专属存储域)**:被否——#15 已定 port 集合 + 统一 adapter 家族;新增两个最小 port 按同构模式扩展。

## Consequences

- `finishReason` 四值改五值(`agent.md` 修订);agent loop 增 step 边界注入缝——核心为 Harness 开的唯一口子,缺席零开销。
- `storage.md` port 清单由两个扩为四个;additive-only 纪律同样约束两个新 port。
- 地图雾区新增:background tasks、goals、state signals、跨实例 signals(共享 PubSub+租约)与外部 runner 能力包方向;出域新增:notification inbox、signal providers 框架内置、AgentController/session 语义。
- 「决策:多 agent 协作语义」(#19)不受阻;「决策:粗粒度实施路线图」(#16)在 #19 关闭后解除阻塞,获得 harness 三件套的 build 输入。
- workflows 侧确认不加新机器:无 boot 自动恢复(`listSnapshots` + `resume` 归应用)、无 durable timer(长等待 = schedules + suspend 组合)。

(来源:wayfinder ticket #18)
