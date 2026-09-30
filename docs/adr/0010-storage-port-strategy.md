# 存储适配策略:两个独立最小 port + 统一 adapter 家族,additive-only 演化

存储层 = port 集合 + adapter 家族,不是子系统。port 保持两个独立最小形状(`MemoryStore` 6 必备 + 2 条件、`WorkflowSnapshotStore` 2 方法 + JSON-only,均冻结),一个 adapter 包可实现其一或两者;不做 mastra 式分域 composite——其存在前提是强制中央实例,而本框架组合根可选(ADR-0002),子系统各自接收 store 实例,分后端是用户侧自由;观测不设 storage port(span 走 exporter 流式模型,ADR-0009)。扩展面与 semver 共用一条纪律:基础 port 冻结,新能力只以**可选方法 + 能力标志**增加(存在性即声明,缺席降级),必需方法签名 1.0 起永不改,breaking 只在 major——跨进程 resume CAS、快照 delete/list 均按此模式作可选扩展。第一方 adapter = 核心内存实现 + 恰好一个 SQLite 系参考 adapter 能力包(兼作 port 的真实后端验证,build 时机归 #16),其余后端留社区;连接生命周期 adapter 自拥(`init?()`/`close?()`),核心永不隐式调用、不 hook 进程。

## Considered Options

- **单一合并 `Storage` 接口(两 port 并集)**:被否——两个子系统的用户被迫看到无关方法,且推翻已钉形状;分离 port 不妨碍一个包实现两者。
- **轻量版 composite 域路由**:被否——为一个不存在的中央实例需求发明概念;用户要分后端直接传不同实例。
- **CAS 进基础 port 强制实现**:被否——内存版与单进程用户被迫假装支持;可选扩展 + 能力标志已有 `MemoryStore` 条件 2 的先例。
- **多个第一方 durable adapter(PG / Redis 等)**:被否——小团队维护面撑不住;规范附 adapter 作者指南,社区可补。
- **port 长期 Beta 标注(mastra 式「breaking 可无 major」)**:被否——port 是唯一面向生态作者的契约,不确定的稳定性对 adapter 生态是寒蝉效应。
- **核心托管存储连接生命周期(进程 hook / `settled()` 式)**:被否——与无运行时负担冲突;生命周期归 adapter 自拥、应用或组合根调用。

## Consequences

- 「决策:Harness 语义集」(#18)解除阻塞;其 durable 执行的存储输入 = 本规范 port + 可选扩展,lease / PubSub / 调度等存储域不在此预建,#18 需要时按同模式扩展。
- 「决策:粗粒度实施路线图」(#16)获得 SQLite 参考 adapter 的 build 时机判断输入;驱动选型(`node:sqlite` vs libsql)依赖 Node 版本基线,入地图雾区。
- 后续一切子系统的持久化新增需求只能以「可选方法 + 能力标志」落地,或等 major——additive-only 纪律自此约束所有 port 演化。
- **修订(M5 SQLite 参考 adapter 设计冻结,2026-09-30)**:第一方 SQLite adapter(`@balsa/sqlite`,全四 port)冻结为 spec 直落态,依据 [决策:SQLite 参考 adapter](https://github.com/0xnicholas/balsa-framework/issues/76) 决议评论与 `docs/architecture/storage.md`「SQLite 参考 adapter(M5 设计冻结)」节:
  - **驱动与基线**:`node:sqlite`(0 依赖);engines 基线抬至 `>=22.13.0`(22.12 需 `--experimental-sqlite`,ADR-0014 修订);libsql 因原生二进制与本地并发写限制排除。
  - **包面**:`createSqliteStorage({ path, busyTimeoutMs? })` → `{ memory, workflowSnapshots, agentRunSnapshots, schedules, init(), close() }`;单连接、不暴露原始句柄;`init()` / `close()` 幂等,未 init 用 port 方法抛错。
  - **表结构与编码**:六表 `threads` / `messages` / `resources` / `workflow_snapshots` / `agent_run_snapshots` / `schedules`(STRICT);`Date` → INTEGER ms;可选字段缺席 = NULL(读回省略);JSON 文本列(`metadata` / `working_memory` / `target` / 快照 `payload`);`messages.thread_id` FK `ON DELETE CASCADE`;快照表 payload-only + 存储侧 `updated_at`(不投影 status)。
  - **并发口径**:WAL / `synchronous=NORMAL` / `busy_timeout` 默认 5s / `foreign_keys=ON`;多语句写 `BEGIN IMMEDIATE`,单语句(含 CAS)靠 SQLite 原子性;不做 lease / 认领 / 重试,`SQLITE_BUSY` 原样抛;`:memory:` 仅供测试与单进程。
  - **迁移**:`PRAGMA user_version` 即版本,包内有序迁移数组,forward-only / additive-only,无迁移表;未知更高版本抛错。
  - **扩展面**:全做并冻结签名(workflow 三扩展 + durable 两扩展 + MemoryStore 条件对);CAS = 条件单语句 + `changes()`,比较串即 `save` 的序列化文本;core 类型零改动,扩展接口由包自导出——`listSnapshots` / `listSuspended` 各守其名,排序与游标口径单点在 storage.md 承载。

(来源:wayfinder ticket #15)
