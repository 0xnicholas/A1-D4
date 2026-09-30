# 调研:OTLP 官方 JS 包拼接与 SpanExporter 面(issue #70)

调研日期:2026-09-30 · 分支:`research/otlp-js-packages` · 目标:为决策票「OTLP exporter 能力包」(#73)提供官方包拼接、SpanExporter/处理器面、三事件桥接所需 API、配置与环境变量面的一手事实。**本文只呈现事实,不做决策。**

版本钉(npm `latest`,2026-09-30 实测):`@opentelemetry/exporter-trace-otlp-proto@0.222.0`、`@opentelemetry/exporter-trace-otlp-http@0.222.0`、`@opentelemetry/otlp-exporter-base@0.222.0`、`@opentelemetry/otlp-transformer@0.222.0`、`@opentelemetry/sdk-trace@2.11.0`、`@opentelemetry/sdk-trace-base@2.11.0`、`@opentelemetry/sdk-trace-node@2.11.0`、`@opentelemetry/api@1.9.1`、`@opentelemetry/core@2.11.0`、`@opentelemetry/resources@2.11.0`、`@opentelemetry/semantic-conventions@1.43.0`。实测环境:Node v26.2.0 / npm 11.13.0;仓库基线 commit `c7ce114`。

## TL;DR

- **最小可行集合 = 一个 exporter 包 + peer `@opentelemetry/api`**,安装树实测 **11 包 / 19,252,639 B unpacked(18.36 MiB)**;改用「仅 `@opentelemetry/otlp-transformer` + 自实现 HTTP」也 **仍有 9 包 / 18,547,539 B(17.69 MiB)**,只省 **705,100 B(0.67 MiB)**。大头不在 exporter,而在传递依赖:`semantic-conventions` 单包 **12.0 MB(占 62%)**、`sdk-metrics` **1.85 MB**、`sdk-logs` **0.68 MB**——两台「信号」序列化器与其依赖是 `otlp-transformer` 的硬依赖。
- **不需要 SDK 的 Tracer/Provider/Span**:`OTLPTraceExporter.export()`、`SimpleSpanProcessor.onEnd()`、`BatchSpanProcessor.onEnd()` 只要求入参**结构上满足 `ReadableSpan`**;实测自建普通对象即可直发(287 B protobuf,POST `/v1/traces`)。`Span` 在 2.x 里只有 `export type` 导出,本来也无法 `new`。
- **2.x 起实现已迁到 `@opentelemetry/sdk-trace`**:`@opentelemetry/sdk-trace-base` 变成**重导出 shim**(`main: build/src/index-shim.js`,`BasicTracerProvider` 等均为 shim);实测安装树里只有 `sdk-trace`,**没有 `sdk-trace-base`**。
- **`SpanExporter` 面** = `export(spans, cb)` + `shutdown(): Promise<void>` + **可选 `forceFlush?()`**——注意是 `forceFlush`,**没有 `flush()`**;结果类型 `ExportResult { code, error? }`,`ExportResultCode.SUCCESS = 0 / FAILED = 1`(**在 `@opentelemetry/core`**)。
- **桥接面一一对得上**:`traceId` 32-hex、`spanId` 16-hex、`parentSpanId`、`HrTime` 时间戳(框架侧是 `Date`,需转换)、`status`、`attributes`、`events`、`links`、`resource`、`instrumentationScope`。实测两条硬约束:`resource` **必填**(缺失时 transformer 直接抛 `Cannot read properties of undefined (reading 'attributes')`);`attributes` 只收**原语 / 原语数组**(`AttributeValue`,对象非法)。
- protobuf 序列化**无 protobufjs 运行期依赖**(`otlp-transformer` 自带 writer);实测三组安装树里都没有 `protobufjs`。
- **配置面**:`OTLPExporterNodeConfigBase` = `url`(默认 `http://localhost:4318/v1/traces`)/`headers`/`timeoutMillis`(默认 10000)/`concurrencyLimit`(默认 30)/`compression`(默认 `none`)/`keepAlive`/`httpAgentOptions`/`userAgent`;env 读 `OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS,TIMEOUT,COMPRESSION,CERTIFICATE,CLIENT_CERTIFICATE,CLIENT_KEY}` + `..._TRACES_*` 特化;**`OTEL_EXPORTER_OTLP_PROTOCOL` 这两个包不读**(选包即选协议)。
- `gen_ai.*` 复核(沿 #7):`semantic-conventions@1.43.0` 的 stable `.` 入口不带,只有 `./incubating` 入口带(`experimental_attributes/events/metrics`);该包 unpacked **12.0 MB**。

## 1. 版本、包职责与依赖关系

`npm view` 实测(2026-09-30;`dist.unpackedSize` / `dist.fileCount` 为 registry 元数据,单包口径):

| 包 | 版本 | unpacked | 文件数 | 依赖(registry 声明) | 职责 |
| --- | --- | --- | --- | --- | --- |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.222.0 | 57,561 B | 75 | `sdk-trace` 2.11.0、`otlp-transformer` 0.222.0、`otlp-exporter-base` 0.222.0 | Node/浏览器 trace exporter,HTTP/protobuf |
| `@opentelemetry/exporter-trace-otlp-http` | 0.222.0 | 59,648 B | 75 | 同上 | Node/浏览器 trace exporter,HTTP/JSON |
| `@opentelemetry/otlp-transformer` | 0.222.0 | 1,053,804 B | 399 | `core` 2.11.0、`api-logs` 0.222.0、`sdk-logs` 0.222.0、`resources` 2.11.0、`sdk-trace` 2.11.0、`sdk-metrics` 2.11.0 | 三种信号的 OTLP 请求编码器(protobuf + JSON) |
| `@opentelemetry/otlp-exporter-base` | 0.222.0 | 647,539 B | 327 | `core` 2.11.0、`otlp-transformer` 0.222.0 | 传输/重试/并发/批配置的基座(`OTLPExporterBase`、delegate、transport) |
| `@opentelemetry/sdk-trace` | 2.11.0 | 797,835 B | 318 | `core`、`resources`、`semantic-conventions` `^1.29.0` | **实现包**:`ReadableSpan`/`SpanExporter`/`SpanProcessor`/`TracerProvider`/`BatchSpanProcessor`/`SimpleSpanProcessor`/采样器/内置 exporter |
| `@opentelemetry/sdk-trace-base` | 2.11.0 | 123,728 B | 75 | `core`、`resources`、`sdk-trace`、`semantic-conventions` | **重导出 shim**(`main: build/src/index-shim.js`,含 `BasicTracerProvider-shim`、`BatchSpanProcessor-shim` 等) |
| `@opentelemetry/sdk-trace-node` | 2.11.0 | 32,087 B | 15 | `core`、`sdk-trace-base`、`context-async-hooks` | `NodeTracerProvider` + AsyncLocalStorage 上下文管理 |
| `@opentelemetry/api` | 1.9.1 | 1,001,329 B | 588 | — | 类型与全局 API(`SpanContext`/`TraceFlags`/`SpanKind`/`SpanStatusCode`/`Attributes`…) |
| `@opentelemetry/core` | 2.11.0 | 583,971 B | 327 | `semantic-conventions` `^1.29.0` | `ExportResult(Code)`、`InstrumentationScope`、env 读取 helper、`suppressTracing` 等 |
| `@opentelemetry/resources` | 2.11.0 | 440,928 B | 291 | `core` | `Resource`;导出 `resourceFromAttributes` / `defaultResource` / `emptyResource` |
| `@opentelemetry/semantic-conventions` | 1.43.0 | 12,006,437 B | 129 | — | 语义约定常量(含 incubating 面) |

事实点:

- **版本线**:exporter 系列走在 `0.x`(0.222.0),SDK 走在 `2.x`(2.11.0),`api` 1.9.1——OTel JS 的常规「实验包 0.x / 稳定包 major」双线。
- **精确钉版本**:exporter 的 `dependencies` 是**精确版本**(`"@opentelemetry/sdk-trace": "2.11.0"`,非 caret),0.x 包的 minor 可破型。
- **`api` 是 peer**:三个包均声明 `peerDependencies: {"@opentelemetry/api": "^1.3.0"}`(`sdk-trace` 为 `>=1.3.0 <1.10.0`);npm 7+ 自动安装 peer,故实测树里含 `api@1.9.1`。
- **信号级错配**:`otlp-transformer` 同时实现 traces / metrics / logs 三种编码器,因此硬依赖 `sdk-metrics`、`sdk-logs`、`api-logs`——即使只做 trace。
- **无 protobuf 运行期依赖**:protobuf 编码由包内自带 writer 完成(`build/src/common/protobuf/protobuf-writer.*`、`protobuf-reader.*`、`protobuf-size-estimator.*`);实测 A/B/C 三组 `package-lock.json` 均无 `protobufjs`。
- 源码一处旁证:`src/platform/node/OTLPTraceExporter` 里 `kind` 的编码是 `span.kind == null ? 0 : span.kind + 1`(API 没有 unset 值,OTLP 有)。

来源:各包 registry 元数据 `https://registry.npmjs.org/<pkg>/<version>`;`sdk-trace-base` 的 `package.json` `main`/`dependencies` 与 `build/src/index-shim.d.ts`([unpkg](https://unpkg.com/@opentelemetry/sdk-trace-base@2.11.0/build/src/index-shim.d.ts));实测脚本见文末。

## 2. 安装树实测(最小集合)

方法:空目录 `npm install --package-lock-only`(npm 11.13.0,自动装 peer),解析 `package-lock.json` 的 `node_modules/*`,再对每个 `name@version` 取 registry `dist.unpackedSize` 求和(沿 #6 口径)。三组:

| 组 | 安装内容 | 包数 | unpacked 合计 |
| --- | --- | --- | --- |
| A | `@opentelemetry/exporter-trace-otlp-proto@0.222.0` | **11** | **19,252,639 B(18.36 MiB)** |
| B | `@opentelemetry/otlp-transformer@0.222.0` | **9** | **18,547,539 B(17.69 MiB)** |
| C | `@opentelemetry/exporter-trace-otlp-http@0.222.0` | **11** | **19,254,726 B(18.36 MiB)** |

A 组逐包(降序):

| 包 | unpacked |
| --- | --- |
| `semantic-conventions@1.43.0` | 12,006,437 |
| `sdk-metrics@2.11.0` | 1,846,700 |
| `otlp-transformer@0.222.0` | 1,053,804 |
| `api@1.9.1` | 1,001,329 |
| `sdk-trace@2.11.0` | 797,835 |
| `sdk-logs@0.222.0` | 679,622 |
| `otlp-exporter-base@0.222.0` | 647,539 |
| `core@2.11.0` | 583,971 |
| `resources@2.11.0` | 440,928 |
| `api-logs@0.222.0` | 136,913 |
| `exporter-trace-otlp-proto@0.222.0` | 57,561 |

读数要点:

- A − B = **705,100 B** = `otlp-exporter-base`(647,539)+ `exporter`(57,561)——**exporter 层本身只占 0.67 MiB**,剩下 17.69 MiB 是「transformer + SDK + 常量」的公共底。
- `semantic-conventions` 占 A 组 **62.4%**;它是 `core`/`resources`/`sdk-trace` 的 `^1.29.0` 依赖,只要走官方序列化路径就无法从安装树里移除(**运行期是否 import 是另一回事**)。
- `sdk-metrics`(1.85 MB)+ `sdk-logs`(0.68 MB)+ `api-logs`(0.14 MB)≈ **2.67 MB(14%)** 只因 transformer 同时编码 metrics/logs 而被拉入;trace-only 消费者不 import 它们,但**安装成本照付**(`otlp-transformer` 的 `package.json` 没有 `exports` map,`main` 入口 re-export 三种信号,trim 只能靠 bundler 的 tree-shaking,深度路径导入属内部用法)。
- 三组树里都**没有** `sdk-trace-base`、`sdk-trace-node`、`context-async-hooks`——不装就不用付。

## 3. `SpanExporter` 接口与处理器面

接口 d.ts(2.11.0,`@opentelemetry/sdk-trace`):

```ts
export interface SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  /** Immediately export all spans */
  forceFlush?(): Promise<void>;   // 可选
}
```

[unpkg: sdk-trace/build/src/export/SpanExporter.d.ts](https://unpkg.com/@opentelemetry/sdk-trace@2.11.0/build/src/export/SpanExporter.d.ts)

- `ExportResult` / `ExportResultCode` 在 `@opentelemetry/core`:`{ code: ExportResultCode, error?: Error }`,`SUCCESS = 0`、`FAILED = 1`([unpkg](https://unpkg.com/@opentelemetry/core@2.11.0/build/src/ExportResult.d.ts))。
- 官方自带两个最小实现可作形状参照:`ConsoleSpanExporter`、`InMemorySpanExporter`(后者含 `reset()` / `getFinishedSpans()`)。

`OTLPExporterBase<Internal>`(exporter 的父类,`otlp-exporter-base`)实现 `export(items, cb)` / `forceFlush(): Promise<void>` / `shutdown(): Promise<void>`,构造入参是一个 delegate([unpkg](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/OTLPExporterBase.d.ts))。`OTLPTraceExporter extends OTLPExporterBase<ReadableSpan[]> implements SpanExporter`,只多一个 `constructor(config?: OTLPExporterNodeConfigBase)`([proto 版源码](https://unpkg.com/@opentelemetry/exporter-trace-otlp-proto@0.222.0/build/src/platform/node/OTLPTraceExporter.js)):

- proto 版:serializer = `ProtobufTraceSerializer`,必需头 `Content-Type: application/x-protobuf`。
- http 版:serializer = `JsonTraceSerializer`,必需头 `Content-Type: application/json`。

`SpanProcessor` 接口(`@opentelemetry/sdk-trace`):`forceFlush(): Promise<void>`、`onStart(span, parentContext)`、`onEnding?(span)`(experimental)、`onEnd(span: ReadableSpan)`、`shutdown(): Promise<void>`([unpkg](https://unpkg.com/@opentelemetry/sdk-trace@2.11.0/build/src/SpanProcessor.d.ts))。

两个内置处理器的行为(源码):

| | `SimpleSpanProcessor` | `BatchSpanProcessor`(node) |
| --- | --- | --- |
| 导出节奏 | 每个 ended span 立即单独导出 | 缓冲 + 定时/满批导出 |
| 配置 | `{ exporter, selfObsMeterProvider? }` | `maxExportBatchSize`(默认 512)/ `scheduledDelayMillis`(默认 5000ms)/ `exportTimeoutMillis`(默认 30000ms)/ `maxQueueSize`(默认 2048,满则丢) |
| 采样过滤 | `onEnd` 里查 `span.spanContext().traceFlags & TraceFlags.SAMPLED`,未采样直接 return | 同 |
| flush/shutdown | 跟踪在途导出,`forceFlush` 一并 await;`shutdown` 幂等 | 队列排空 + 定时器清理;队列满丢 span(记 `droppedSpansCount`) |
| `onStart` | no-op | no-op |

源码:[SimpleSpanProcessor.js](https://unpkg.com/@opentelemetry/sdk-trace@2.11.0/build/src/export/SimpleSpanProcessor.js)、[BatchSpanProcessorBase.js](https://unpkg.com/@opentelemetry/sdk-trace@2.11.0/build/src/export/BatchSpanProcessorBase.js)。

exporter 侧的传输/重试事实(`otlp-exporter-base`):

- `ExportResponse = {status:'success'} | {status:'failure',error} | {status:'retryable',retryInMillis?,error?}`;`createRetryingTransport` 对 `retryable` 重试([unpkg](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/retrying-transport.d.ts))。
- 可重试 HTTP 状态 = **429 / 502 / 503 / 504**;`Retry-After` 会被解析成 `retryInMillis`([is-export-retryable.js](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/is-export-retryable.js))。
- 默认:`timeoutMillis 10000`、`concurrencyLimit 30`、`compression 'none'`([shared-configuration.js](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/configuration/shared-configuration.js));默认 URL `http://localhost:4318/` + 信号资源路径(`v1/traces`)。

## 4. 三事件(started/updated/ended)→ OTel span 生命周期:桥接面

### 4.1 `ReadableSpan` 字段清单(2.11.0)

```ts
interface ReadableSpan {
  name: string; kind: SpanKind;
  spanContext: () => SpanContext;          // 函数,不是字段
  parentSpanContext?: SpanContext;
  startTime: HrTime; endTime: HrTime;      // [UNIX 秒, 纳秒]
  status: SpanStatus;                       // { code: SpanStatusCode, message? }
  attributes: Attributes;
  links: Link[]; events: TimedEvent[];
  duration: HrTime; ended: boolean;
  resource: Resource;
  instrumentationScope: InstrumentationScope;   // { name, version?, schemaUrl? }
  droppedAttributesCount: number; droppedEventsCount: number; droppedLinksCount: number;
}
```

[unpkg: ReadableSpan.d.ts](https://unpkg.com/@opentelemetry/sdk-trace@2.11.0/build/src/export/ReadableSpan.d.ts) · `SpanContext` = `{ traceId(32-hex), spanId(16-hex), traceFlags, isRemote?, traceState? }`([api](https://unpkg.com/@opentelemetry/api@1.9.1/build/src/trace/span_context.d.ts)),`TraceFlags.SAMPLED = 1`。

`HrTime` 的精确定义与换算([api/common/Time.d.ts](https://unpkg.com/@opentelemetry/api@1.9.1/build/src/common/Time.d.ts) 原文注释):`HrTime[0]` = UNIX 秒(截断),`HrTime[1]` = 纳秒余数,例:`1609504210150ms → [1609504210, 150000000]`。框架侧 `Date`(毫秒)换算即 `[Math.trunc(ms/1000), (ms/1000 - trunc) * 1e9]`。(api 另有 `TimeInput = HrTime | number | Date` 类型,但 `ReadableSpan.startTime` 声明为 `HrTime`,transformer 的 `encodeHrTime` 按 HrTime 编码。)

### 4.2 transformer 实际读取的字段(桥接的真实需求面)

`otlp-transformer@0.222.0` 的 `sdkSpanToOtlpSpan(span, encoder)` 只读这些:**`spanContext()`(traceId/spanId/traceFlags/traceState)、`parentSpanContext?.spanId`、`parentSpanContext?.isRemote`、`name`、`kind`、`startTime`、`endTime`、`attributes`、`droppedAttributesCount`、`events[].{name,time,attributes,droppedAttributesCount}`、`droppedEventsCount`、`status.{code,message}`、`links[].{context,attributes,droppedAttributesCount}`、`droppedLinksCount`、`resource`、`instrumentationScope.{name,version,schemaUrl}`**(分组键 = `resource` 对象引用 + `name@version:schemaUrl` 字符串)[unpkg: trace/internal.js](https://unpkg.com/@opentelemetry/otlp-transformer@0.222.0/build/src/trace/internal.js)。

**`duration` 与 `ended` 不被读取**(实测:不带这两个字段的对象也能序列化成功)。

### 4.3 实测(可复现,Node v26.2.0)

用一个普通对象(非 `new Span()`)串起全链路,全部成功:

| 试验 | 结果 |
| --- | --- |
| `ProtobufTraceSerializer.serializeRequest([obj])` | 287 B(含 resource + scope + 1 event + parent);最小对象(无 `duration`/`ended`/`dropped*`/`parent`)82 B |
| `JsonTraceSerializer.serializeRequest([obj])` | 932 B;明文 JSON:`resourceSpans[].scopeSpans[].spans[]`,id 为 hex 字符串 |
| `new OTLPTraceExporter({url,headers}).export([obj], cb)` | 线上请求 `POST /v1/traces`、`content-type: application/x-protobuf`、`user-agent: OTel-OTLP-Exporter-JavaScript/0.222.0`、自定义头原样带上、body 287 B |
| `new SimpleSpanProcessor({exporter}).onEnd(obj)` + `forceFlush()` | 正常导出 |
| `new BatchSpanProcessor({exporter,…}).onEnd(obj)` + `forceFlush()` + `shutdown()` | 正常导出 |
| 未采样对象(`TraceFlags.NONE`)过 `SimpleSpanProcessor` | 被跳过、不导出 |

硬约束与细节:

- **`resource` 必填**:置 `undefined` 时 `ProtobufTraceSerializer.serializeRequest` 抛 `Cannot read properties of undefined (reading 'attributes')`。可用 `resourceFromAttributes({...})` / `defaultResource()` / `emptyResource()` 构造(均从 `@opentelemetry/resources` 公开导出)。env 侧:`defaultResource()` 只写 `service.name`(取自 `defaultServiceName()`)+ `telemetry.sdk.*`,**不读 env**;读 `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` 的是 `envDetector`(与 `detectResources` 一并公开导出)([ResourceImpl.js](https://unpkg.com/@opentelemetry/resources@2.11.0/build/src/ResourceImpl.js) / [EnvDetector.js](https://unpkg.com/@opentelemetry/resources@2.11.0/build/src/detectors/EnvDetector.js))。
- **`spanContext` 必须是函数**:transformer 调 `span.spanContext()`(不是字段访问)。
- **`attributes` 只收原语**:`AttributeValue = string | number | boolean | Array<null|undefined|同前>`,**对象非法**(null/undefined 值语义未定义)([api Attributes.d.ts](https://unpkg.com/@opentelemetry/api@1.9.1/build/src/common/Attributes.d.ts))。
- **没有 `new Span()` 这条路**:`@opentelemetry/sdk-trace` 的公共入口对 `Span` 是 `export type`(类型专用);要生成 OTel span 对象,官方路径是 `TracerProvider.getTracer(...)`,本项目「三事件自有模型」则走**结构对象**即可。
- **枚举对齐**:`SpanKind` = INTERNAL 0 / SERVER 1 / CLIENT 2 / PRODUCER 3 / CONSUMER 4,编码时 `kind+1`;`SpanStatusCode` = UNSET 0 / OK 1 / ERROR 2,API 与 proto 枚举值共享。
- **编码差异**(同一对象两种 serializer):protobuf 把 id 走 `hexToBinary`、时间走 fixed64;JSON 把 id 留 hex 字符串、时间留字符串、`Uint8Array` 转 base64([common/utils.js](https://unpkg.com/@opentelemetry/otlp-transformer@0.222.0/build/src/common/utils.js))。

### 4.4 与框架侧 span 模型的对照(事实面)

框架侧 span 模型见 `docs/architecture/observability.md`(span 形状 + 三事件 + `ObservabilityExporter.export(event)`):`id`(16-hex)/`traceId`(32-hex)/`parentSpanId`/`name`/`type`/`startTime`/`endTime`(`Date`)/`input`/`output`/`attributes`(按 type 收窄的判别联合)/`metadata`/`error`/`isEvent`。

| 框架侧 | OTLP / `ReadableSpan` 侧 | 事实 |
| --- | --- | --- |
| `traceId` 32-hex / `id` 16-hex / `parentSpanId` | `spanContext().traceId` / `.spanId` / `parentSpanContext` | 形态一致(OTel 要求小写 hex) |
| `startTime`/`endTime`(`Date`) | `startTime`/`endTime`(`HrTime = [秒,纳秒]`) | 需转换;`isEvent`(无 `endTime`)在 OTel 无对应无时长 span(事件是 `SpanEvent`,需挂到某个 span) |
| `name` / `type`(7 个常量 + 开放 string) | `name` | OTLP 侧无「type」字段;type → 语义属性/命名模板属映射面 |
| `attributes`(判别联合) | `attributes`(`AttributeValue`) | 值域更窄:对象值须序列化 |
| `metadata`(开放袋) | 无对应字段 | 归属性或丢弃,属映射面 |
| `input` / `output`(一等公民) | 无对应字段 | 归属性或事件,属映射面(#7 已记录这是与 OTel 官方「Opt-In」立场的差异) |
| `error` | `status.{code,message}` / `SpanEvent` | `SpanStatusCode.ERROR = 2` |
| `isEvent` | 无 | 见上 |
| — | `kind` | OTLP 必需;框架侧无此概念 → 需按 7 类 span 制定映射 |
| — | `resource` / `instrumentationScope` | OTLP 必需;`resource` 为分组键(按对象引用) |
| — | `events` / `links` / `dropped*` | 需要时提供;`dropped*` 供计数,缺失即 0 语义 |

## 5. 配置与环境变量面

`OTLPExporterConfigBase`(legacy base):`headers?: Record<string,string> | (() => Promise<Record<string,string>>)`、`url?`、`concurrencyLimit?`(默认 30)、`timeoutMillis?`(默认 10000)、`selfObsMeterProvider?`(experimental)。`OTLPExporterNodeConfigBase` 追加 `keepAlive?`(默认 true)、`compression?`(`CompressionAlgorithm.NONE|GZIP`)、`httpAgentOptions?`、`userAgent?`([unpkg](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/configuration/legacy-node-configuration.d.ts))。

env 读取(node-http 路径,`getNodeHttpConfigurationFromEnvironment`)实际读:

- **Endpoint**:`OTEL_EXPORTER_OTLP_ENDPOINT`(通用,**会拼上信号资源路径** `v1/traces`;无尾斜杠自动补)与 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`(信号特化,**原样使用**,仅规范化根路径)。优先级:特化 > 通用 > 默认 `http://localhost:4318/v1/traces`。
- **Headers**:`OTEL_EXPORTER_OTLP_HEADERS` 与 `OTEL_EXPORTER_OTLP_TRACES_HEADERS`——**两者合并**(不是覆盖),特化优先;解析用 `parseKeyPairsIntoRecord`(逗号分隔 key=value)。
- **Timeout**:`OTEL_EXPORTER_OTLP_TIMEOUT` / `..._TRACES_TIMEOUT`(毫秒,必须 > 0,否则告警忽略)。
- **Compression**:`OTEL_EXPORTER_OTLP_COMPRESSION` / `..._TRACES_COMPRESSION`,只接受 `none` / `gzip`。
- **TLS**:`OTEL_EXPORTER_OTLP_CERTIFICATE` / `..._CLIENT_CERTIFICATE` / `..._CLIENT_KEY`(+ `..._TRACES_*`),读文件路径;node 侧 `keepAlive: true`。
- **不读 `OTEL_EXPORTER_OTLP_PROTOCOL`**:全仓(本次抽出的 10 个包)无该字符串;协议=选包(proto vs http),不是 env 开关。

来源:[otlp-node-http-env-configuration.js](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/configuration/otlp-node-http-env-configuration.js) · [shared-env-configuration.js](https://unpkg.com/@opentelemetry/otlp-exporter-base@0.222.0/build/src/configuration/shared-env-configuration.js);规范侧 [OTLP exporter spec](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) 与 [SDK env vars](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)。

可复用的拼接件(公开导出面):

- `@opentelemetry/core`(stable)导出 `getStringFromEnv` / `getBooleanFromEnv` / `getNumberFromEnv` / `getStringListFromEnv` / `parseKeyPairsIntoRecord`——env 解析可复用([core index.d.ts](https://unpkg.com/@opentelemetry/core@2.11.0/build/src/index.d.ts))。
- `@opentelemetry/otlp-exporter-base` 导出 `OTLPExporterBase`、`mergeOtlpSharedConfigurationWithDefaults`、`getSharedConfigurationDefaults`、`CompressionAlgorithm`、`createOtlpNetworkExportDelegate`、类型 `OTLPExporterNodeConfigBase`、`OTLPExporterError` 等。
- `@opentelemetry/otlp-exporter-base/node-http` 子路径导出:`httpAgentFactoryFromOptions`、`createOtlpHttpExportDelegate`、`createOtlpHttpExporterMetrics`、`getSharedConfigurationFromEnvironment`、`convertLegacyHttpOptions`。
- 注意两处**弃用/未导出**事实:`convertLegacyHttpOptions` 标 `@deprecated this will be removed in 2.0`(exporter 包当前正式走的就是这条);`getNodeHttpConfigurationDefaults` / `mergeOtlpNodeHttpConfigurationWithDefaults` **未从子路径导出**(只用得到,只能深度导入内部路径)。

## 6. `gen_ai.*` 常量复核(沿 #7)

- `@opentelemetry/semantic-conventions@1.43.0` 的 `exports` = `.` 与 `./incubating` 两个入口;`gen_ai` 常量只出现在 `experimental_attributes` / `experimental_events` / `experimental_metrics`,即 **`./incubating` 入口**([package.json](https://unpkg.com/@opentelemetry/semantic-conventions@1.43.0/package.json))。
- 该包 unpacked **12,006,437 B**(见 §2)——即使只作类型/常量用,安装成本也在。
- 结论事实:发 `gen_ai.*` 属性名不依赖该包(字符串写死即可);引它只为常量名与类型;semconv 稳定性沿 #7 的钉子(全部 Development)。

## 7. 事实层的取舍面(不构成决策)

只列各拼装路线在**本次实测口径**下的成本与控制面差异:

| 路线 | 安装树 | 自担部分 | 免担部分 |
| --- | --- | --- | --- |
| ① 官方 exporter 包(proto 或 http) | 11 包 / 18.36 MiB | 映射层(框架 span → `ReadableSpan` 形状);构造与生命周期调用 | 序列化、传输、重试(429/502/503/504 + `Retry-After`)、并发(30)、超时、env 配置读取、批处理(可选接 `BatchSpanProcessor`) |
| ② 仅 `otlp-transformer` 直发 | 9 包 / 17.69 MiB | 上述 + **HTTP 传输与重试** | 序列化(protobuf/JSON)、`resource`/scope 分组 |
| ③ 自实现序列化(仅用 `@opentelemetry/api` 类型) | 1 包(api 1.0 MB)+ 自写编码 | 序列化(protobuf wire 或 OTLP JSON)+ 传输/重试/**语义约定常量** | — |

补充事实(与取舍相关,均为实测):

- **exporter 层只值 0.67 MiB**(§2 A−B),而 `semantic-conventions`(12.0 MiB)与 `sdk-metrics`+`sdk-logs`+`api-logs`(2.67 MiB)无论走 ① 还是 ② 都在树里;路线 ③ 是唯一能把安装体积压到 MB 级的。
- 无论哪条路线,`@opentelemetry/api`(1.0 MiB)都是 peer/必需类型底。
- `sdk-trace`(0.80 MiB)在 ①/② 里都在树里,因此**用它的 `BatchSpanProcessor`/`SimpleSpanProcessor`/`BasicTracerProvider` 不额外增加包**;但在 ① 里它们是可选项(直接调 `exporter.export` 也成立,见 §4.3)。
- 浏览器/edge 面:`otlp-exporter-base` 另有 `./browser-http` 子路径与 `transport/fetch-transport`;node 走 `node:http`。
- 版本跟随面:exporter 是 `0.x` 且对 SDK 用**精确版本**;SDK 2.x 与 `api` 1.9.x 的兼容区间写在 peer(`>=1.3.0 <1.10.0`)。

## 附:来源与实测方法

包与版本(npm registry):

- `https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-proto/0.222.0`
- `https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-http/0.222.0`
- `https://registry.npmjs.org/@opentelemetry/otlp-exporter-base/0.222.0`
- `https://registry.npmjs.org/@opentelemetry/otlp-transformer/0.222.0`
- `https://registry.npmjs.org/@opentelemetry/sdk-trace/2.11.0`
- `https://registry.npmjs.org/@opentelemetry/sdk-trace-base/2.11.0`
- `https://registry.npmjs.org/@opentelemetry/api/1.9.1`
- `https://registry.npmjs.org/@opentelemetry/core/2.11.0`
- `https://registry.npmjs.org/@opentelemetry/resources/2.11.0`
- `https://registry.npmjs.org/@opentelemetry/semantic-conventions/1.43.0`

版本钉源码(unpkg deep links,`@0.222.0` / `@2.11.0` / `@1.43.0`):

- `@opentelemetry/sdk-trace@2.11.0/build/src/export/{ReadableSpan,SpanExporter,SimpleSpanProcessor,BatchSpanProcessorBase,InMemorySpanExporter}.d.ts`
- `@opentelemetry/sdk-trace@2.11.0/build/src/{SpanProcessor,TracerProvider}.d.ts`
- `@opentelemetry/sdk-trace-base@2.11.0/build/src/index-shim.d.ts`
- `@opentelemetry/otlp-exporter-base@0.222.0/build/src/{OTLPExporterBase.d.ts,configuration/*,is-export-retryable.js,retrying-transport.d.ts}`
- `@opentelemetry/otlp-transformer@0.222.0/build/src/trace/{internal.js,protobuf/trace.d.ts}` 与 `common/{hex-to-binary.js,utils.js,protobuf/*}`
- `@opentelemetry/exporter-trace-otlp-proto@0.222.0/build/src/platform/node/OTLPTraceExporter.js`(`http` 版同路径)
- `@opentelemetry/api@1.9.1/build/src/{trace/span_context.d.ts,trace/trace_flags.d.ts,trace/status.d.ts,trace/span_kind.d.ts,common/Attributes.d.ts}`
- `@opentelemetry/core@2.11.0/build/src/{ExportResult.d.ts,index.d.ts}`
- `@opentelemetry/resources@2.11.0/build/src/index.d.ts`
- `@opentelemetry/semantic-conventions@1.43.0/package.json`

规范与文档:

- [OTLP exporter 配置与默认值](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)
- [SDK 环境变量](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)

实测方法(2026-09-30):

1. 体积:三组空目录各自 `npm install --package-lock-only --no-audit --no-fund <pkgs>`;解析 lock 的 `node_modules/*`;逐个 `https://registry.npmjs.org/<name>/<version>` 取 `dist.unpackedSize` 求和。单包数字亦由 `npm view <pkg>@latest version dependencies dist.unpackedSize dist.fileCount` 交叉核对。
2. 源码:对 10 个包执行 `npm pack --silent`,解包后读 `build/src/**/*.d.ts` 与 `build/src/**/*.js`(版本钉的构建产物即发布物)。
3. 端到端:在 `measure/a`(真实安装 proto exporter)运行 smoke 脚本——构造普通 `ReadableSpan` 形状对象 → 经 `ProtobufTraceSerializer` / `JsonTraceSerializer` 序列化 → 本地 `node:http` server 收 `OTLPTraceExporter.export()` / `SimpleSpanProcessor.onEnd()` / `BatchSpanProcessor.onEnd()` 三路请求;另测最小字段对象、`resource: undefined`、未采样对象三种边界。
