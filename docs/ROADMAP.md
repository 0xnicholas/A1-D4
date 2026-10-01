# 实施路线图

极致轻量 TypeScript/Node agent 框架的粗粒度实施路线图:**只讲顺序、依赖与可验证产出,不含排期**。规范本体见 `docs/architecture/`(入口:`docs/architecture/README.md`),术语见 `CONTEXT.md`,决策依据见 `docs/adr/`。本图由 [决策:粗粒度实施路线图](https://github.com/0xnicholas/balsa-framework/issues/16) 产出。

## 切分原则

- **垂直切片(walking skeleton)**:每个里程碑都是一条可跑的细流,可独立验证、可提前叫停;不按子系统水平分层。
- **Instrumentation-first**:观测内核(span 模型 / tracer / NoOpSpan)与各边界自动埋点随各子系统落地时就建进去;exporter 与 OTLP 能力包后置,永不对已完成子系统开膛回补。
- **可验证产出两件套**:每个里程碑 = 可运行 example(`examples/`)+ 覆盖该范围的测试套件。
- **守轻量从第一天**:CI 字节预算在 M1 上线(零依赖 + preset 分层 + CI 字节预算三件套,见 [调研:轻量化基准与 MCP 现状](https://github.com/0xnicholas/balsa-framework/issues/6))。
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
- **SQLite 参考 adapter**:实现全部四个存储 port;驱动已冻 = `node:sqlite`(免 flag 基线 ≥22.13,见下「设计冻结」;port 策略见 [决策:存储适配策略](https://github.com/0xnicholas/balsa-framework/issues/15))(依赖 M2–M4 的 ports)
- **AI SDK 互操作包**:chunk 协议 ↔ AI SDK 流格式等外部格式转换(依赖 M1)
- **croner 封装包**:cron 表达式 → `next` 注入片段的便利件(表达式仍归宿主侧定义,不入记录;依赖 M4 schedules 的 `NextFn`;M4 地图移交件)
- **bunfold 桥接包(按需可裁)**:外部记忆系统桥接参考实现,价值在验证 memory seam 设计(依赖 M2)——**M5 裁定:裁**(不产桥接包;重开条件见延后清单「外部记忆引擎桥接」)

**验证**:OTLP → 本地 collector example;MCP server/client 对打 example;SQLite 跨进程挂起恢复 example。
**依赖**:各包分别挂 M1–M4 对应接缝,包间可并行。

**设计冻结(M5 收尾,2026-09-30)**:[wayfinder 地图:M5 生态能力包](https://github.com/0xnicholas/balsa-framework/issues/65) 收线——七件全部落成决策(六包 + bunfold 裁单),各件定义表面冻结在 `docs/architecture/` 的增补节,实施按 spec 直落、不再需要裁决。**实施已收口(2026-10-01,见下「实施完成」)**;发布动作(0.5,owner 手工)口径不变(见下「发布节奏与 v1.0 门槛」与 [#45](https://github.com/0xnicholas/balsa-framework/issues/45))。

| 件 | 冻结规范(节) | 决策 | 事实底座 |
| --- | --- | --- | --- |
| OTLP exporter `@balsa/otlp` | `docs/architecture/observability.md`「OTLP 能力包(M5 设计冻结)」 | [#73](https://github.com/0xnicholas/balsa-framework/issues/73) | `docs/research/otlp-js-packages.md` |
| MCP server `@balsa/mcp-server` | `docs/architecture/tools.md`「MCP server 能力包」 | [#74](https://github.com/0xnicholas/balsa-framework/issues/74) | `docs/research/mcp-v2-sdk-surface.md` |
| MCP client `@balsa/mcp-client` | `docs/architecture/tools.md`「MCP client 能力包」 | [#75](https://github.com/0xnicholas/balsa-framework/issues/75) | 同上 |
| SQLite adapter `@balsa/sqlite` | `docs/architecture/storage.md`「SQLite 参考 adapter(M5 设计冻结)」 | [#76](https://github.com/0xnicholas/balsa-framework/issues/76) | `docs/research/sqlite-driver-landscape.md` |
| AI SDK 互操作 `@balsa/ai-sdk` | `docs/architecture/model.md`「AI SDK 互操作能力包(M5 设计冻结)」 | [#77](https://github.com/0xnicholas/balsa-framework/issues/77) | `docs/research/ai-sdk-ui-stream-protocol.md` |
| croner 封装 `@balsa/croner` | `docs/architecture/harness.md`「croner 封装能力包」 | [#78](https://github.com/0xnicholas/balsa-framework/issues/78) | `docs/research/croner.md` |
| bunfold 桥(**已裁**,不建包) | `docs/architecture/memory.md`「外部记忆引擎(M5 裁定:不产桥接包)」 | [#79](https://github.com/0xnicholas/balsa-framework/issues/79) | `docs/research/bunfold.md` |
| 横切基建政策(目录 / 依赖红线 / 发布口径) | `docs/architecture/README.md` 能力包口径 + ADR-0002 / ADR-0015 的 M5 修订记 | [#72](https://github.com/0xnicholas/balsa-framework/issues/72) | — |

**实施完成(M5 收尾,2026-10-01)**:六包全部落码并核验(实施票 [#87](https://github.com/0xnicholas/balsa-framework/issues/87)–[#92](https://github.com/0xnicholas/balsa-framework/issues/92) 全关,bunfold 沿裁单不产包)——`@balsa/mcp-server` / `@balsa/mcp-client` / `@balsa/sqlite` / `@balsa/ai-sdk` / `@balsa/otlp` / `@balsa/croner`,各含单测 + 双预算基线(ai-sdk 空集基线;sqlite 零运行时依赖,沿脚本语义免 deps 基线,同 core)+ 最小英文 README;五 example 全跑通(`examples/mcp-tools` 双 transport / `sqlite-resume` 跨进程 / `ai-chat-route` / `otlp-collector` / `cron-schedule`,负例 exit 1);导出面核对:core 的 export-map / entry-points 测试在位(按设计只覆盖 core 导出表),产物面由 `check:dist` 逐包验真(七包 **16 子路径**全过);`check:runtime-deps` 白名单闸门全绿;`deps-budget` 六包逐包核对(五份基线 + sqlite 免基线)**全部在数、零黄灯**;字节预算 **16/16 零超支**;`pnpm verify` 全绿(**856 例 67 文件**)。发布交接口径见下「发布节奏与 v1.0 门槛」M5 收尾修订。依据 [实施:M5 收尾——verify 全绿核对 + 导出/预算总表 + ROADMAP/README 修订 + 发布交接口径](https://github.com/0xnicholas/balsa-framework/issues/93) 决议评论。

## 发布节奏与 v1.0 门槛

- **M1 末发 0.1**:walking skeleton 尽早公开,最早验证子路径导出与字节预算的打包链路;**以定名为门**——首次发布前必须完成 [决策:项目命名与品牌](https://github.com/0xnicholas/balsa-framework/issues/20)。
- 之后每个里程碑一个 0.x;0.x 阶段允许跨里程碑破型。
- **M5 完成 = v1.0**;存储 port 的 additive-only 演化纪律自 1.0 起生效(ADR-0010)。
- **修订(M2 收尾,2026-09-29)**:M1 末未执行发布(定名门已过,版本仍 0.0.0);首个公开版本拍板为 **0.1.0**——含 M1+M2 全部内容、不跳号;changelog = GitHub Release notes(tag + Release,仓库不新增 `CHANGELOG.md`);凭证 = owner 手动发布(前置:创建 npm org `@balsa`,registry 查实仍 FREE);此后 M3→0.2、M4→0.3、M5→1.0。依据 [实施:M2 收尾——字节预算、导出核对、verify 全绿](https://github.com/0xnicholas/balsa-framework/issues/44) 决议评论。
- **修订(M3 收尾,2026-09-29)**:M3 编排交付并核验——`./workflows` 13,958 B(字节预算 7/7 内)、导出三面一致(export-map / entry-points 测试 + `check:dist` 7 子路径)、`pnpm verify` 全绿(569 例 38 文件)、`examples/workflow-approval` 以本地 OpenAI-compatible mock 端到端跑通;0.2 = M1+M2+M3 全部内容,流程沿 0.1 结论(tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 与 0.2 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含 0.1.0 / 0.2 的先后)归 owner 手工前置。依据 [实施:examples/workflow-approval + M3 收尾](https://github.com/0xnicholas/balsa-framework/issues/53) 决议评论。
- **修订(M3 收线,2026-09-30)**:[#54](https://github.com/0xnicholas/balsa-framework/issues/54)(块内 suspend——迭代现场快照 + 块内 resume)后 M3 全表面终态:`./workflows` 16,817 B(预算 7/7,基线随 #54 更新,+2,859 B)、`pnpm verify` 全绿(579 例 38 文件)、`examples/workflow-approval` 本地 mock 复跑通过(挂起/回放/记录自断言);M3 wayfinder 地图 [#46](https://github.com/0xnicholas/balsa-framework/issues/46) 关账(七张实施票 #47–#54 全关)。发布结论沿上条不变。
- **修订(M4 收尾,2026-09-30)**:Harness 三件套(durable 审批闸 / signals / schedules)交付并核验——三个新子路径 `./signals` 5,509 B、`./durable-agent` 4,573 B、`./schedules` 3,037 B(字节预算 10/10,全部零超支;组合根 `.` 50,708 B,gzip 15,749 B)、导出三面一致(export-map / entry-points 测试 + `check:dist` 10 子路径)、`pnpm verify` 全绿(**659 例 42 文件**;零运行时依赖 58 模块 0 处外部导入)、两个新 example 以本地 OpenAI-compatible mock 端到端跑通——`examples/durable-approval`(挂起 → 快照 → 批准/拒绝两路 resume,拒绝不终止 run)与 `examples/signals-desk`(空闲唤醒 / 活跃注入 / 排队保序 / 类型化 sendSignal / subscribeToThread / schedules tick),负例均 exit 1。0.3 = M1–M4 全部内容,流程沿 0.1 结论(tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 / 0.2 / 0.3 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含先后)归 owner 手工前置。依据 [实施:examples + M4 收尾——双 example + 字节预算三层 + 导出核对 + verify 全绿 + ROADMAP 修订](https://github.com/0xnicholas/balsa-framework/issues/61) 决议评论。
- **修订(M5 版本口径,2026-09-30)**:原「**M5 完成 = v1.0**」更正为「**M5 完成 = 0.5**」——生态能力包以 0.5 交付(序列 0.1.0 → 0.2 → 0.3 → 0.5,0.4 跳空);**1.0 不再绑定 M5**,门槛先搁置(不排期);存储 port additive-only 与各公开面 major 约束不变,仍自 **1.0 起生效**(ADR-0009 / ADR-0010)。依据 [决策:M5 版本口径——M5 收尾发 0.5,1.0 不再绑定 M5](https://github.com/0xnicholas/balsa-framework/issues/64)。
- **修订(M5 收尾,2026-10-01)**:生态能力包六包交付并核验——交付清单、逐包预算数字与负例记录见上「M5 生态能力包」实施完成段(`pnpm verify` 全绿 **856 例 67 文件**;字节预算 16/16 零超支;导出面 `check:dist` 16 子路径全过;`deps-budget` 六包核对零黄灯;五 example 全跑通含负例 exit 1)。**0.5 = M1–M5 全部内容**;发布交接:owner 前置 = 创建 npm org `@balsa` + registry 复核(仍 FREE)→ bump 全 `@balsa/*` = **0.5.0** → 单 tag `v0.5.0` → `pnpm -r publish`(口径沿 [#45](https://github.com/0xnicholas/balsa-framework/issues/45) / ADR-0002 M5;流程沿 0.1 结论:tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 / 0.2 / 0.3 / 0.5 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含先后)归 owner 手工前置。差距参照 `docs/research/mastra-gap-analysis.md` 的刷新触发「M5 收尾」**已满足**,刷新另立 effort(沿 [#63](https://github.com/0xnicholas/balsa-framework/issues/63) 口径,该文首注已记)。依据 [实施:M5 收尾——verify 全绿核对 + 导出/预算总表 + ROADMAP/README 修订 + 发布交接口径](https://github.com/0xnicholas/balsa-framework/issues/93) 决议评论。

## 延后清单(post-v1,需求信号触发)

以下能力经路线图裁决**延后或出域**,不进 v1 任一里程碑。**本清单是「重开条件」的单一真相源**(术语见 `CONTEXT.md`):重开条件必须外部可观察、可累计;满足即单独评估,**不自动进入路线图**。缺口与差异的完整对账见 `docs/research/mastra-gap-analysis.md`(对比视图,不复制条件)。M5 能力包(OTLP exporter / MCP server + client / SQLite adapter / AI SDK 互操作)已在路线图内,不属本清单。

> 修订(2026-09-30,对比 ticket [#63](https://github.com/0xnicholas/balsa-framework/issues/63)):清单升级为四列表,重开条件统一为可观察、可累计的判定信号。

### 延后档(触发式)

| 缺口 | 重开条件(可观察) | 承载缝 |
| --- | --- | --- |
| Supervisor 能力包(createSupervisor 类) | as-tool 组合的真实重复痛点 ≥3 次复述,或 ≥1 个真实项目因包装样板 / 传播遗漏 / 嵌套审批受阻 | 能力包优先;核心字段须重开 [决策:多 agent 协作语义](https://github.com/0xnicholas/balsa-framework/issues/19) 的演化门 |
| RAG / 语义召回 | ≥1 个真实用例要求跨会话语义检索(外部用户或自身产品场景) | memory 落库 hook + 能力包(复用模型契约的 embedding 模式) |
| 外部记忆引擎桥接(bunfold 类) | ≥1 个真实用例要求框架侧提供桥接包(而非宿主侧自组装),且接受外部常驻服务依赖(独立服务 + 其 LLM 抽取管线 + 数据落盘);或此类引擎出现可嵌入(库)形态(无需常驻服务) | 能力包;缝 = memory 落库 hook / recall 增强(实施期裁决) |
| Evals / scorers | ≥1 个用例要求在 CI 或线上做断言式评估 | Processor,或独立包消费 run 结果 |
| 字符串路由(models.dev 类) | ≥1 个真实用例要求按名切模型 / provider 目录(而非照搬 mastra 形态) | 能力包(不引入 core magic string) |
| OTel bridge 能力包 | ≥1 个用户已有 OTel 采集管线、要求原生接入(与 M5 的 OTLP 导出分属两件事) | 能力包 |
| Background tasks | 「工具 ack + sendSignal 唤醒」文档范式的失效报告 ≥1:`untilIdle` 式自动续跑 / 并发限额 / 结果自动回灌任一成为硬需求 | 文档范式先行,能力包其次 |
| Goals / State signals | WM + Processor 组合被证明不够:≥1 个用例需要 judge 判定 + 预算语义 | 能力包;前置 = thread 状态域 |
| 跨实例 signals | ≥1 个部署要求 >1 进程共享同一 thread | 能力包(共享 PubSub + 租约) |
| resumable stream | ≥1 个断连重连 / 迟到订阅的真实诉求(用户报告,非推测) | 能力包(事件缓存) |
| 外部 runner 适配 | ≥1 个用户在 Inngest / Temporal 类平台上要求跑 workflow | 能力包(引擎接缝已留) |
| 每步检查点 + 崩溃重放 | ≥1 个用户明确接受重发 LLM 与幂等成本、并要求自动恢复 | 能力包 / 部署方(ADR-0011 已裁) |
| time-travel / restart | ≥1 个调试或审计场景要求从任意步重跑 | load→重进原语上的薄变种,无 port 变更 |

### 出域档(定位改变才重开)

| 缺口 | 重开条件(可观察) | 承载缝 |
| --- | --- | --- |
| Studio / editor / stored agents | 定位裁决改变 = 做托管产品或协作面(ADR 级) | — |
| channels / voice / workspaces & sandboxes | 同上,或社区出现可用实现 | 生态 |
| 托管平台 | 商业决策(非技术触发) | — |
| OM 类后台压缩 | ≥1 个用例要求跨会话长期记忆、且接受后台 LLM 成本 | bunfold 类外部记忆桥 |
| notification inbox | ≥1 个用例要求持久化收件箱 / 优先级投递 | 应用层或能力包 |
| signal providers(webhook / poll 入口) | ≥1 个用例要求 webhook 接入且示例模式不可复用 | 示例模式 |
| AgentController / session | ≥1 个用例要做交互式编码 agent 产品 | 应用层自组装 |

### 现实差距(非功能)

| 差距 | 条件 / 状态 | 承载缝 |
| --- | --- | --- |
| 发布 0.1.0 | 已在 [#45](https://github.com/0xnicholas/balsa-framework/issues/45)(owner 手工),非技术触发 | — |
| 公开上手面(文档站、对外 quick start) | 0.1.0 发布后 | README 已有 quick start |
| 适配器生态 | ≥1 个真实第二后端诉求 | 社区 + 作者指南(`docs/architecture/storage.md`) |
| 公开可检验性(轻量主张的外部证据) | 发布 0.1.0 时专项裁决:字节数字是否对外(ADR-0001 立场:不作对外定义) | 待裁决 |

## 本图不覆盖

- **排期**:刻意不含时间与人力安排。
- **实现期选型**:构建/测试工具链、SQLite 驱动等留给各里程碑实施期。
- **出域项**:Workspaces/Sandboxes、Channels、Voice、Studio、托管平台、OM 类后台压缩管线、notification inbox、signal providers、AgentController(依据见地图的 Out of scope)。
