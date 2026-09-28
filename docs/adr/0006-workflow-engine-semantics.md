# Workflow 引擎:mastra 形状 + 快照 port 化 suspend/resume,语义内核最小化

Workflows 子系统沿用 mastra 的 API 形状(createStep 配置对象 + 可变 builder + commit 冻结 + type-state),语义内核 = 扁平条目列表 + for 循环 walker;控制流算子收 then / parallel / branch / foreach / dowhile / dountil / sleep 七件;suspend/resume 以「suspend 信号 + step 边界 JSON 快照 + storage port(内存默认)」形态保留,time-travel / restart / CAS / 快照钩子等持久化重量全部裁出。依据:调研(#3)证明 mastra 的体量几乎全在持久化钩子、streaming、tracing 与多引擎适配而非语义;port 化后引擎本体零依赖、纯内存可跑,对得起轻量轴,同时保住人工介入这一 workflow 相对 agent loop 的核心差异化能力。

## Considered Options

- **全裁 suspend/resume(纯内存执行器)**:被否——人工审批门 / 长等待是 agentic workflow 的差异化场景,裁掉则 workflow 相对 agent loop 只剩编排糖;且 Harness(#18)的 durable agent「只存挂起快照」正等同一机制。
- **进程内 suspend + 内存快照(无 port)**:被否——挂起等待本质上比进程长寿,无持久化的 suspend 与真实部署形态错配,是会诱导误用的半吊子能力。
- **mastra 全量语义(含 time-travel / restartAll / evented 引擎 / 多 runner 适配)**:被否——与按需组合轴直接冲突;各变种长在同一快照机制上,引擎暴露 load→重进原语即可,后加各自独立。
- **map / state / bail 等语法糖进 v1**:被否——可逆性不对称:内联 step、getStepResult、branch 分别兜底,后加均为 minor。

## Consequences

- 「决策:存储适配策略」(#15)获得 `WorkflowSnapshotStore` port 需求(两个方法 + JSON-only),adapter 家族在其上扩展。
- 「决策:Harness 语义集」(#18)以本规范的快照格式与 load→重进原语为 durable 执行的底层机器。
- 引擎本体留在核心包、零依赖;持久化与 durable 能力全在包边界之外生长。
- 砍单表(`docs/architecture/workflows.md`)是审查 PR 的固定参照:新增表面须先回答"为什么现有缝承载不了"。

(来源:wayfinder ticket #11)
