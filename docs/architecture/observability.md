# Observability 形态

> 来源:wayfinder ticket #14(决策:Observability 形态)。本文件是 Observability 子系统的架构规范。
> 决策记录见 `docs/adr/0009-observability-tracing.md`;事实底座见 `research/observability-references` 分支 `docs/research/observability-references.md`;术语见 `CONTEXT.md`。

## 定位

观测子系统回答一个问题:run 内部发生了什么。设计遵守轻量轴:**内核自有最小 span 模型、核心零 OTel 依赖,OTel 映射外置为单一 OTLP 能力包**。北极星是出口收敛——内核怎么建模是自己的事,送出去的都是 GenAI semconv 形状,Langfuse / LangSmith / 各家 OTel 后端直接可收。v1 只定 tracing;metrics 不做、logs 走组合根已有的 logger 通道。

内核不自建 OTel span 的原因(ADR-0009):GenAI semconv 全部属性均为 Development 稳定性,JS 侧 `gen_ai.*` 常量只在 incubating export——把内核焊在 OTel 上是把变更风险请进核心;mastra 与 Vercel AI SDK 的实际选择同为「内核自有模型 + OTel 外置可选包」。

## Span 模型

```ts
interface Span {
  id: string,                         // 16-hex,OTel 兼容
  traceId: string,                    // 32-hex,OTel 兼容
  parentSpanId?: string,
  name: string,
  type: string,                       // 开放字符串;框架只写 5 个常量(下表)
  startTime: Date,
  endTime?: Date,
  input?: unknown,                    // 一等公民:prompt 是 LLM 调试主体
  output?: unknown,
  attributes?: SpanAttributes,        // 按 type 收窄的判别联合
  metadata?: Record<string, unknown>, // 用户开放袋
  error?: { message: string, details?: unknown },
  isEvent?: boolean,                  // 时间点 span:无 endTime,创建即导出
}
```

- **5 个框架类型常量**(kebab-case,与 chunk 协议词汇同构):`agent-run` / `agent-step` / `tool-call` / `workflow-run` / `workflow-step`。`type` 是开放 string,用户自建 span 任意取名;核心导出 5 个常量。
- **attributes 判别联合**(运行时零成本,OTLP 映射包读取有类型安全):

| type | attributes | input / output |
| --- | --- | --- |
| `agent-run` | `{ agentName }` | 入参消息 / 终值 text(或 structured 结果) |
| `agent-step` | `{ model, provider, parameters?, usage?, finishReason?, timeToFirstChunk? }` | prompt 消息 / 模型响应 |
| `tool-call` | `{ toolCallId }` | 参数 / 结果;失败落 `error` |
| `workflow-run` | `{ workflowId }` | 触发输入 / 终态结果 |
| `workflow-step` | `{ }`(name 即 step id) | step 输入 / 输出 |

- **root span attribute 带 `runId`**:runId 是执行身份(快照/Memory 已用),traceId 是观测身份,两者不同词、靠 root span 互查。
- **`isEvent` span**:无生命周期,创建即完成,只派发一次 `span_ended`(无 duration)。是「不想开完整 span 只打时间戳」的逃生口。
- **活 span API**(tracer.startSpan 返回):`end()` / `update(patch)` / `error(err)`;导出形态 `ExportedSpan` 去方法、去循环引用,加 `parentSpanId`。`error` 在活 span 上是记录方法,与数据字段同名同属性——记录的错误只在 `ExportedSpan.error` 上读,活 span 接口不重复暴露该数据字段。

## 事件与导出

生命周期只有三个事件,携带 `ExportedSpan`:

```ts
type TracingEvent =
  | { kind: 'span_started',  span: ExportedSpan }
  | { kind: 'span_updated',  span: ExportedSpan }
  | { kind: 'span_ended',    span: ExportedSpan }

interface ObservabilityExporter {
  export(event: TracingEvent): void | Promise<void>,
  flush?(): Promise<void>,      // 可选:console 没有批概念
  shutdown?(): Promise<void>,
}
```

裁掉 mastra 接口上的 `init?()`(构造即初始化)与 `name` 字段。exporter 的可选 `flush` / `shutdown` 不各调用各的:tracer 暴露同名的 `flush()` / `shutdown()` 转发,`flush()` 同时等待在途的异步 export。

```ts
createTracer({
  exporters: ObservabilityExporter[],
  sampler?: 'always' | 'never' | { ratio: number } | ((parent) => boolean), // 默认 'always'
  spanProcessors?: SpanProcessor[], // 全局同步管线
  hideInput?: boolean,              // 导出时擦 input 的 trace 级默认(可 per-span 覆盖)
  hideOutput?: boolean,
})
```

- **采样**:四档;只在 root span 创建时判定一次,子 span 继承;不通过返回 `NoOpSpan`(全方法 no-op),其后代自动全 NoOp——埋点代码无分支。没挂 tracer 时整个子系统零开销。
- **spanProcessors**:导出前整形缝。同步、逐事件生效(每个事件派发前过一遍),原地改写或返回 `undefined` 丢弃该事件。规则库不进核心——PII 规则是应用域知识。
- **`hideInput` / `hideOutput`**:trace 级开关,导出时擦字段;可在 run option per-call 覆盖(透传为 root span 的创建选项,并由子孙继承同一条 trace 的决定)。擦除发生在 spanProcessors 之后——exporters 永远看不到被擦字段,而处理器仍能拿到原始值做规则化脱敏。
- **组合根分发**:`createApp({ tracer })`(ADR-0002 已有此位);子系统独立 `new` 时也可显式传入(Agent 侧即 `AgentConfig.tracer` 注入缝),不挂即零开销。

## 自动埋点:五边界

tracer 存在时框架自动开 span,缺席时 NoOp 零开销:

1. **agent run** — 一次 generate()/stream() 全程
2. **agent step** — run 内每轮模型调用;`timeToFirstChunk` 落此 span(替代被裁的 chunk 级 span 的最高价值部分)
3. **tool call** — agent loop 内每次工具执行
4. **workflow run** — start/resume 到终态
5. **workflow step** — 每个 step 边界

裁掉:mastra 的 `MODEL_CHUNK`(chunk 已在 chunk 协议流里,观测侧可从流事件重建,不为此开 span)与 `MODEL_GENERATION` 中间层(run→step 两级已够表达)。sub-agent 由 Agent 规范定为 as-tool 兜底,自然落成 `tool-call` span,无专门类型。

## 上下文传播与身份

- **框架内部显式传播**:Agent loop / Workflow walker 沿执行树把 parent span 传给下一代——**不用 AsyncLocalStorage**(edge / CF Workers 需 compat flag,且隐式上下文是魔法)。用户 tool 内自建 span 同样走显式 parent(tracer API 参数)。内核缝是 `startSpan` 的两种入参:`{ parent }` 传活 span(正常执行树),或 root 创建时传 `{ traceId, parentSpanId }` 续接别处开始的 trace——二者互斥,`parentSpanId` 必须与 `traceId` 同来。
- **外部 trace 延续**:run 级 option(Agent generate/stream 与 workflow createRun)接受可选 `{ traceId?, parentSpanId? }`;解析 `traceparent` header 是应用层的事。(ALS 集成归延后的 OTel bridge。)
- **suspend/resume**:traceId 进 workflow 快照,resume 续同一 trace。

## Exporter 清单

- **核心包自带两个**:`console`(开发调试美化打印)与 `memory`(环形缓冲,测试/集成断言的抓手)。
- **OTLP 能力包一个**(独立 npm 包,名待「项目命名与品牌」决策):把 span 映射为 GenAI semconv 形状——`{operation} {model}` 命名、`gen_ai.operation.name / provider.name / request.model / usage.*` 属性、parts 格式消息;usage 只挂 `chat` span 防后端重复计数。transport 仅 HTTP/protobuf + HTTP/JSON,**不做 gRPC**(Langfuse 不收 gRPC,`@grpc/grpc-js` 依赖重);协议层依赖 OTel 官方 exporter 包,隔离在包边界。带 env-var 零配置 preset。
- **不做厂商专用 exporter**:Langfuse / LangSmith 均把裸 OTLP + `gen_ai.*` 当一等摄入路径,发标准形状即同时覆盖多家后端。
- **OTel bridge**(复用进程内 OTel SDK 上下文):延后。mastra 同类包至今 experimental;记为地图 fog,路线图阶段判断。

## 与其它子系统的关系

- **模型层(#9,已定)**:chunk 协议是共用流式词汇;`agent-step` 的 model/provider/usage 取自模型契约的 finish/usage chunk。
- **Agent(#10,已定)**:tracer 挂钩是内部缝,不占 Processor 名额;span 挂 run / step / 工具执行三边界;run option 携带外部 trace 延续与 `hideInput/hideOutput` 覆盖。
- **Workflows(#11,已定)**:span 挂 run / step 边界;lifecycle 事件流是事件锚点;traceId 随快照持久化。
- **Memory(#12,已定)**:无直接耦合。
- **Harness(#18)**:持久执行跨进程恢复时 trace 延续语义归它,本规范的 traceId-进快照是其底层机器。

## 依赖预算

核心(含 observability 子路径)运行时依赖 = 0(ADR-0001 红线,内部 CI 回归参考);OTLP 能力包依赖 OTel 官方 exporter 包,不装不付。
