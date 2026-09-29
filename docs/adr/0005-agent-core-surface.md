# Agent 定义表面:最小字段 + Processor 唯一横切扩展点

Agent 定义表面收敛为五字段(`name / instructions / model / tools? / description?`),一切配置可动态解析。横切能力(guardrails、evals、脱敏、限流、记忆增强)统一走 **Processor**(v1 三钩:processInput / processOutputStep / processError),不得以字段形式焊进 Agent 类;审批-挂起移交 Harness,多 agent 委派协议不进核心(as-tool 手动组合兜底)。依据是**可逆性不对称**:后加可选字段是 minor,删字段是 major——mastra 的 ~25 字段、10,470 行 Agent 类与 `.network()` 废弃待移除,正是字段单向积累的代价实例;mastra 自己的最小核心(id/instructions/model/tools)与仓库守则("加功能前先做成 processor")证明模块本可外挂。

## Considered Options

- **mastra 式宽字段表面**(~25 字段进 AgentConfig):被否——与按需组合轴直接冲突,字段是不可逆 API 承诺;砍的是字段位置不是能力,每项能力均有承载缝(Processor / 能力包 / 子系统协作)。
- **无扩展点,只文档化 wrap 模式**:被否——"从原型到生产"的体验叙事要求 guardrails / evals 有一等承载点,纯手工接线会把头号生产用例推出门外。
- **chunk 级流式 Processor 进 v1**:被否——实现与心智重量大,v1 三钩足够承载已知场景;保留向后扩展位。
- **内建 supervisor 委派协议**:被否(暂缓)——delegation 钩子、memory 隔离、result references 是实重;as-tool 组合已零障碍,协议取舍归「决策:多 agent 协作语义」。

## Consequences

- 能力默认长在 Processor、能力包或协作子系统上(Harness 持有 agent,而非 agent 持有 Harness);Agent 类停止生长。
- 未来新增字段须先回答"为什么 Processor / 能力包承载不了",这是审查 PR 的固定一问。
- 审批/挂起不在核心,`finishReason` 无 `'suspended'`;引入与否由 Harness 决议统一处理,届时若进核心按 minor 扩展。
- **修订(M1-12 #33)**:`AgentConfig` 增可选 `processors?: readonly Processor[]`——唯一横切扩展点自身的挂载位(v1 三钩 `processInput` / `processOutputStep` / `processError`,声明顺序串行、前一个的返回是后一个的输入);与 `tracer` 同为不进定义表面的接线注入缝。改写语义:`processInput` 的返回 = 模型实际 prompt;`processOutputStep` 的返回 = run 权威 step 记录(终值与下一轮 prompt 皆读它,chunk 流仍是模型原始产出);`processError` 的替换即该边界终错。不做 abort/retry。
- **修订(M1-09 #30)**:`AgentConfig` 增可选 `tracer?: Tracer` 注入缝——观测子系统实例的分发位(组合根或独立 `new` 显式传入),不是第六个定义字段,也无 Processor 替代(Processor 是 run 内行为扩展, tracer 是子系统装配);缺席时 run 不创建任何 span 对象。

(来源:wayfinder ticket #10)
