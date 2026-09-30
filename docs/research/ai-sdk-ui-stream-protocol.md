# 调研:AI SDK UI stream 与 useChat 协议现状(互操作包目标面)

调研日期:2026-09-30 · 分支:`research/ai-sdk-ui-stream-protocol` · 目标:为「决策:AI SDK 互操作包」(#77,地图 #65)钉住目标协议现状——当前 `ai` 包世代、UI message stream 帧词汇、`useChat` 消费契约、恢复/持久化流现状,以及与 Balsa chunk 协议的映射缺口。**本文只呈现事实,不做决策。**

> 事实基线:`ai@7.0.123`(npm registry `latest`,2026-09-30 抓取);AI SDK 侧源码引用一律钉该版本(`https://cdn.jsdelivr.net/npm/ai@7.0.123/src/...`,GitHub 路径 `vercel/ai@packages/ai/src/...`);文档引用 `ai-sdk.dev` 当前站点(v5 归档页单独标注)。Balsa 侧钉 `main` 当前工作树(`packages/core/src/...`)。

## TL;DR

- **当前世代 = AI SDK 7**:`ai@7.0.123`(engines `node >=22`;直接依赖 3 个:`@ai-sdk/gateway@4.0.101` / `@ai-sdk/provider@4.0.20` / `@ai-sdk/provider-utils@5.0.52`;peer `zod ^3.25.76 || ^4.1.8`;unpacked ≈ 7.35 MiB(7,706,694 B)、685 文件,Apache-2.0)。仓库 #6 调研实测的 `ai@7.0.118` 同代。
- 两套流协议:**text stream**(纯文本,`TextStreamChatTransport` / `toTextStream` / `createTextStreamResponse`)与 **UI message stream**(SSE、默认、`useChat` 消费;`toUIMessageStream` + `createUIMessageStreamResponse`)。
- **线级版本标记 = HTTP 头 `x-vercel-ai-ui-message-stream: v1`**(7.0.123 仍为 `v1`)。SDK major 之间变的是**帧词汇表**而非线级版本:5.0 用 UI message stream 取代旧 data stream(`StreamData` 类移除);v7 词汇表比 v5 明显扩张(新增 `tool-approval-*`、`tool-input-error`、`tool-output-error`/`tool-output-denied`、`reset-step`、`message-metadata`、`reasoning-file`、`custom` 等)。
- **帧封装**:`data: {json}\n\n` 一帧一 JSON,流尾固定 `data: [DONE]\n\n`;可选 SSE keep-alive 注释(`: stream-open\n\n` / `: keep-alive\n\n`);响应头固定 5 个(content-type / cache-control / connection / `x-vercel-ai-ui-message-stream` / `x-accel-buffering`)。
- **`useChat` 消费契约(POST)**:body `{ ...body, id, messages, trigger, messageId }` + `signal`;客户端用 `uiMessageChunkSchema`(zod)**逐帧解析,非法帧抛错**;非 2xx → `APICallError`、空 body → `EmptyResponseBodyError`。客户端**不校验**协议头(源码里该常量只在响应助手与测试中出现)。
- **恢复流(POST + GET 双端点)**:`useChat({ resume: true })` 挂载时 `GET {api}/{chatId}/stream`;**204 = 无活跃流**;服务端自建存储 + Redis + `resumable-stream` 包(官方提供的工具停在「自动重连 + `consumeSseStream` 取流」);该模式下客户端 abort 视为**断连**,显式停止需另建 stop 端点;官方明言 resumable 与 abort 不兼容。
- **与 Balsa 四类 chunk 的映射缺口**(§9):推理/参数增量、source/file/custom/data 帧无法从 Balsa 流重建;文本块 id、消息 id、step 边界、usage 帧都要转换器**合成**;`'suspended'` 在 UI stream 无对应帧;v7 新出的 `tool-approval-*` 与 Balsa durable 审批闸是两套机制。

## 1. 协议双轨与线级版本标记

官方「Stream Protocols」页把出口分两套([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)):

| 协议 | 形状 | 后端产出 | 前端启用 | 能力 |
| --- | --- | --- | --- | --- |
| text stream | 纯文本 chunk 直接拼接 | `toTextStream` + `createTextStreamResponse`(老版本文档写作 `result.toTextStreamResponse()`) | `TextStreamChatTransport`(`useCompletion` 用 `streamProtocol: 'text'`) | 只有文本;要工具调用等必须上 data stream |
| UI message stream | SSE + JSON 帧 | `toUIMessageStream` + `createUIMessageStreamResponse`(老版本 `result.toUIMessageStreamResponse()`) | 默认(`DefaultChatTransport` / 不传 transport) | 全量帧词汇(§2) |

线级版本标记:自定义后端产 UI message stream 时官方要求设置 `x-vercel-ai-ui-message-stream: v1`([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol))。7.0.123 里它落在一个常量上,连同 5 个响应头([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/ui-message-stream-headers.ts)):

```ts
export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no', // disable nginx buffering
};
```

- 该常量由 `createUIMessageStreamResponse` / `pipeUIMessageStreamToResponse` 作为默认头写入([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/create-ui-message-stream-response.ts)、[src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/pipe-ui-message-stream-to-response.ts)),调用方 headers 可覆盖。
- **客户端侧不读该头**:`DefaultChatTransport` 只做 SSE→JSON 解析([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui/default-chat-transport.ts));以 `gh search code`(2026-09-30)扫 `vercel/ai` 仓库,该字符串只出现在 headers 常量、文档与两个响应助手测试里。即它是一个**交付面/互操作标记**,不是客户端的协议判定依据。
- 术语注意:页面上旧的标题仍写「Data Stream Protocol」,正文与代码用 `x-vercel-ai-ui-message-stream`(UI message stream)。v5 迁移指南记载 `StreamData` 类被移除、自定义数据改走 UI message stream([docs](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0))。

## 2. UI message stream 帧词汇(7.0.123 全表)

权威来源是 `uiMessageChunkSchema`(zod,运行期校验 + 类型)[src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/ui-message-chunks.ts);官方文档按帧讲解([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol))。下表载荷以 schema 为准(`*` = 必填)。

**消息生命周期**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `start` | `messageId?`, `messageMetadata?` | 新消息起点;`messageId` **可选**(见 §4 注 id 注入) |
| `finish` | `finishReason?`, `messageMetadata?` | 消息完成;`finishReason ∈ stop \| length \| content-filter \| tool-calls \| error \| other`(可选) |
| `message-metadata` | `messageMetadata*` | 独立元数据帧(可多次) |
| `abort` | `reason?` | 流被中止 |

**step(一轮后端 LLM 调用)**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `start-step` | — | step 开始 |
| `finish-step` | — | step 完成;多 step 拼接必需([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)) |
| `reset-step` | — | 抹掉最近一个 `start-step` 之后的帧;重试时作废半成品用 |

**文本 / 推理 / 文件 / 来源 / 自定义**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `text-start` / `text-delta` / `text-end` | `id*`(`delta*` 仅 delta 帧), `providerMetadata?` | 文本块 start/delta/end,**id 是块身份** |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | `id*`(`delta*` 见 delta) | 推理块,同上模式 |
| `reasoning-file` | `url*`, `mediaType*`, `providerMetadata?` | 推理过程产生的文件 |
| `source-url` | `sourceId*`, `url*`, `title?` | 外部来源引用 |
| `source-document` | `sourceId*`, `mediaType*`, `title*`, `filename?` | 文档来源 |
| `file` | `url*`, `mediaType*` | 文件引用 |
| `custom` | `kind*`(形如 `{provider}.{provider-type}`), `providerMetadata?` | provider 专有内容 |
| `data-{name}` | `data*`, `id?`, `transient?` | 自定义结构化数据;同 `id` 重复写即**客户端重协调(reconcile)**;**`transient: true` 时只经 `onData` 回调交付、不写入消息历史**([docs](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)) |

**工具输入**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `tool-input-start` | `toolCallId*`, `toolName*` + `providerExecuted?/providerMetadata?/toolMetadata?/dynamic?/title?` | 输入开始流式 |
| `tool-input-delta` | `toolCallId*`, `inputTextDelta*` | 输入增量(**字符串片段**,非解析后 JSON) |
| `tool-input-available` | `toolCallId*`, `toolName*`, `input*` + 同上层可选项 | 输入完成、可执行 |
| `tool-input-error` | `toolCallId*`, `toolName*`, `input*`, `errorText*` + 同上层可选项 | 输入非法(如解析失败) |

**工具审批(v7 面)**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `tool-approval-request` | `approvalId*`, `toolCallId*`, `approvalDescriptor?`, `inputSchemaInput?`, `reason?`, `isAutomatic?`, `signature?` | 需要用户审批;省略 `isAutomatic` 即期待显式应答([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)) |
| `tool-approval-response` | `approvalId*`, `approved*`, `reason?`, `providerExecuted?`, `providerMetadata?` | 审批决定 |

**工具输出**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `tool-output-available` | `toolCallId*`, `output*` + `providerExecuted?/providerMetadata?/toolMetadata?/dynamic?/preliminary?` | 结果;`preliminary` 表示非终值 |
| `tool-output-error` | `toolCallId*`, `errorText*` + 同上层可选 | 执行错误 |
| `tool-output-denied` | `toolCallId*` | 审批流走完后「被拒」的输出 |

**错误**

| type | 载荷 | 说明 |
| --- | --- | --- |
| `error` | `errorText*` | 附到消息上的错误;服务端默认会把错误细节**脱敏**成 `"An error occurred."`(§4) |

**流终止**:`data: [DONE]\n\n`([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol);源码见 §3)。

## 3. SSE 封装、终止与响应头

7.0.123 源码:

- **一帧一行 JSON**:`JsonToSseTransformStream` 每个对象写 `data: ${JSON.stringify(part)}\n\n`,`flush` 时写 `data: [DONE]\n\n`([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/json-to-sse-transform-stream.ts))。
- **keep-alive(可选)**:`createSseStreamWithKeepAlive({ keepAliveMs })` 打开时立刻写 `: stream-open\n\n`,空闲超过间隔写 `: keep-alive\n\n`(SSE 注释帧);`keepAliveMs` 必须是 `(0, 2147483647]` 内的有限数,否则抛错([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/create-sse-stream-with-keep-alive.ts))。
- **响应助手**:`createUIMessageStreamResponse({ stream, status?, statusText?, headers?, keepAliveMs?, consumeSseStream? })` 返回 `Response`;chunks → `JsonToSseTransformStream` → keep-alive → `TextEncoderStream`;`consumeSseStream` 存在时 `tee()` 出第二条 SSE 流交给回调(注释明言「not await, do not block the response」)([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/create-ui-message-stream-response.ts))。
- **Node 原生响应**:`pipeUIMessageStreamToResponse({ response: ServerResponse, ... })` 同一套封装写 Node `ServerResponse`(返回 `Promise<void>`)——非 Web `Request/Response` 宿主的落点([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/pipe-ui-message-stream-to-response.ts))。
- 文档侧参数说明与源码一致([docs](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream-response))。

## 4. 服务端产出路径(canonical)

### 4.1 `createUIMessageStream`(composer / writer)

参数:`execute({ writer })`、`onError`(默认返回 `"An error occurred."`,即**默认脱敏**)、`originalMessages`、`onEnd`(或 `generateId`)([docs](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream))。writer 面:`write(part)` / `merge(stream)` / `setOutcome(outcome)` / `onError`。`setOutcome` 只声明操作级结局(`completed | failed | aborted | unknown`),**不写帧、不关流**;首个声明保留,致命失败覆盖之;单个 `error` 帧本身不改变 outcome。

### 4.2 `toUIMessageStream`(模型流 → UI 帧)

默认值与选项([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/to-ui-message-stream.ts)):

- `sendReasoning = true`,`sendSources = false`,`sendStart = true`,`sendFinish = true`;
- `onError` 默认 `() => 'An error occurred.'`(脱敏;provider 执行的工具错误**绕过**它);
- `messageMetadata?: ({ part }) => METADATA | undefined` ——在 `start` / `finish` 帧上携带,其余 part 另发独立 `message-metadata` 帧;usage 的官方推荐挂法即在 `finish` part 上取 `part.totalUsage.totalTokens` 写进 metadata([docs](https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata));
- `originalMessages` / `generateMessageId`(决定响应消息 id)、`onEnd`/`onFinish`、`onStepEnd`。

### 4.3 StreamTextPart → UIMessageChunk(canonical 映射)

`toUIMessageChunk` 是官方「模型流 part → UI 帧」的对照实现([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/to-ui-message-chunk.ts)),要点:

| StreamTextPart | UI 帧 | 备注 |
| --- | --- | --- |
| `text-start/delta/end` | 同名帧 | 透传 `id` / `providerMetadata` |
| `reasoning-*` | 同名帧 | `sendReasoning=false` 时整段丢弃 |
| `source` | `source-url` / `source-document` | `sendSources=false`(默认)时丢弃 |
| `file` / `reasoning-file` | 同名帧 | URL 用 `data:{mediaType};base64,...` 内联 |
| `custom` | `custom` | `kind` 透传 |
| `tool-input-start` | `tool-input-start` | `dynamic` 由 tools 表推断 |
| `tool-input-delta` | `tool-input-delta` | 原文片段 |
| `tool-call`(合法) | `tool-input-available` | input 为**已解析** JSON |
| `tool-call`(`invalid`) | `tool-input-error` | `errorText = onError(part.error)` |
| `tool-result` | `tool-output-available` | `output === undefined` 时写 `null`(JSON 序列化不保留 undefined) |
| `tool-error` | `tool-output-error` | provider 执行的错误绕过 `onError` |
| `tool-output-denied` | `tool-output-denied` | |
| `tool-approval-request/response` | 同名帧 | 请求帧可带 `inputSchemaInput`(schema 原样输入与解析后输入不一致时) |
| `error` | `error` | 经 `onError` 脱敏 |
| `start-step` / `finish-step` | 同名帧 | |
| `start` | `start` | `sendStart=false` 则不写;带 `messageId` / `messageMetadata` |
| `finish` | `finish` | `finishReason` + `messageMetadata`;`sendFinish=false` 则不写 |
| `abort` | `abort` | 原样透传 |
| `tool-input-end` / `raw` | — | 显式丢弃 |

### 4.4 `handleUIMessageStreamFinish`(收尾/持续化语义)

([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui-message-stream/handle-ui-message-stream-finish.ts)):若 `start` 帧没有 `messageId` 而调用方给了(或 `originalMessages` 末条是 assistant),则**注入 `messageId`**;跟踪 `abort` 帧;`onStepEnd` 在 `finish-step` 帧时触发;`onEnd` 收到 `{ messages, isContinuation, isAborted, isCancelled?, outcome, responseMessage, finishReason }`,其中 outcome 为 `completed|failed|aborted|unknown`,`isCancelled` 表「消费方在声明 outcome 前取消(如客户端断连)」。

`readUIMessageStream` 提供反向能力:chunk 流 → `UIMessage` 的 `AsyncIterableStream`(服务端/终端 UI/测试用)([docs](https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams))。

## 5. `useChat` 消费契约

### 5.1 请求/响应(HTTP transport 源码事实)

`HttpChatTransport`(`DefaultChatTransport` 基类)[src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui/http-chat-transport.ts):

- **发送**:`POST api`,`content-type: application/json`,body 默认 `{ ...body, id, messages, trigger, messageId }`(`trigger ∈ 'submit-message' | 'regenerate-message'`),`credentials` 可配,`signal: abortSignal`;`prepareSendMessagesRequest` 可整体改写 body/headers/api。
- 非 2xx → `createUIApiCallError`(即 `APICallError`);成功但无 body → `EmptyResponseBodyError`([src 同上](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui/http-chat-transport.ts);错误类清单见 [docs](https://ai-sdk.dev/docs/ai-sdk-ui/error-handling))。
- **解析**:`DefaultChatTransport.processResponseStream` = `parseJsonEventStream({ stream, schema: uiMessageChunkSchema })`,**逐帧 zod 校验,失败即抛**(`UIMessageStreamError` 面)[src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui/default-chat-transport.ts)。
- **恢复**:`reconnectToStream({ chatId, ... })` 发 `GET`,默认 URL = `{api}/{encodeURIComponent(chatId)}/stream`(chatId 为 `.` / `..` 时抛 `InvalidArgumentError`);**204 → 返回 null(无活跃流)**;非 2xx → `APICallError`;请求无 `Last-Event-ID` 之类游标头,重放/游标由服务端自行表达([src](https://cdn.jsdelivr.net/npm/ai@7.0.123/src/ui/http-chat-transport.ts))。

### 5.2 选项与返回值(参考页,浓缩)

([docs](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) · [transport 页](https://ai-sdk.dev/docs/ai-sdk-ui/transport))

- 入口:`useChat({ id?, messages?, transport?, resume?, generateId?, dataPartSchemas?, onToolCall?, sendAutomaticallyWhen?, onFinish?, onError?, onData?, throttle? })`;默认 `DefaultChatTransport` → `/api/chat`、`credentials: 'same-origin'`。
- 返回:`messages`(`UIMessage[]`)、`status: 'submitted' | 'streaming' | 'ready' | 'error'`、`error`、`sendMessage`、`regenerate`、`stop()`、`resumeStream()`、`clearError`、`addToolOutput`(客户端工具结果)、`addToolApprovalResponse({ id, approved, reason? })`、`setMessages`。
- `onFinish` 的旗标:`isAbort`(客户端中止)、`isDisconnect`(服务端/网络断)、`isError`、`finishReason`(`stop|length|content-filter|tool-calls|error|other`,未提供则 undefined)。
- 工具调用往返:客户端侧不执行的动作走 `onToolCall` + `addToolOutput`;`sendAutomaticallyWhen`(常配 `lastAssistantMessageIsCompleteWithToolCalls`)决定是否自动续发。
- `throttle` 仅 React/Vue:节流的是**UI 刷新**,不延迟流处理与回调。

### 5.3 其他 transport

- `TextStreamChatTransport`:走 text stream。
- `DirectChatTransport`:进程内直连 agent(`stream()`),**不支持恢复**(`reconnectToStream()` 恒 null)([docs](https://ai-sdk.dev/docs/ai-sdk-ui/transport))。
- `WorkflowChatTransport`(`@ai-sdk/workflow/client`):自动重连的实现参考——「检测缺少 `finish` 帧的断流,GET `{api}/{runId}/stream` 续读」,`initialStartIndex` / `maxConsecutiveErrors` 可配,带 `onChatSendMessage` / `onChatEnd` 回调([docs](https://ai-sdk.dev/docs/ai-sdk-ui/transport))。

## 6. `UIMessage` 形状与 part 状态机

`UIMessage<METADATA, DATA_PARTS, TOOLS> = { id: string; role: 'system'|'user'|'assistant'; metadata?: METADATA; parts: UIMessagePart[] }`([docs](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message))。

part 类型与状态:

- `text`:{ type:'text', text, state?: 'streaming' | 'done' }
- `reasoning`:{ type:'reasoning', id?, text, state?, providerMetadata? }
- 工具 part:type 为 `` `tool-${NAME}` ``(动态工具另有 `DynamicToolUIPart`),带 `toolCallId` 与状态机:
  `input-streaming` → `input-available` →(`approval-requested` → `approval-responded`)→ `output-available` | `output-error`;
  `approval` 字段含 `{ id, approved?, descriptor?, requestReason?, reason?, isAutomatic?, signature? }`;`isToolOutputErrorUIPart` 类型守卫供渲染用。
- `custom`:{ type:'custom', kind:`{provider}.{provider-type}`, providerMetadata? }
- `source-url` / `source-document` / `file` / `data-{name}`(带 `id?`)
- `step-start`:`{ type:'step-start' }` —— 消息里的 step 边界 part。

## 7. 恢复/持久化流现状

官方「Chatbot Resume Streams」页([docs](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)):

- 客户端:`useChat({ resume: true })` 挂载时自动 `GET /api/chat/{id}/stream`;必须随请求带 chat id(`prepareSendMessagesRequest`);`prepareReconnectToStreamRequest` 可自定义恢复 URL/头/credentials。
- 服务端(官方给的构建物):**存储**(记住每个 chat 的活跃流,`activeStreamId`)+ **Redis** + **`resumable-stream` 包**(发布/订阅机制)+ 两个端点:POST 创建流、GET 恢复流(无活跃流时 **204 No Content**);用 `consumeSseStream` 回调把出站 SSE 流 tee 一份交给 `resumable-stream` 落库;`onEnd` 里清 `activeStreamId`(Next.js 场景配 `after()`)。
- **abort 语义**:该模式下客户端 `stop()` / 关页 / 刷新只关掉当前 HTTP 连接,算**断连**而非取消;要真正停止需自建 **stop 端点**(持久化半成品 + 取消生产方 + 清活跃流记录),并注意「stop 后不自动重连」。官方 troubleshooting 页明言:「Stream resumption is not compatible with abort functionality」,并把 `req.signal` 透传给模型会导致重连预期的后台生成被取消([docs](https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams))。
- 官方列出的服务端要点:流有 TTL、多客户端可同连、无活跃流返 204、竞态时先清新流的 `activeStreamId`。

## 8. 协议版本化方式(v5 → v7 词汇差异)

- **线级版本号只有 `v1`**:v5 归档页与当前页都写 `x-vercel-ai-ui-message-stream: v1`([v5 docs](https://ai-sdk.dev/v5/docs/ai-sdk-ui/stream-protocol))——协议本身未升版,变的是 SDK 侧的帧集合与语义。
- **v5 → v7 词汇差异**(逐帧对照 v5 页面与 7.0.123 schema):v5 已有 start/text/reasoning/source/file/data-*/error/tool-input-start/delta/available/tool-output-available/start-step/finish-step/finish/[DONE],**没有**:`tool-input-error`、`tool-approval-request`/`tool-approval-response`、`tool-output-error`、`tool-output-denied`、`reset-step`、`message-metadata`、`reasoning-file`、`custom`。7.0.123 的 schema 与文档均含这些(v7 源码见 §2;`tool-approval-*` 的文档示例见当前 stream-protocol 页)。
- **5.0 的分水岭**:`StreamData` 类移除、自定义数据改走 UI message stream、消息结构换代(带 data 迁移指南)([docs](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0))。
- 客户端是**白名单解析**(zod union,`looseObject` 容忍额外字段但拒绝未知 `type` 与缺必填)——服务端多发的帧会直接抛错;因此「跟随哪一代词汇」是硬约束,不是装饰。

## 9. 与 Balsa chunk 协议的对账

### 9.1 Balsa 侧事实(源码钉点)

`packages/core/src/model/chunks.ts`:

```ts
type Chunk =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage };   // FinishReason 含 'suspended'
```

- `tool-call.input` 是**已解析**的 JSON;**非法 JSON 保留原始字符串**(`parseToolInput` 的 catch 分支,`packages/core/src/model/normalize.ts:111-121`),随后由工具边界按输入校验失败回喂模型(`docs/architecture/tools.md`)。
- provider 的 `content-filter` / `other` 统一坍缩为 `'stop'`(`packages/core/src/model/normalize.ts:126-134`)——Balsa 线上流不会出现 `content-filter`。
- **每 step 一个 `finish` chunk,且先于框架执行的 tool-result**:loop.ts 的原注释「The step boundary comes before the framework-executed results: consumers see the model's finish, then the results that answer the step's calls (results belong to that step).」(`packages/core/src/agent/loop.ts:378-382`);随后才 `yield` 该 step 的 `tool-result`(同文件 429-462)。
- **挂起 run 的线上流不带 `'suspended'` finish**:审批闸挂起时「The chunk stream above already carried the model's own finish for this step; the run-level reason reports what the run did.」(`loop.ts:403-425`)——`'suspended'` 只出现在**输出对象终值**(`agent.ts:236-246` 的 `finishReason`),不出现为 chunk。
- Balsa agent **没有** step 边界帧、消息 id、文本块 id、usage 帧、推理/参数增量帧(全表见 9.3)。
- 输出对象:chunks 流 + `text` / `object` / `toolCalls` / `toolResults` / `usage` / `finishReason` / `steps`(`packages/core/src/agent/agent.ts:82-84, 236-246`)。

### 9.2 映射对账表(逐 Balsa chunk → UI 帧)

| Balsa chunk | UI 帧 | 转换器要做的 | 缺口 |
| --- | --- | --- | --- |
| `text-delta { textDelta }` | `text-start` + `text-delta` + `text-end` | **合成块 id**(Balsa 无 id);决定块切分(连续 delta 一段?按 step?) | Balsa 流不含块边界信息 |
| `tool-call { toolCallId, toolName, input }` | `tool-input-start`(可选)+ `tool-input-available` | 无 `tool-input-delta` 可发(输入已解析);`toolName`/`toolCallId` 直通 | 无参数增量;非法 input 时 Balsa 的 `input` 是字符串,`tool-input-available.input*` 允许任意 JSON,但 canonical 语义该走 `tool-input-error` |
| `tool-result { toolCallId, toolName, output, isError }` | `tool-output-available`(`isError=false`) | `isError=true` 时二选一(设计裁决):`tool-output-error`(UI 显错)或 `tool-output-available`(语义仍「模型收到的结果」) | 无 `isError` 对应位;`tool-output-denied` 无来源(除非把审批拒绝单独标出) |
| `finish { finishReason, usage }` | `finish-step` + `finish`(+ `message-metadata`) | `finishReason` 映射:`stop→stop` / `length→length` / `tool-calls→tool-calls` / `error→error`;**`'suspended'` 无对应值**(只能 `other` 或另设语义);usage 无帧位,走 `messageMetadata`(官方推荐 `part.totalUsage`) | `'suspended'` 帧语义;usage 帧不存在;每 step 一 finish 但要配 `start-step`(Balsa 无开始帧) |

### 9.3 无法从 Balsa 四类 chunk 重建的 UI 帧(缺口清单)

- `reasoning-*`(推理)、`reasoning-file`:Balsa 协议没有任何推理增量(模型层规范明确裁掉)。
- `tool-input-delta`:输入已解析,Balsa 不留原文增量(除非改模型归一化层,越出互操作包)。
- `tool-approval-request` / `tool-approval-response`:v7 的审批往返;与 Balsa 的 durable 审批闸(`createDurableAgent`,`'suspended'` + `resume`)是**两套机制**——前者是单次 HTTP 流内的用户应答,后者是 run 级挂起/恢复。
- `source-url` / `source-document` / `file` / `custom`:Balsa 工具输出可能与来源相关,但 chunk 协议无专门帧。
- `data-*`:Balsa 无用户 data 通道;`transient` 概念无来源。
- `reset-step`:Balsa 的 fallback/retry 不在 chunk 流表达(Balsa 有 workflow `retries` 与模型 fallback 链,粒度不同)。
- `message-metadata` / `start.messageId` / `text-start.id`:全部要**转换器合成**(消息 id 可由 route 生成;Balsa 有 `runId`,可作候选——事实:chunk 协议里不带 runId)。
- `usage`:UI 协议**没有** usage 帧;`useChat` 只给到 `onFinish.finishReason`,usage 要经 `messageMetadata` 约定(§4.2)。
- step 边界:UI 协议用 `start-step`/`finish-step` 表达多 step;**Balsa 线上流无 step 开始帧**(且每 step 的 `finish` 先于该 step 的 `tool-result`,顺序与 canonical 的 `tool-input-available → tool-output-available → finish-step` 不同)。

### 9.4 事实边界(留给设计票裁决,本票不裁)

1. 目标协议版本钉法:`ai@7.0.123` 的**词汇表** + 线级 `v1` 头;升代跟随纪律怎么写(与 ADR-0004「模型契约升代升 major」的对齐方式)。
2. 是否发 `tool-input-start` / 是否发 `start-step`/`finish-step`(Balsa 信息可推但不完全);`finish` 先于 `tool-result` 的顺序要不要在转换器里重排。
3. `isError=true` 与非法 input 的落帧选择(§9.2)。
4. `'suspended'` 的对外表达(不映射、映射 `other`、或与 `tool-approval-*` 合流)。
5. 恢复流:`resume: true` 模式需要应用侧存储 + Redis + `resumable-stream`;Balsa 侧的对应物(thread/resource 身份、signals、快照)如何对接;并且该模式与 abort 互斥——Balsa 的 `AbortSignal` 传播如何取舍。
6. 反向互操作(`withMastra` 类)在本协议面没有对应物(AI SDK 侧是 `DirectChatTransport` 等,不在本包职责内)。

## 附:来源

AI SDK 官方文档(2026-09-30 抓取):

- Stream Protocols:https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- Transport:https://ai-sdk.dev/docs/ai-sdk-ui/transport
- useChat:https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat
- UIMessage:https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message
- createUIMessageStream:https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream
- createUIMessageStreamResponse:https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream-response
- Reading UIMessage Streams:https://ai-sdk.dev/docs/ai-sdk-ui/reading-ui-message-streams
- Message Metadata:https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata
- Streaming Custom Data(data parts / `transient` / 同 id 重协调):https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data
- Error Handling:https://ai-sdk.dev/docs/ai-sdk-ui/error-handling
- Chatbot Resume Streams:https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- Abort breaks resumable streams:https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams
- 迁移 5.0:https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0
- v5 归档 stream-protocol:https://ai-sdk.dev/v5/docs/ai-sdk-ui/stream-protocol

AI SDK 源码(钉 `ai@7.0.123`,jsdelivr):

- `src/ui-message-stream/ui-message-chunks.ts`(帧 schema 全表)
- `src/ui-message-stream/ui-message-stream-headers.ts`(响应头常量)
- `src/ui-message-stream/json-to-sse-transform-stream.ts`(SSE 封装与 `[DONE]`)
- `src/ui-message-stream/create-sse-stream-with-keep-alive.ts`(keep-alive 注释帧)
- `src/ui-message-stream/create-ui-message-stream-response.ts`
- `src/ui-message-stream/pipe-ui-message-stream-to-response.ts`(Node ServerResponse)
- `src/ui-message-stream/to-ui-message-stream.ts`(默认值/outcome/metadata)
- `src/ui-message-stream/to-ui-message-chunk.ts`(canonical 映射表)
- `src/ui-message-stream/handle-ui-message-stream-finish.ts`(id 注入/onEnd/outcome)
- `src/ui/default-chat-transport.ts`(逐帧 zod 解析)
- `src/ui/http-chat-transport.ts`(POST body / GET 恢复 / 204 / signal)

npm:`https://registry.npmjs.org/ai/latest`(`ai@7.0.123`:engines、deps、peer、体积,2026-09-30)。

Balsa 仓库内(2026-09-30 `main`):

- `packages/core/src/model/chunks.ts`(四类 chunk、`FinishReason`/`Usage`;`:18` / `:21` / `:58`)
- `packages/core/src/model/normalize.ts`(`parseToolInput` 原始字符串兜底 `:111-121`;`content-filter`/`other` → `'stop'` `:126-134`)
- `packages/core/src/agent/loop.ts`(step 边界先 finish 后 tool-result;挂起路径注释)
- `packages/core/src/agent/agent.ts`(输出对象终值)
- `docs/architecture/model.md`(chunk 协议与互操作包职责)
