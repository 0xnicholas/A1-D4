# 调研:可观测性参照(OTel GenAI 与 mastra)

> Issue: #7 · 日期:2026-09-28 · 性质:事实收集 + 轻量化取舍含义,不做架构决策。

## TL;DR

OTel GenAI 语义约定目前是**全部 Development 稳定性**(2026-06 刚从主仓拆到独立仓库 `open-telemetry/semantic-conventions-genai`,无 tagged release),但 `gen_ai.*` 属性命名空间已经成为 Langfuse、LangSmith、Vercel AI SDK、mastra 共同的互操作语言。参照系的收敛点很清楚:**span 树(agent run → model step/chat → tool call)+ 导出时映射到 `gen_ai.*`**。差异在内核:AI SDK 是"生命周期回调接口 + 可选 OTel integration"(默认零依赖),mastra 是"自有 span 模型 + exporter 总线 + 独立 OTel exporter/bridge 包"。对"极致轻量"目标,事实指向:核心只定义 span 形状与 exporter 接口,OTel 输出做成独立可选包。

---

## 1. OpenTelemetry GenAI 语义约定(GenAI SIG)现状

### 1.1 归属与稳定性

- 文档原址 `opentelemetry.io/docs/specs/semconv/gen-ai/` 现在只有搬迁告示,实际内容在独立仓库 [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)(覆盖 GenAI 客户端、agent、MCP、provider 专有约定;用 Weaver 生成文档)。拆分发生在 semconv v1.42.0(2026-06-12),主仓中旧的 `model/gen-ai/`、`model/openai/`、`model/mcp/` 同时被 deprecated(二手来源:[dash0](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained)、[niteagent](https://niteagent.com/blog/2026-08-07-otel-genai-agent-trace-field-guide/),与官方仓库迁移告示一致)。
- **稳定性:全部 Development。** 一手验证:新仓库 `model/gen-ai/registry.yaml` 中 `stability: development` 出现 120 次,`stability: stable` 0 次(2026-09-28 实测)。每个 span/event 文档头部也标注 `**Status**: Development`。二手统计说 registry 共 63 个 `gen_ai.*` 属性 key、无一稳定([particula](https://particula.tech/blog/opentelemetry-genai-semantic-conventions-stable))。新仓库尚无 tagged release(2026 年中仍如此,[praesidia](https://praesidia.ai/blog/opentelemetry-genai-semantic-conventions-status))。
- 过渡期机制:`OTEL_SEMCONV_STABILITY_OPT_IN`(如 Python 侧 `gen_ai_latest_experimental`),instrumentation 默认继续发旧形状以免打爆已有 dashboard([coderlegion](https://coderlegion.com/24350/your-ai-agent-is-a-black-box-instrumenting-llm-apps-with-opentelemetry-genai-conventions))。
- JS 生态事实:`@opentelemetry/semantic-conventions@1.43.0`(latest)只在 **incubating export**(`index-incubating` / `experimental_attributes`)携带 `gen_ai.*` 常量(实测 83 处),stable export 没有。JS 没有官方 GenAI 自动埋点包(Python 有 `opentelemetry-instrumentation-openai-v2` 等);JS 里的事实标准是 Vercel AI SDK 的 `@ai-sdk/otel`(见 §3)。

### 1.2 Span 模型([gen-ai-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md)、[gen-ai-agent-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md))

Span 代表"调用方视角的逻辑操作",覆盖整个操作时长(含自动重试)。命名模板:`{gen_ai.operation.name} {gen_ai.request.model}`(agent 类用 `{operation} {gen_ai.agent.name}`)。

| 操作 | span name | kind | 说明 |
| --- | --- | --- | --- |
| inference(`chat`/`generate_content`/`text_completion`) | `chat {model}` | CLIENT(同进程模型可 INTERNAL) | 核心 LLM 调用 |
| `embeddings` / `retrieval` / `fetch_response` | 同模板 | CLIENT | fetch_response 不报 token usage |
| `create_agent` | `create_agent {agent.name}` | CLIENT | 通常用于远程 agent 服务 |
| `invoke_agent` | `invoke_agent {agent.name}` | CLIENT(远程)/ INTERNAL(本地框架) | agent 执行 |
| `invoke_workflow` | `invoke_workflow {workflow.name}` | INTERNAL | 工作流 |
| `plan` | `plan {agent.name}` | INTERNAL | 规划/任务分解 |
| `execute_tool` | `execute_tool {gen_ai.tool.name}` | INTERNAL | 工具执行;MCP 工具可叠加 MCP 约定 |

属性分层(inference span 为例):
- **Required**:`gen_ai.operation.name`、`gen_ai.provider.name`(well-known 值:`openai`、`anthropic`、`gcp.vertex_ai`、`azure.ai.openai`、`aws.bedrock` 等 16 个)。
- **Conditionally Required**:`error.type`(出错时,Stable 属性)、`gen_ai.request.model`、`gen_ai.conversation.id`(有现成会话 id 才填,**禁止**用 UUID/traceId 兜底)、`gen_ai.request.stream` 等。
- **Recommended**:`gen_ai.request.{temperature,top_p,top_k,max_tokens,stop_sequences,seed,...}`、`gen_ai.response.{id,model,finish_reasons}`、`gen_ai.usage.{input_tokens,output_tokens}` + 细分 token(cache_read/cache_write/reasoning/audio/image/text 子族,均为汇总值的子集)、`gen_ai.response.time_to_first_chunk`。
- **Opt-In(含敏感信息,带 PII 警告)**:`gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.system_instructions`、`gen_ai.tool.definitions`、`gen_ai.prompt.variable.<key>`。
- 采样相关属性(operation/provider/model/server.address)应在 **span 创建时**就提供。
- `execute_tool` span:Required `gen_ai.operation.name`+`gen_ai.tool.name`;Recommended `gen_ai.tool.{call.id,description,type}`;Opt-In `gen_ai.tool.call.{arguments,result}`(应为结构化对象)。

消息格式:`gen_ai.input.messages`/`output.messages` 必须遵循仓库内 JSON schema(`model/gen-ai/gen-ai-{input,output}-messages.json`):`[{role, parts:[...]}]`,part 类型 = `text`/`reasoning`/`tool_call`/`tool_call_response`/`blob`/`uri`;span 上允许序列化成 JSON 字符串,event 上必须结构化。每个 output message 严格对应一个 choice,与 `finish_reasons` 数组按位对齐。

内容捕获三条路径(规范明确并列):span 属性、独立 event、上传到外部存储后引用。

### 1.3 事件模型([gen-ai-events.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md))

收敛到**两个事件**,均为 Development:

- `gen_ai.client.inference.operation.details`(Opt-In):单个事件携带完整一次调用的输入输出明细(属性集与 inference span 几乎相同),用于"输入输出独立于 trace 存储"。**早期 per-message 事件(`gen_ai.user.message`/`gen_ai.choice` 等)已被取代**——LangSmith 的映射表还在兼容这套旧事件,侧面说明事件模型仍在变动。
- `gen_ai.evaluation.result`(Recommended):评估分数,`gen_ai.evaluation.{name,score.value,score.label,explanation}`,尽量挂到被评估的 span 下。

注意:OTel 事件基于 logs API,部分语言 SDK 尚未实现(规范原文提示查 spec-compliance matrix)。

### 1.4 Metrics([gen-ai-metrics.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md))

客户端:`gen_ai.client.operation.duration`、`gen_ai.client.operation.time_to_first_chunk`、`gen_ai.client.operation.time_per_output_chunk`;agent:`gen_ai.invoke_agent.{duration,inference_calls,tool_calls}`;工具:`gen_ai.execute_tool.duration`;工作流:`gen_ai.invoke_workflow.duration`;模型服务端:`gen_ai.server.{request.duration,time_per_output_token,time_to_first_token}`。另有独立的 token 计量文档(`gen-ai-token-metrics.md`)。

---

## 2. mastra `@mastra/observability` 的模型与导出面

来源:[Tracing 概念](https://mastra.ai/docs/observability/tracing/overview.md)、[Spans 参考](https://mastra.ai/reference/observability/tracing/spans.md)、[Interfaces 参考](https://mastra.ai/reference/observability/tracing/interfaces.md)、[OTel 集成](https://mastra.ai/integrations/observability/opentelemetry.md)、[OtelExporter 参考](https://mastra.ai/reference/observability/tracing/exporters/otel.md)。

### 2.1 内核:自有 span 模型(不是 OTel-native)

```ts
interface BaseSpan {
  id: string                 // span id
  traceId: string            // OTel 兼容,32 hex
  name: string
  type: SpanType             // 见下
  startTime: Date; endTime?: Date
  attributes?: SpanTypeMap[TType]   // 按类型收窄的结构化属性
  metadata?: Record<string, any>    // 用户自定义
  input?: any; output?: any         // 一等公民字段
  errorInfo?: { message; id?; domain?; category?; details? }
  isEvent: boolean           // 事件 span:无 endTime 的时间点
}
```

`Span` 在此基础上加生命周期方法:`end()`/`error()`/`update()`/`createChildSpan()`/`createEventSpan()`;`isInternal` 标记框架内部 span(默认不导出);导出前转成 `ExportedSpan`(去方法、去循环引用,加 `parentSpanId`/`isRootSpan`)。采样不通过时返回 `NoOpSpan`(全方法 no-op)。ID 规则对齐 OTel:traceId 1–32 hex、spanId 1–16 hex,非法输入降级而非崩溃。

`SpanType` 是**框架领域枚举**而非 OTel operation:`AGENT_RUN`、`WORKFLOW_RUN`、`MODEL_GENERATION`(整轮生成循环)、`MODEL_STEP`(单次模型调用)、`MODEL_INFERENCE`(纯推理)、`MODEL_CHUNK`(流式 chunk)、`TOOL_CALL`、`CLIENT_TOOL_CALL`、`PROVIDER_TOOL_CALL`、`MCP_TOOL_CALL`、`MCP_SERVER_REQUEST`、`WORKFLOW_STEP` 等约 25 种。模型类属性是结构化的:`ModelGenerationAttributes{ model, provider, tools, usage{promptTokens,completionTokens,...}, parameters{temperature,...}, streaming, finishReason }`。

### 2.2 导出管线:事件总线 + exporter 接口

- 生命周期只有三个事件:`span_started` / `span_updated` / `span_ended`(`TracingEvent`,携带 `ExportedSpan`)。
- `ObservabilityExporter` 接口:`name`、`init?()`、`onTracingEvent?()`、`exportTracingEvent()`、`flush()`、`shutdown()`(另有 log/metric/score/feedback 事件回调)。
- 导出前的两级整形:**SpanOutputProcessor**(同步、原地改写或返回 `undefined` 丢弃,全局生效,内置 `SensitiveDataFilter`)和 **per-exporter customSpanFormatter**(可异步,平台定制)。
- 配置面:`Observability({ configs: { name: { serviceName, sampling, exporters, spanOutputProcessors, excludeSpanTypes, ... } } })`,支持多 config + selector;sampling 四档 `always`/`never`/`ratio`/`custom`。
- 数据卫生:`serializationOptions` 截断(字符串 1024/深度 6/数组 50/对象键 50);`hideInput`/`hideOutput` trace 级开关(导出时生效)。

### 2.3 OTel 面:exporter 与 bridge 两个独立包

- **`@mastra/otel-exporter`(OtelExporter)**:把 mastra span 映射成 **GenAI semconv v1.38.0** 形状的 OTLP 数据。span 名:`chat {model}`(每次模型调用一个,**usage 只挂这里**,避免后端重复计数)、`model_generation {model}`(整轮循环)、`agent_step {agent_id}`(每轮)、`execute_tool {tool_name}`、`invoke_agent {agent_id}`、`invoke_workflow {workflow_id}`。属性:`gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.{input,output}.messages`、`gen_ai.usage.*` 等。协议按需装包:grpc / http+protobuf / http+json / zipkin,logs 信号可独立开关(`BatchSpanProcessor`/`BatchLogRecordProcessor`);内置 Dash0/SigNoz/NewRelic/Traceloop/Laminar 的 env-var 零配置 + `custom` 端点。
- **`@mastra/otel-bridge`(OtelBridge,experimental)**:不导出,而是接入进程内已有 OTel SDK——从 AsyncLocalStorage 读活跃 span 继承 traceId/parentSpanId(遵守上游采样决定),反向把 mastra span 建成真正的 OTel span,使 mastra 内部的 HTTP/DB 自动埋点能正确嵌套;logs 转发到全局 LoggerProvider。这验证了"bridge"模式:核心保持自有模型,通过薄适配器参与 OTel 上下文。
- **专用 exporter**(每家一个 npm 包):`@mastra/langfuse`、`@mastra/langsmith`、`@mastra/braintrust`、Arize、Datadog、Sentry、PostHog、Laminar、Confident AI 等;另有 `MastraStorageExporter`(落自家存储)。Langfuse exporter 的配置项暴露了实现细节:`flushAt` = "Maximum spans per OTEL export batch"——即其底层也是 OTel 批导。
- Tags:仅 root span,OtelExporter/OtelBridge 落成 `mastra.tags` 属性(JSON 字符串,为兼容 Jaeger/Zipkin/Tempo 等数组支持差的后端)。

---

## 3. Vercel AI SDK telemetry:最轻的一层

来源:[AI SDK Telemetry 文档](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)。

- **形状**:core 里只有一个 `Telemetry` 接口——全可选的生命周期回调(`onStart`/`onStepStart`/`onLanguageModelCallStart/End`/`onToolExecutionStart/End`/`onStepEnd`/`onEnd`/`onAbort` 等),事件对象带 `modelId`、`usage`、`toolCall`、`toolExecutionMs` 等。`registerTelemetry()` 全局注册,或 per-call `telemetry: { integrations: [...] }`;integration 内异常被吞掉不影响生成。默认不注册任何 integration 即零开销。
- **OTel 是可选包 `@ai-sdk/otel`**,两个实现:
  - `OpenTelemetry`(推荐):直接发 GenAI semconv 形状的三层 span——`invoke_agent {modelId}`(root,INTERNAL;`functionId`→`gen_ai.agent.name`)→ `chat {modelId}`(每次 provider 调用,CLIENT)→ `execute_tool {toolName}`(INTERNAL)。消息用 GenAI parts 格式;usage、TTFT(`gen_ai.client.operation.time_to_first_chunk`)、`time_per_output_chunk` 都按新约定。可用 `enrichSpan` 回调加自定义属性。
  - `LegacyOpenTelemetry`:旧 `ai.*` 命名(`ai.generateText`/`ai.generateText.doGenerate`/`ai.toolCall`),同时带一份旧版 `gen_ai.*` 属性。
- 隐私开关:per-call `recordInputs`/`recordOutputs`;`includeRuntimeContext`/`includeToolsContext` 白名单式挑选哪些上下文键进入 telemetry。
- 零依赖订阅点:Node 的 `diagnostics_channel` 上有 `ai:telemetry` tracing channel,第三方不改用户代码即可订阅生命周期事件。

---

## 4. Langfuse / LangSmith:后端侧的接入形状

### Langfuse([OTel 文档](https://langfuse.com/docs/opentelemetry/get-started))

- 一等摄入路径是 **OTLP HTTP endpoint `/api/public/otel`**(HTTP/JSON + HTTP/protobuf,**不支持 gRPC**);Basic Auth(pk:sk base64);实时视图需 `x-langfuse-ingestion-version: 4` header。SDK v4(Python/JS)本身就是 OTel 客户端的薄封装。
- 属性映射**显式兼容 GenAI semconv**:`gen_ai.request.model`/`gen_ai.response.model`→model,`gen_ai.request.*`→modelParameters,`gen_ai.usage.*`→usage,`gen_ai.tool.call.{arguments,result}`→input/output;同时兼容 OpenInference(`input.value`)、MLflow 等方言。`langfuse.*` 命名空间优先于通用约定。
- trace 级字段(userId/sessionId/tags/metadata)需要**传播到每个 span**(推荐 OTel Baggage + BaggageSpanProcessor),否则过滤/聚合失效。
- 摄入容错:不认识的 `langfuse.observation.type` 不拒绝,逐级 fallback(`gen_ai.operation.name` → 有 model 属性则 generation → span);缺时间戳自动补齐。

### LangSmith([Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry))

- 同样提供 **OTLP endpoint `/otel/v1/traces`**(`x-api-key` + `Langsmith-Project` header),也支持 `LANGSMITH_OTEL_ENABLED=true` 走 langsmith SDK 内置 OTel 导出;官方推荐 fan-out 场景用 Collector。
- 映射表是**多方言宽容**的典型:`langsmith.*` 自有命名空间 + 新旧两代 `gen_ai.*`(包括已废弃的 `gen_ai.prompt.{n}.content` 平铺格式和 per-message 事件)+ OpenInference + Traceloop + Logfire。
- 坑:OTLP span id 8 字节,LangSmith run id 是 UUID,要挂到既有 run 需传 `langsmith.span.*` 属性;**父 span 未发到 LangSmith 时子 span 会被静默丢弃**(200 先回、后台组装,buffer 有窗口期)。

**横向事实**:两大 LLM 观测平台都把"裸 OTLP + `gen_ai.*`"当作通用摄入协议,并主动兼容多套历史/竞争方言。发标准 GenAI semconv 形状的 OTLP,等于同时获得 Langfuse、LangSmith、Braintrust、Datadog、SigNoz 等后端。

---

## 5. 结论指向:轻量 tracing 的最小集

综合三个参照系,反复出现的公共结构:

**Span 形状(最小集)**: `{ id, traceId(32-hex, OTel 兼容), parentSpanId, name, type, startTime, endTime, input, output, attributes(按 type 收窄), metadata, error }`。mastra 与 AI SDK 都把 **input/output 作为 span 一等公民字段**(尽管 OTel 官方更倾向 Opt-In 属性/事件/外部存储)——这是 LLM 观测的实际需求(prompt 是调试主体)。`isEvent`(无 duration 的时间点 span)同时出现在 mastra 与 OTel 的 parts/事件需求里,成本极低。

**生命周期/导出接口(最小集)**: 事件只有 `started/updated/ended` 三种(mastra),或细粒度生命周期回调(AI SDK,约 10 个全可选方法);exporter 最小面 = `export(event)` + `flush()` + `shutdown()`。采样用 always/never/ratio/custom 四档即可覆盖实际用法。`NoOpSpan`(采样不通过时返回哑对象)是让埋点代码无分支的关键小机制。

**"是否直接 OTel-native"的事实摆位**(取舍含义,非决策):

| 路线 | 代表 | 事实 |
| --- | --- | --- |
| 内核直接 OTel-native(`@opentelemetry/api` 建 span) | OtelBridge 模式 | 上下文传播/嵌套免费、无映射层;但 JS 侧要拖入 API+SDK+协议 exporter 包(gRPC 还要 `@grpc/grpc-js`),且 `gen_ai.*` 常量只在 incubating export,属性名全 Development、变更风险由自己承担 |
| 自有 span 模型 + OTel exporter 独立包 | mastra | 核心零 OTel 依赖、NoOp 简单、领域类型(SpanType)表达能力更强;代价是维护 `gen_ai.*` 映射层并跟随 semconv 演进(mastra 钉在 v1.38.0) |
| 生命周期回调接口 + 可选 OTel integration | Vercel AI SDK | 核心最轻(一个接口),OTel 支持是纯附加包;接口事件形状需设计得当(它的回调事件同时服务 OTel 与非 OTel 消费者) |

共同结论(事实层):三条路线在**出口处收敛**——最终都发 GenAI semconv 形状(`{operation} {model}` 命名、`gen_ai.operation.name/provider.name/request.model/usage.*`、parts 格式消息),因为后端(Langfuse/LangSmith/mastra  exporter 群)都认这套。轻量化的分歧点只在"OTel 依赖进不进内核"。鉴于 semconv 稳定性全 Development + JS 侧 gen_ai 常量只在 incubating,"内核自有、OTel 映射外置为可选包"是三个参照系中两个(mastra、AI SDK)的实际选择;事件模型(输入输出独立成 event)在 OTel 侧尚新且 JS logs 支持不全,不宜作为唯一承载。

---

## 来源

一手来源:

- [open-telemetry/semantic-conventions-genai(仓库 README/docs)](https://github.com/open-telemetry/semantic-conventions-genai) · [gen-ai-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md) · [gen-ai-agent-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md) · [gen-ai-events.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md) · [gen-ai-metrics.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md) · 稳定性计数实测自 [registry.yaml](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/model/gen-ai/registry.yaml)
- [opentelemetry.io GenAI semconv 旧页(搬迁告示)](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [@opentelemetry/semantic-conventions@1.43.0 包内容实测(unpkg)](https://unpkg.com/@opentelemetry/semantic-conventions@1.43.0/build/src/index.d.ts)
- mastra:[Tracing overview](https://mastra.ai/docs/observability/tracing/overview.md) · [Spans reference](https://mastra.ai/reference/observability/tracing/spans.md) · [Interfaces reference](https://mastra.ai/reference/observability/tracing/interfaces.md) · [OpenTelemetry integration](https://mastra.ai/integrations/observability/opentelemetry.md) · [OtelExporter reference](https://mastra.ai/reference/observability/tracing/exporters/otel.md) · [Langfuse integration](https://mastra.ai/integrations/observability/langfuse.md) · [LangSmith integration](https://mastra.ai/integrations/observability/langsmith.md) · [llms.txt 页面清单](https://mastra.ai/llms.txt)
- [Vercel AI SDK: Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Langfuse: OpenTelemetry endpoint](https://langfuse.com/docs/opentelemetry/get-started)
- [LangSmith: Trace with OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry)

二手来源(仅用于迁移时间线/稳定性叙述,均与一手交叉验证):[dash0](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained) · [niteagent](https://niteagent.com/blog/2026-08-07-otel-genai-agent-trace-field-guide/) · [particula](https://particula.tech/blog/opentelemetry-genai-semantic-conventions-stable) · [praesidia](https://praesidia.ai/blog/opentelemetry-genai-semantic-conventions-status) · [coderlegion](https://coderlegion.com/24350/your-ai-agent-is-a-black-box-instrumenting-llm-apps-with-opentelemetry-genai-conventions)
