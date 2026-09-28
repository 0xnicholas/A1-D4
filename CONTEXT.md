# A1-D4

一个轻量的 TypeScript/Node agent 框架：设计目标对齐 mastra(从原型到生产的一体化体验),差异化轴是"轻量"。本文件是项目术语表——只放定义,不放实现细节与架构决策(后者在 `docs/adr/`)。

## Language

**轻量 (Lightweight)**:
本项目的差异化轴,两层含义:**按需组合**——用户只为用到的能力付出,不用的子系统既不占依赖树也不占概念空间;**无运行时负担**——不强制任何基础设施(DB、队列、长驻进程),随处可跑,嵌入宿主应用而不接管它。心智表面小是贯穿的设计品味,但不是轴。
_Avoid_: 把"轻量"等同于依赖数/字节数等硬性数字指标(数字仅作内部 CI 回归参考,不是定义)

**核心包 (Core package)**:
框架的单数核心 npm 包,以子路径导出各子系统入口;自身保持极小,是"按需组合"的载体。
_Avoid_: 内核、平台包

**能力包 (Capability package)**:
因携带外部依赖而与核心包隔离的独立 npm 包(如 MCP、OTel exporter、存储 adapter、AI SDK 互操作),用户按需安装。
_Avoid_: plugin、integration

**组合根 (Composition root)**:
可选的薄组装点,负责把 storage/logger/tracer 等横切依赖注入给挂上来的子系统;子系统不挂它也能独立完整使用。
_Avoid_: 中央实例、registry(易与模型注册表混淆)

**模型契约 (Model contract)**:
核心与"一个模型"对话的结构类型契约,vendor 自 AI SDK provider spec 当前一代的最小子集;用户直接传入 AI SDK 生态 provider 包的模型实例,核心保持零依赖。
_Avoid_: 自有 provider SPI、provider 注册表、magic string

**Chunk 协议 (Chunk protocol)**:
核心自有的流式输出事件词汇(text-delta / tool-call / finish / usage 等最小集合),stream 输出、processors、workflow 快照、observability 共用;与外部格式(AI SDK UI stream 等)的转换只发生在互操作能力包。
_Avoid_: 透出/复用 AI SDK 流格式

**Agent**:
框架的核心执行单元:把 name、instructions、model、tools 包装成可 generate()/stream() 的对象;定义表面刻意最小,横切能力一律走 Processor。
_Avoid_: 模型本身(Agent 是模型+指令+工具的执行包装,不是 LLM 的同义词)、平台对象、上帝类

**动态参数 (Dynamic argument)**:
配置字段的形状约定:一切字段接受 `T | ((ctx: RequestContext) => T | Promise<T>)`,每次执行按请求上下文解析。
_Avoid_: 仅个别字段支持动态(全字段统一,无一例外)

**RequestContext**:
每次执行传给动态参数解析的上下文对象:框架写入 `signal`(AbortSignal)与 `runId`,其余为用户 per-call 传入的开放属性袋;纯对象。
_Avoid_: mastra 式 Map 类、泛型上下文参数

**Run**:
一次执行的完整生命周期。agent 域:一次 generate()/stream() 调用,从输入到 finishReason,包含零到多个 step;workflow 域:一次 workflow 执行,从 start/resume 到终态(success | failed | suspended)。
_Avoid_: session、conversation(那是 Memory 域的词)

**Step**:
两层含义,靠语境限定。agent 域:run 内的一轮"模型调用 + 工具执行"(mastra 的第三层 model step 不收);workflow 域:图中的一个节点(id + input/output schema + execute)。
_Avoid_: iteration、loop iteration(规范统一用 step)

**输出对象 (Output object)**:
stream() 的返回对象:既可 for-await 消费 chunk 协议流,又可 await 其终值(text / usage / steps / finishReason 等);generate() 复用同一代码路径。
_Avoid_: generate/stream 分离的双实现

**Processor**:
Agent 的唯一横切扩展点:挂在 run/step 边界钩子(processInput / processOutputStep / processError)上的有序处理器;guardrails、evals、脱敏、限流等横切能力的唯一合法承载点。
_Avoid_: 中间件、plugin、以字段形式焊进 Agent 类

**Workflow**:
框架的编排子系统:用可变 builder 把 step 组成条目图,commit 冻结后 createRun 执行;语义内核 = 扁平条目列表 + for 循环 walker,suspend/resume 靠 step 边界快照。
_Avoid_: DAG 执行器(本框架 workflow 不是 DAG)、状态机 DSL

**快照 (Snapshot)**:
workflow run 在 step 边界的 JSON 化状态(stepResults + 位置);suspend/resume 与 Harness 持久执行的共用机制,经 storage port 读写,默认内存实现。
_Avoid_: 事件溯源、完整历史(只保留每 run 最新一份)
