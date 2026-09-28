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

**工具 (Tool)**:
框架的工具抽象:`description` + 可选 `inputSchema` / `outputSchema`(Standard Schema 双接口)+ `execute(input, ctx)` 的普通对象,经 `createTool` 工厂或手写字面量创建;自身无 id/name 字段,名字的唯一真相源是容器 Record 键。字段不逐个动态化——动态性由 Agent 的 tools 容器(DynamicArgument)整组承载。
_Avoid_: 把工具做成 class / 注册表;工具携带框架引用(agent / memory 经 requestContext 用户袋或闭包获取,不作参数注入)

**Workflow**:
框架的编排子系统:用可变 builder 把 step 组成条目图,commit 冻结后 createRun 执行;语义内核 = 扁平条目列表 + for 循环 walker,suspend/resume 靠 step 边界快照。
_Avoid_: DAG 执行器(本框架 workflow 不是 DAG)、状态机 DSL

**快照 (Snapshot)**:
workflow run 在 step 边界的 JSON 化状态(stepResults + 位置);suspend/resume 与 Harness 持久执行的共用机制,经 storage port 读写,默认内存实现。
_Avoid_: 事件溯源、完整历史(只保留每 run 最新一份)

**Memory**:
框架的记忆子系统:thread/resource 身份 + 消息历史 + 可选工作记忆;存储走 port、默认内存实现;语义召回与 OM 类重机制不进核心,外部记忆系统(如 bunfold)经能力包桥接。
_Avoid_: 把 Memory 等同于存储 adapter(adapter 归存储决策)、内建后台压缩管线

**Thread**:
Memory 域的会话身份:一次持久会话,消息按 thread 隔离,每个 thread 归属一个 owner(resourceId);per-call 经 `memory: { thread, resource }` 传入,不存在时自动创建。
_Avoid_: session、conversation 作正式词(Run 是一次执行,Thread 是持久会话,两者正交)

**Resource**:
Memory 域的用户/实体稳定标识:跨 thread 共享的锚点,每条消息与每个 thread 都带 resourceId,是工作记忆的归属维度;memory 子系统不做访问控制,授权归应用层。
_Avoid_: user(不总是人类用户)、tenant(多租户隔离是应用层职责)

**消息历史 (Message history)**:
唯一默认开启的记忆机制:消息持久化 + 最近 N 条窗口(lastMessages)在模型调用前注入 + `recall()` 单一查询入口;消息格式即模型契约的 vendor prompt 类型加存储信封(id/threadId/resourceId/createdAt)。
_Avoid_: short-term memory、chat history 作术语

**工作记忆 (Working memory)**:
可选的跨会话小块结构化记忆(用户画像/偏好/当前目标),resource 作用域;作为 system message 注入,agent 经 tool-call 更新。
_Avoid_: long-term memory(向量召回、后台压缩类"长期记忆"机制不在核心,经能力包桥接)

**Span**:
观测域的单个操作记录:自有最小形状(id / 32-hex traceId / parentSpanId / name / type / 起止时间 / 一等公民 input/output / attributes / metadata / error / isEvent),非 OTel span——OTel 映射只发生在 OTLP 能力包。框架只写 5 个类型常量(agent-run / agent-step / tool-call / workflow-run / workflow-step),type 字段开放给用户自定义。
_Avoid_: OTel span 作内核概念、metrics/logs 信号(v1 只定 tracing)

**Tracer**:
观测子系统的入口对象:`createTracer({ exporters, sampler?, spanProcessors? })` 产物,经组合根注入分发;负责 root 采样判定(不通过则 NoOpSpan 传播)与 span_started/updated/ended 三事件派发;缺席时全子系统零开销。
_Avoid_: OTel Tracer、全局单例

**观测导出器 (Observability exporter)**:
把 tracing 事件送出进程的接口:`{ export(event), flush?(), shutdown?() }`;核心自带 console 与 memory 两个,OTLP(GenAI semconv 映射)在能力包,厂商专用 exporter 不做(裸 OTLP + gen_ai.* 已覆盖各家后端)。
_Avoid_: plugin、integration(那是能力包的词)
