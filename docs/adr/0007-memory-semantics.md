# Memory 语义:薄语义层自研 + thread/resource 双标识,重机制走能力包

Memory 供给策略 = **语义层薄自研**(存储 port 6 必备 + 2 条件方法 + 内存默认实现),外部记忆系统经能力包桥接(bunfold 为头号候选,归路线图)。身份模型采纳 mastra 的 thread/resource 双标识;消息历史为唯一默认开启机制(`lastMessages=10` 窗口 + `recall()` 单一入口 + 落库前过 Processor);工作记忆保留为可选、仅 resource 作用域、schema-only(Standard Schema + merge 语义)、tool-call 更新;语义召回延后留 seam;OM 类后台压缩出本地图范围。依据:候选开源记忆系统(mem0/Zep/Letta/bunfold)均为 server 形态或 hosted API,直接绑定违背无运行时负担,而语义层薄到没有更轻的可采用对象(mastra 的 3,936 行 Memory 类、LangGraph.js 的 checkpointer 全部自研此层);mastra 1.0 将 WM 默认提为 resource scope 是跨会话记忆的需求证据,其 OM resource scope 废弃则是"跨线程合并压缩"的反面证据。

## Considered Options

- **整体采用 / 深度绑定开源记忆系统(bunfold 等)为核心 memory**:被否——server 形态(MemoryCore 27 个直接依赖、约 16 万行 TS)或 hosted API 与无运行时负担正面冲突;桥接能力包保留,归路线图。
- **核心只做 port、不定义 memory 语义**:被否——砸掉"从原型到生产"的一体化叙事;Agent 规范已钉 memory 为一等可选字段。
- **WM 双 scope 照抄 mastra**:被否——thread 级暂存有消息历史兜底,双 scope 是双倍语义表面;调研原话"不要两个都做"。
- **WM 保留 markdown template 形态**:被否——全量替换每次全量 token 且易写坏;schema-only 复用既有 Standard Schema 契约,merge 语义对 tool-call 最友好。
- **OM 类机制内建(含同步 summarize-and-truncate 进 v1)**:被否——token 计数 / 总结 prompt / summary 消息类型是新概念面,且 bunfold 已在生态位覆盖此类需求;summarize 有 Processor 现成承载缝。

## Consequences

- 「决策:存储适配策略」(#15)获得 `MemoryStore` port 需求(6 必备 + 2 条件,能力标志降级),与 `WorkflowSnapshotStore` 统一 adapter 家族。
- 语义召回能力包与 bunfold 桥接能力包入地图雾区,归「决策:粗粒度实施路线图」(#16)判断。
- 无后台写 → memory 无 `settled()` 式生命周期;消息不可变 → 脱敏/过滤必须在 `processOutputStep`(落库前)完成。
- bunfold 的价值定位:参考实现(蒸馏 pipeline、游标落盘后再删原文的崩溃安全顺序、召回预算封顶等工程决策可定点借鉴)+ 头号桥接目标;其 vendor 分支的「PATCHES.md 台账 + 不变量 CI」纪律可作本框架日后 vendor 第三方代码的参考做法。

(来源:wayfinder ticket #12)
