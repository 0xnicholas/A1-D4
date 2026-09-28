# 存储适配策略

> 来源:wayfinder ticket #15(决策:存储适配策略)。本文件是存储层的架构规范。
> 决策记录见 `docs/adr/0010-storage-port-strategy.md`;术语见 `CONTEXT.md`。

## 定位

存储层是子系统持久化需求的 **port 集合 + adapter 家族**,本身不是子系统:核心只定义 port 类型与内存默认实现,真实后端经能力包接入。**无 mastra 式分域 composite**——`MastraCompositeStore` 的存在前提是强制中央实例(所有子系统共享一个 storage 入口,「不同域放不同后端」才需要框架内路由);本框架组合根可选(ADR-0002),子系统各自接收 store 实例,分后端是用户侧自由,不构成框架概念。**观测无 storage port**:tracing 走 exporter 流式模型(ADR-0009),span 不落库。

## Port 清单(v1 两个,形状冻结)

- **`MemoryStore`**(6 必备 + 2 条件):定义见 `docs/architecture/memory.md`。
- **`WorkflowSnapshotStore`**(2 方法 + JSON-only):定义见 `docs/architecture/workflows.md`。

两个 port 独立定义、独立演化;一个 adapter 包可实现其一或两者(**统一 adapter 家族**)。port 类型由核心定义,adapter 包对核心仅 types 级依赖(同构于模型契约的反向)。

## 扩展面:可选方法 + 能力标志

基础 port 一个字不动。扩展能力以**可选方法**出现:存在性即能力声明,核心调用前检测,缺席按既定语义降级或显式报错(同构于 `MemoryStore` 条件 2)。

| 可选扩展 | 所属 port | 语义 | 缺席行为 |
| --- | --- | --- | --- |
| `compareAndSave(runId, snapshot, expected): Promise<boolean>` | WorkflowSnapshotStore | 跨进程 resume 去重 CAS:`expected` = 上次 load 的快照或 `null`(期望不存在),期望不匹配则不写、返回 `false` | 退回单进程语义(进程内锁已有);跨进程安全归部署方 |
| `deleteSnapshot(runId): Promise<void>` | WorkflowSnapshotStore | 保留期清理——终态快照非永久数据 | 快照按实现自身保留策略存活 |
| `listSnapshots(q: { status?, limit?, before? }): Promise<WorkflowRunSnapshot[]>` | WorkflowSnapshotStore | 枚举:suspended 恢复列表、#18 的恢复扫描 | 无枚举能力 |

签名为参考形状(实现期可细化),语义边界钉死:CAS = 期望匹配才写;JSON-only 约束不变,不引入版本计数字段。

## 连接生命周期

adapter 自拥连接生命周期:可选暴露 `init?()` / `close?()`;**核心永不隐式调用、不 hook 进程退出**(无运行时负担)。应用或组合根负责打开与关闭;内存实现无生命周期。

## 第一方 adapter 清单

- **内存实现**:核心自带,两 port 各一;不接 storage 即纯内存(已钉于各子系统规范)。
- **SQLite 系参考 adapter**(能力包,恰好一个 durable 第一方):嵌入式文件库、零服务,覆盖最常见自托管形态,同时充当两个 port 的真实后端验证。驱动选型(`node:sqlite` 内置零依赖 vs libsql)归实现期按 Node 版本基线与 edge 约束判断;build 时机归路线图(#16)。
- **其余后端(Postgres / Redis / Upstash / Mongo 等)不做第一方**,留社区。

### Adapter 作者指南(要点)

1. 实现任一波特或两者;可选方法按需实现,存在性即声明,无需注册。
2. port 类型从核心包引入(types-only,无运行时依赖)。
3. semver 承诺(下节)同样适用于第三方 adapter 面向的 port 形状。

## semver 承诺

port 是框架唯一面向「生态作者」的契约,稳定性与核心同步:**1.0 起 stable;演化纪律 additive-only**——新能力只以可选方法 + 能力标志增加,必需方法签名永不改;breaking 只在 major。0.x 阶段 minor 可破,changelog 明示。

## 砍单与承载缝

| 砍单项 | 承载缝 |
| --- | --- |
| 分域 composite / 域路由 | 子系统各自收 store 实例,分后端是用户侧自由 |
| 观测存储域(span 落库) | exporter 流式模型(ADR-0009) |
| harness 存储域(lease / notifications / schedules / thread-state) | 不预建;#18 需要时按「可选方法 + 能力标志」同模式扩展 |
| PG / Redis 等第一方 adapter | 社区;作者指南见上 |
| CAS 进基础 port | 可选扩展;内存版不必假装支持 |
| 核心托管连接生命周期(进程 hook / settled 式) | adapter 自拥 `init?()`/`close?()`,应用或组合根调用 |

## 与其它子系统的关系

- **Workflows(#11,已定)**:钉 `WorkflowSnapshotStore` 需求;CAS 与快照管理扩展承载其「跨进程 resume 去重」「保留期清理」缝。
- **Memory(#12,已定)**:钉 `MemoryStore` 需求(6+2);其条件 2 即能力标志模式的首个实例。
- **Observability(#14,已定)**:无 storage port;span 经 exporter 出进程。
- **Harness(#18)**:durable 执行的存储输入 = 本规范的 port + 可选扩展;lease / PubSub / 调度等域不在此预建,归 #18 判断。
- **组合根(ADR-0002)**:可选薄注入点;持有 adapter 时可代管其 `init`/`close`,子系统独立 `new` 仍是一等用法。

## 依赖预算

核心(含存储 port 与内存实现)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。SQLite 系参考 adapter 归能力包,依赖隔离在包边界。
