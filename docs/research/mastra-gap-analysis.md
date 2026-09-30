# 调研:mastra 总对比——差异、差距与重开条件

> 对比 ticket:#63。日期:2026-09-30。
> 定位:把四份前序调研(mastra 的 Agent 与模型层、Memory、Workflows、Harness)与框架本体对账,给出**总账视图**;不做新裁决,不重抓上游(沿各调研的钉)。
> 事实基线:mastra 侧钉在 2026-09-27～28 快照(`@mastra/core@1.72.0-alpha.4`,main `cceb9ab`;`@mastra/memory@1.32.1`);本框架侧钉在 `docs/ROADMAP.md` M4 收尾行(2026-09-30:`pnpm verify` 全绿 659 例 42 文件、10 个子路径导出、零运行时依赖)。
> **「重开条件」的单一真相源 = `docs/ROADMAP.md`「延后清单」**;本文只给分档与对比视图,不复制条件。刷新触发(先到者):M5 收尾 / mastra 下一个 major / 公开 1.0 前。

## TL;DR

- mastra 是"从原型到生产"的平台化框架:1.x 已发布、`Agent` 类约 1 万行 / 约 25 个可选配置字段、core 30 个直接依赖、208 个 provider 条目(文档口径 210 providers / 7,618 models);本框架是单核心包、零运行时依赖、规格先行的轻量重实现。
- **已对齐 18 项**(双轨模型层、输出对象双消费、DynamicArgument、Processor 唯一横切口、扁平条目 walker、快照 suspend/resume、thread/resource、Harness = 分类名…):对齐的是**语义**,不是维护负担。
- **有意分叉 12 面**(模型路由、Agent 配置面、Processor 生命周期、Memory 机制集、Workflow 高级语义、Harness 范围、观测、存储、中央实例、多 agent 形态、产品面、演化姿态):每面有 ADR 依据。
- **缺口 28 项**分四档:M5 已排 5 / 延后 12(触发式)/ 出域 7(定位改变才重开)/ 现实差距 4(非功能)。
- **结论**:轻量轴成立且与 mastra **不收敛**——它的减法动因是打包体积与运行时性能,不是"按需组合 + 无运行时负担";新增能力仍以中央实例 + 存储域 + PubSub/长驻进程为前提。不重开任何现裁决。

## 口径

- **已对齐**:形状照 mastra(经调研证明其可行)但按本框架依赖预算重实现——对齐语义,不对齐维护负担。
- **有意分叉**:同能力、不同重量或语义;依据在各 ADR。
- **缺口**:mastra 有、本框架没有;按处置分档——M5 已排 / 延后(触发式)/ 出域 / 现实差距(非功能)。
- **重开条件**:延后/出域档缺口重新进入路线图的判定信号,必须外部可观察、可累计;单一真相源在 `docs/ROADMAP.md`(术语见 `CONTEXT.md`)。

## 0. 基线

|  | mastra(快照 2026-09-27～28) | Balsa(2026-09-30) |
| --- | --- | --- |
| 状态 | 1.x 已发布(1.0 于 2026-01-20;快照 `@mastra/core@1.72.0-alpha.4`) | M1–M4 交付并核验;version 0.0.0 / 无 tag / registry 无包(#45 待 owner 手工发布) |
| 形状 | `agent.ts` 约 10,470 行、`AgentConfig` 约 25 个可选字段、core 30 个直接依赖 | 单核心包 10 个子路径导出、零运行时依赖、字节预算 CI(内部参考,ADR-0001) |
| 生态 | 208 provider 条目(开发期每小时刷新)、4 代 AI SDK provider spec 并存、Studio/editor/channels/voice/scorers/RAG/Inngest/Temporal/deployers/client-js | 4 个存储 port + 内存默认实现、5 个 example、M5 能力包未交付 |
| 体量参照 | memory 内存参考实现 1,255 行 / 适配器约 30 个方法;`workflows/workflow.ts` 202,869 字符 | `./workflows` 16,817 B、组合根 50,708 B(gzip 15,749 B)(minify 后,内部预算数字) |

## 1. 已对齐(照 mastra 验证过的形状)

| 面 | 对齐的形状 | 依据 |
| --- | --- | --- |
| 模型层 | 双轨:自有 loop + 自有 chunk 协议;AI SDK 只作类型底座与 provider 实例来源,格式互操作独立成包 | 调研 #4 / ADR-0004 |
| 输出对象 | 同一对象双消费(`for await` 流 + `await` 终值);`generate()` = `stream()` + await,单代码路径 | 调研 #4 |
| 动态参数 | 全字段接受 `T \| ((ctx) => T \| Promise<T>)`,按请求上下文解析(本框架更严:无一例外) | 调研 #4 |
| Processor | 唯一横切扩展点;guardrails / evals / 脱敏 / 限流不进 Agent 字段 | 调研 #4 / ADR-0005 |
| Agent 表面 | 最小核心 name / instructions / model / tools(+ description);`maxSteps` 默认 5 | 调研 #4 |
| Workflow 形态 | 扁平条目列表 + for 循环 walker;builder 可变链式 + `commit()` 冻结,**不是 DAG** | 调研 #3 / ADR-0006 |
| IO 校验 | Standard Schema 双接口、固定边界校验(mastra 内契约 `StandardSchemaWithJSON`;本框架零适配器) | 调研 #3 / ADR-0003 |
| 挂起/恢复 | suspend 控制信号 + step 边界 JSON 快照 + storage port;`start` / `resume` 同一信封 | 调研 #3 / ADR-0006 |
| Memory 身份 | thread / resource 双标识:消息按 thread 隔离、按 resource 共享锚点 | 调研 #5 / ADR-0007 |
| 消息历史 | 唯一默认开启的机制:`lastMessages` 默认 10 + 单一 `recall()` 查询入口 | 调研 #5 |
| 工作记忆 | 小结构化记录,作为 system message 注入,agent 经 tool-call 更新;resource 作用域 | 调研 #5 |
| 多 agent | 委派 = 普通 loop 内的一次工具调用;`.network()` 已废弃,mastra 自己收敛到 loop 内 | 调研 #4 / ADR-0012 |
| Harness 形态 | 文档分类名而非统一模块(mastra 源码 `Harness` 已降级为 `AgentController` 的废弃别名) | 调研 #17 / ADR-0011 |
| 调度复用 | threaded 触发 = 向会话注入 signal,不新建运行时 | 调研 #17 |
| 终态词汇 | `finishReason: 'suspended'` 承载挂起 | 调研 #4 |
| 模型降级 | fallback 链是一等输入形状(本框架更保守,见 §3) | 调研 #4 / ADR-0004 |
| 结构化输出 | run option `structuredOutput: { schema }`,终值校验后落 `object`(本框架只 strict) | 调研 #4 |
| MCP | 同一份 Tool 双向流通(server / client 两个能力包,M5) | tools.md / M5 |

## 2. 有意分叉(同能力,不同重量/语义)

| 面 | mastra(快照) | 本框架(依据) |
| --- | --- | --- |
| 模型路由 | `'provider/model'` magic string + 208-provider 注册表(开发期每小时刷新)+ GatewayManager 链 + 认证解析 + **4 代 spec 适配器** | 实例直传(任意 AI SDK provider 实例结构满足契约)、单一 spec 版本硬断言、升代升 major;无注册表/网关/magic string(ADR-0004) |
| Agent 配置面 | 约 25 个可选字段(memory / agents / scorers / durable / pubsub / backgroundTasks / signals / goal / notifications / editor / voice / channels / workspace…),含字段级 Editor 所有权 | 5 个定义字段 + memory 一等可选 + tracer/processors 两个接线缝;重能力挂包边界(ADR-0005) |
| Processor 生命周期 | 三层(run > loop iteration > model step)、约 9 个钩子(含 processLLMRequest / processToolResult / processAPIError)、`abort({ retry })` + 重试上限 | 三钩单层(processInput / processOutputStep / processError),无重试 / abort 语义 |
| Memory 机制集 | semantic recall(1.0 起默认关闭)+ OM 观察记忆(推荐但 opt-in,14 个存储方法)+ thread cloning + 约 30 方法适配器 + composite store + 默认 libSQL 落盘 | 8 方法 port、无向量、无后台压缩、无 cloning、无 composite;OM 归外部记忆系统桥(ADR-0007 / 0010) |
| Workflow 高级语义 | time-travel / restart / restartAllActiveRuns、state 黑板、bail、map / sleepUntil、嵌套 workflow、evented 引擎、Inngest / Temporal 引擎、shouldPersistSnapshot / prune、resume CAS | 只暴露 load→重进原语;持久化 = port;durable 重启归 Harness;resume 去重 = 进程内锁 + adapter 可选 CAS(ADR-0006 / 0010) |
| Harness 范围 | 7 项能力(durable / background tasks / goals / schedules / signals / signal providers / AgentController),6 项 Beta;PubSub + 租约 + 轮询 worker | 三件套(durable 审批闸 / signals / schedules tick);单进程语义显式;跨实例归能力包;平台 cron 是一等形态(ADR-0011) |
| 观测 | OTel 生态向 + 存储域 + scorers | 自有最小 span 模型(7 个类型常量)、started / updated / ended 三事件、exporter 流式、span 不落库;OTLP 映射在能力包(ADR-0009) |
| 存储 | 域划分 + `MastraCompositeStore` 分域路由 + 多第一方 adapter(libsql / pg / mongo / upstash / d1 / convex) | 4 个 port + 恰好一个 SQLite 参考 adapter,其余社区;无 composite(强制中央实例不存在)(ADR-0010) |
| 组合根 | `new Mastra({...})` 中央实例,storage / pubsub / gateways 由它持有 | `createApp` 可选薄组装点;子系统独立 `new` 是一等用法(ADR-0002) |
| 多 agent 形态 | `agents:` 字段 + delegation 钩子(onDelegationStart / Complete、messageFilter、结果引用、memory 隔离、versions 传播) | as-tool 组合:零协议、上下文零透传;钩子退化为用户态平凡代码;`createSupervisor` 类进演化门(ADR-0012) |
| 产品面 | Studio / editor / stored agents、channels、voice、workspace / browser、scorers / evals、RAG、server(hono)/ client-js、deployers、托管云 | 出域或能力包;框架嵌入宿主应用而不接管(地图 Out of scope) |
| 演化姿态 | API 快速漂移(6/7 Beta、Harness→AgentController 改名、4 代 spec 并存)、大版本迁移双轨再拆 | spec-first 冻结、port additive-only、字节预算 CI 黄灯(ADR-0001 / 0015) |

## 3. 形状内语义差异(从 mastra 迁移会踩的点)

- **Agent / 模型层**:instructions 仅 string(无 string[] / SystemMessage / providerOptions);同一步多个工具调用**串行**执行;`structuredOutput` 只 strict(无 errorStrategy / jsonPromptInjection);chunk 协议只有四种(`text-delta` / `tool-call` / `tool-result` / `finish`,无推理增量、参数增量);fallback 只在该次尝试**尚未产出任何 chunk** 时切换(流中途失败不切换);`maxSteps` 耗尽时 `finishReason: 'tool-calls'`(框架自身的截断信号)。
- **Workflow**:`dowhile` 条件在**迭代前**求值、可 0 次迭代(mastra 的 dowhile / dountil 都是迭代后求值、至少一次);`retries` = 额外尝试数、固定间隔 1000ms、等待可被 AbortSignal 打断(mastra 可配、缺省 0 延迟、不可打断);`sleep` 的动态时长 fn 收 `RequestContext` 而非上一步输出;无 `waiting` 状态、abort 即 failed;resume **按记录回放**重建 tip(不重执行、不重估条件),`resumeData` 只给被点名的那一次执行,兄弟臂 / 后续迭代拿 `undefined`;快照是固定五字段 + 可选 `traceId` / `iterationSite`(无 `suspendedPaths` / `serializedStepGraph` 路径模型);拿掉 state 黑板 / `bail` / `map` / `sleepUntil` / 嵌套 workflow / `createStep(agent|tool)`;`suspend()` 在四类块体内都成立,但条件里调用报错。
- **Memory**:工作记忆只有 schema 形态(merge 语义,无 markdown 模板的 replace 语义);无单条消息 update / delete(`deleteThread` 级联兜底);无 thread cloning;不做访问控制(授权归应用层)。
- **Harness**:审批声明在 durable 包装层,工具保持四字段;`approved: false` = 以「用户拒绝」工具结果回喂模型、run 继续;signals 固定三句语义(无 `ifActive` / `ifIdle` 行为矩阵),排队队列进程内;调度无触发记录(span 覆盖追责);`tick` 本身无 span。
- **观测**:快照里只持久化 `traceId`(mastra 存整个 tracingContext);resume = 同一 traceId 下的**新 run span**(一次人机交互 = 同 trace 多 span)。

## 4. 缺口分档

### 4.1 M5 已排(路线图内,不属 watchlist)

- OTLP exporter(GenAI semconv 映射,HTTP only)
- MCP server 包 / MCP client 包(同一份 Tool 双向流通)
- SQLite 系参考 adapter(实现四个存储 port)
- AI SDK 互操作包(chunk 协议 ↔ AI SDK UI stream、`chatRoute` 等价物)
- bunfold 桥接包(按需可裁)

### 4.2 延后档(触发式)

重开条件见 `docs/ROADMAP.md`「延后清单」(单一真相源);下表只给 mastra 侧事实与承载缝。

| 缺口 | mastra 侧的事实 | 承载缝 |
| --- | --- | --- |
| supervisor 语法糖 | `agents:` 字段 + delegation 钩子 + memory 隔离 + 结果引用 | 能力包优先;核心字段须重开 ADR-0012 演化门 |
| RAG / 语义召回 | semantic recall(默认关)+ 17+ 向量库适配器 + embedder 依赖 | memory 落库 hook + 能力包 |
| Evals / scorers | scorers 挂在 Agent 配置上 + 独立评估包 | Processor,或独立包消费 run 结果 |
| 字符串路由(models.dev 类) | `'provider/model'` + 208-provider 注册表 + 网关链 | 能力包 |
| OTel bridge 能力包 | 观测偏 OTel 生态 | 能力包(与 M5 的 OTLP exporter 分属两件事) |
| background tasks | manager + 执行租约 + 心跳 + `untilIdle` + SSE 管理流 | 文档范式(工具 ack + sendSignal)→ 能力包 |
| goals / state signals | judge 判定 + 预算 + thread state 持久化 | 能力包;前置 = thread 状态域 |
| 跨实例 signals | Redis Streams PubSub + LeaseProvider | 能力包 |
| resumable stream | 事件缓存(默认内存 / 生产 Redis)+ `observe(runId)` | 能力包 |
| 外部 runner 适配 | Inngest / Temporal 引擎 | 能力包(引擎接缝已留) |
| 每步检查点 + 崩溃重放 | `recovery: 'auto'` + boot 时 `recoverAllDurableAgents()` | 能力包 / 部署方 |
| time-travel / restart | 快照 + `serializedStepGraph` 上的免费变种 | load→重进原语上的薄变种,无 port 变更 |

### 4.3 出域档(定位改变才重开)

| 缺口 | mastra 侧的事实 | 出域依据 |
| --- | --- | --- |
| Studio / editor / stored agents | Editor = agent 的 CMS(DB / code 双轨、draft / published 版本化) | 托管产品面 |
| channels / voice / workspaces & sandboxes | Slack 等渠道、语音、文件 / 沙箱 | 产品面 / 生态 |
| 托管平台 | 托管云 | 商业 |
| OM 类后台压缩 | Observer / Reflector 两个后台 agent + 14 个存储方法 | 后台写入与"无运行时负担"冲突;归外部记忆系统桥 |
| notification inbox | 持久化收件箱 + 两阶段投递(仅 3 个 adapter 支持) | 产品面 |
| signal providers | webhook / poll 入口基类(订阅登记簿 DIY) | 示例模式可承载 |
| AgentController / session | modes / permissions / channels / workspace 的成品运行时 | 应用层自组装 |

## 5. 现实差距(非功能,选型者最先看见)

| 差距 | 事实 | 状态 |
| --- | --- | --- |
| 发布 | mastra 1.x 已发布、迭代活跃;本框架 0.0.0 / 无 tag / registry 无包 | #45 待 owner 手工;本票不处理 |
| 上手面 | mastra.ai 文档站 + Studio + 快速开始 | 发布后补齐(README quick start 已有) |
| 适配器生态 | 多第一方 adapter + 208-provider 目录 | M5 起逐件交付;适配器生态留社区 |
| 公开可检验性 | mastra 的取舍可被任何人实测;本框架的轻量主张目前只有内部 CI 证据 | 发布时专项裁决(ADR-0001:字节预算不作对外定义) |

## 6. 对比揭示的东西

1. **mastra 的动向在反向验证多数裁剪**:OM 的 resource 作用域被官方弃用(本框架只做 thread 隔离 + 小结构化 resource 状态)、`.network()` 废弃回到 loop 内委派(本框架的 as-tool 是同一方向)、Studio / editor 是产品面、4 代 spec 并存是"接受一切"的维护账单、6/7 Beta 是跟随成本。
2. **本框架的缺口几乎全是基础设施形或产品形,不是语义形**:租约、轮询、事件缓存、存储域、Studio、渠道——每一条都撞在"无运行时负担"或"不接管宿主"上,说明这是轴的选择,不是没做完。
3. **真正的差距在公开存在**:mastra 的护城河是目录 + 生态 + Studio + 部署面;本框架的轻量主张目前对外不可检验,发布 0.1.0(#45)是把主张变成可检验的第一步。
4. **对齐有账单**:凡对齐的形状都自带跟随成本(mastra 的 4 代 spec、30 个依赖、Beta 漂移就是它自己的账单)。纪律:对齐语义,不对齐维护负担;缺口按 `docs/ROADMAP.md` 的重开条件维护,不凭"mastra 有什么"跟风。

## 附:来源

仓库内(本仓库,均为 2026-09-30 现状):

- 前序调研:`docs/research/mastra-agent-model-layer.md`(#4)、`mastra-memory.md`(#5)、`mastra-workflows.md`(#2 / #3)、`mastra-harness.md`(#17)、`observability-references.md`(#7)
- 架构规范:`docs/architecture/`(model / agent / tools / workflows / memory / observability / storage / harness 八篇)
- 决策:`docs/adr/`(0001–0015)
- 路线图与状态:`docs/ROADMAP.md`、`CONTEXT.md`、根 `README.md`
- 发布票:[#45](https://github.com/0xnicholas/balsa-framework/issues/45)(发布 0.1.0,owner 手工)
