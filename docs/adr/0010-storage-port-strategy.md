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

(来源:wayfinder ticket #15)
