# 实施路线图

极致轻量 TypeScript/Node agent 框架的粗粒度实施路线图:**只讲顺序、依赖与可验证产出,不含排期**。规范本体见 `docs/architecture/`(入口:`docs/architecture/README.md`),术语见 `CONTEXT.md`,决策依据见 `docs/adr/`。本图由 [决策:粗粒度实施路线图](https://github.com/0xnicholas/balsa/issues/16) 产出。

## 切分原则

- **垂直切片(walking skeleton)**:每个里程碑都是一条可跑的细流,可独立验证、可提前叫停;不按子系统水平分层。
- **Instrumentation-first**:观测内核(span 模型 / tracer / NoOpSpan)与各边界自动埋点随各子系统落地时就建进去;exporter 与 OTLP 能力包后置,永不对已完成子系统开膛回补。
- **可验证产出两件套**:每个里程碑 = 可运行 example(`examples/`)+ 覆盖该范围的测试套件。
- **守轻量从第一天**:CI 字节预算在 M1 上线(零依赖 + preset 分层 + CI 字节预算三件套,见 [调研:轻量化基准与 MCP 现状](https://github.com/0xnicholas/balsa/issues/6))。
- **串行默认**:小团队单线推进;各里程碑「依赖」行标注可并行项,不排双轨。

## 里程碑

### M1 骨架闭环

核心包首次可跑:一个 agent 带工具完成 generate/stream 闭环。

- 模型契约(vendor 自 AI SDK provider spec 子集 + `specificationVersion` 硬断言)+ chunk 协议
- 工具:`createTool` 四字段普通对象、Record 容器、三线 error 回喂
- Agent 核心:五字段最小表面、动态参数 / RequestContext、输出对象双消费、内建 loop(maxSteps 默认 5、工具错误回喂)、Processor 三钩、structuredOutput strict
- 观测内核:span 模型(框架类型常量,开放 string)、tracer(started/updated/ended 三事件 + exporter 最小面)、console/memory 两个内置 exporter、NoOpSpan
- 可选组合根:薄组装点,子系统不挂也能独立完整使用

**验证**:`examples/minimal-agent` 可跑;测试套件;**CI 字节预算上线**。
**依赖**:—(首个里程碑)。

### M2 记忆

- MemoryStore port(6 必备 + 2 条件)+ 内存默认实现
- 消息历史(唯一默认机制:thread/resource 双标识、lastMessages=10 + recall)
- working memory(resource scope、schema-only、tool-call 更新)
- agent 的 memory 集成(per-call `memory: { thread, resource }`,不存在自动创建)

**验证**:多 thread 多轮会话 example + recall 演示。
**依赖**:M1。

### M3 编排

- workflow builder(then / parallel / branch / foreach / dowhile / dountil / sleep)+ commit + createRun(type-state)
- 语义内核:扁平条目列表 + for 循环 walker;Standard Schema 校验永远开
- suspend/resume:suspend 信号 + step 边界 JSON 快照;WorkflowSnapshotStore port(2 方法,JSON-only)+ 内存实现

**验证**:含 suspend/resume 的 workflow example。
**依赖**:M1(与 M2 可并行)。

### M4 持久执行与后台(Harness 三件套)

- `createDurableAgent`:工具调用边界审批闸;loop 快照走 AgentRunSnapshotStore port;finishReason 增 `'suspended'`;resume 携带审批结论恢复
- signals:内存 pubsub + loop step 边界注入缝;注入落消息历史;单进程语义
- schedules:ScheduleStore port + 记录 CRUD + tick 原语;cron 解析注入,触发执行交平台 cron

**验证**:审批闸 example(挂起 → 审批 → resume)+ signal 注入 example。
**依赖**:M1 + M2(signals 注入落消息历史)。

### M5 生态能力包

核心包之外的第一方能力包,各包独立、可并行推进:

- **OTLP exporter 包**:GenAI semconv 映射,HTTP only(依赖 M1 观测内核)
- **MCP server 包 / MCP client 包**:同一份 Tool 双向流通,桥接 schema 直通零适配(依赖 M1 工具)
- **SQLite 参考 adapter**:实现全部四个存储 port;驱动选型留实现期,默认 `node:sqlite`(Node ≥22 基线,见 [决策:存储适配策略](https://github.com/0xnicholas/balsa/issues/15))(依赖 M2–M4 的 ports)
- **AI SDK 互操作包**:chunk 协议 ↔ AI SDK 流格式等外部格式转换(依赖 M1)
- **bunfold 桥接包(按需可裁)**:外部记忆系统桥接参考实现,价值在验证 memory seam 设计(依赖 M2)

**验证**:OTLP → 本地 collector example;MCP server/client 对打 example;SQLite 跨进程挂起恢复 example。
**依赖**:各包分别挂 M1–M4 对应接缝,包间可并行。

## 发布节奏与 v1.0 门槛

- **M1 末发 0.1**:walking skeleton 尽早公开,最早验证子路径导出与字节预算的打包链路;**以定名为门**——首次发布前必须完成 [决策:项目命名与品牌](https://github.com/0xnicholas/balsa/issues/20)。
- 之后每个里程碑一个 0.x;0.x 阶段允许跨里程碑破型。
- **M5 完成 = v1.0**;存储 port 的 additive-only 演化纪律自 1.0 起生效(ADR-0010)。

## 延后清单(post-v1,需求信号触发)

以下能力经路线图裁决**延后**,不进 v1 任一里程碑;触发条件满足时再单独评估:

- **Supervisor 能力包**(createSupervisor 类):as-tool 组合的语法糖;触发 = as-tool 模式的真实重复痛点(见 [决策:多 agent 协作语义](https://github.com/0xnicholas/balsa/issues/19) 演化门)
- **RAG / Evals / 字符串路由(models.dev)能力包 / OTel bridge 能力包**:需求驱动
- **Background tasks**:v1 以「工具 ack + sendSignal 唤醒」组合承载(harness.md 文档范式)
- **Goals / State signals**:可被 working memory + Processor 组合覆盖
- **跨实例 signals / durable 增强能力包**(共享 PubSub + 租约、resumable stream、外部 runner 适配):多实例需求出现时再判断

## 本图不覆盖

- **排期**:刻意不含时间与人力安排。
- **实现期选型**:构建/测试工具链、SQLite 驱动等留给各里程碑实施期。
- **出域项**:Workspaces/Sandboxes、Channels、Voice、Studio、托管平台、OM 类后台压缩管线、notification inbox、signal providers、AgentController(依据见地图的 Out of scope)。
