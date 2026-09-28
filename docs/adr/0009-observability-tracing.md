# Observability 形态:自有最小 span 模型 + 三事件导出总线 + OTLP 单能力包

内核自有最小 span 模型(`{ id, traceId, parentSpanId, name, type, startTime, endTime, input, output, attributes, metadata, error, isEvent }`,input/output 一等公民),核心零 OTel 依赖;生命周期只有 `span_started/updated/ended` 三事件,exporter 接口最小面 `{ export, flush?, shutdown? }`;OTel 输出外置为单一 OTLP 能力包(HTTP/protobuf + HTTP/JSON,映射 GenAI semconv,无 gRPC、无厂商专用 exporter)。v1 只定 tracing(metrics 不做,logs 走组合根 logger 通道)。自动埋点五边界:agent run / agent step / tool call / workflow run / workflow step,裁 chunk 级与 generation 中间层。敏感数据:缝进核心(全局同步 spanProcessors 逐事件管线 + `hideInput/hideOutput` 开关),规则库不进。上下文沿执行树显式传播,不用 ALS;runId 与 traceId 双身份互查,traceId 进 workflow 快照供 resume 续同一 trace。依据:GenAI semconv 全 Development 稳定性且 JS 常量仅 incubating(内核焊 OTel = 变更风险进核心)、轻量轴(核心零依赖红线,ADR-0001/0002)、出口收敛事实(Langfuse/LangSmith 均认裸 OTLP + `gen_ai.*`)、可逆性不对称(映射层关在包边界内,内核免疫 semconv 演进)。

## Considered Options

- **OTel-native 内核(`@opentelemetry/api` 建 span)**:被否——上下文传播免费,但核心拖入 API+SDK+协议 exporter 依赖链;JS 侧 `gen_ai.*` 常量只在 incubating export,Development 期属性名变更风险直接进核心,与 ADR-0002「核心保持极小」正面冲突。
- **AI SDK 式纯生命周期回调接口(核心无 span 模型)**:被否——核心最轻,但 LLM 观测的刚需是 input/output 一等公民的 span 形状;纯回调把建树推给每个消费者,且 exporter 终归需要一个事件形状。
- **chunk 级 span(mastra `MODEL_CHUNK`)**:被否——chunk 已在 chunk 协议流里,观测可从流事件重建;首 chunk 时延以 `timeToFirstChunk` attribute 落在 agent-step 上。
- **`MODEL_GENERATION` 中间层(整轮循环包一层)**:被否——run→step 两级已够表达。
- **内建默认敏感数据规则库(mastra `SensitiveDataFilter`)**:被否——PII 规则是应用域知识,内建猜不准且违背无运行时负担;但导出前整形缝(spanProcessors)事后补不了,必须现在留。
- **gRPC transport**:被否——Langfuse 不支持 gRPC;`@grpc/grpc-js` 依赖重。
- **厂商专用 exporter 群(mastra 式一家一包)**:被否——Langfuse/LangSmith 把裸 OTLP + `gen_ai.*` 当一等摄入,标准形状全覆盖。
- **AsyncLocalStorage 隐式上下文**:被否——edge/CF Workers 需 compat flag,隐式上下文是魔法;显式传播零成本(框架自有执行树),ALS 集成归延后的 OTel bridge(记为地图 fog)。

## Consequences

- span 形状、三事件、exporter 接口是公开 API,发布后改动是 major;新增框架 span 类型走 minor(开放 string 类型字段不挡路)。
- `gen_ai.*` 映射层须跟随 semconv 演进(全 Development),变更被关在 OTLP 能力包内;核心模型不随动。
- 采样判定只在 root span;`NoOpSpan` 传播是埋点代码无分支的前提,所有自动埋点必须经 tracer API,不自建旁路。
- OTel bridge 与 metrics 均为后加位:bridge 待路线图阶段判断(雾区),metrics 真要做时 exporter 加回调是向后兼容。

(来源:wayfinder ticket #14)
