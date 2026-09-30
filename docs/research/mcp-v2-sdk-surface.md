# 调研:MCP v2 SDK 执行面(server / client 设计所需一手 API)

> Issue: #68 · 日期: 2026-09-30 · 分支: `research/mcp-v2-sdk-surface` · 性质: 事实收集,不做决策。
> 事实基线:sdk 仓 `modelcontextprotocol/typescript-sdk` main 本地克隆(含 `docs/` 一手文档与 `packages/*/src` 源码)· npm registry 实测 2026-09-30 · MCP 规范 2026-07-28。包数/体积沿 #6 实测(server 2.1.0 / client 2.1.0),本票不重抓,只补版本漂移与 API 面。

## TL;DR

- **版本线**:v2 稳定线 = `@modelcontextprotocol/server@2.2.0` + `@modelcontextprotocol/client@2.2.0`(2026-09-28 同日发布,实现 **2026-07-28 规范**;v2.0.0 于 2026-07-27 与规范同发)。配套 `@modelcontextprotocol/core@2.2.0`、`@modelcontextprotocol/node@2.1.0`;v1 `@modelcontextprotocol/sdk@1.31.0` 仍在维护(2026-09-28,2025-11-25 规范线,至少 6 个月 bug/安全修复窗口)。
- **zod v4 是直接运行时依赖,不是 peer**:`core` / `server` / `client` 都声明 `zod: ^4.2.0`(core 用 zod 定义全部协议 schema)。工具 schema 面接受任意 **Standard Schema 且能产出 JSON Schema**(Zod v4、ArkType 直用;Valibot 需 `@valibot/to-json-schema` 包装),类型名 `StandardSchemaWithJSON`。**「Standard Schema 原生」成立,但安装树仍带 zod**。
- **两个协议代(era)**:`modern` = `2026-07-28`(无 `initialize`、无 session、每请求 `_meta` envelope);`legacy` = `2024-10-07`…`2025-11-25`(`initialize` 握手 + `Mcp-Session-Id`)。同一入口默认两代都服务;服务端工厂能读到当前请求的 era。
- **服务端两个入口**:HTTP = `createMcpHandler(factory, opts)` → `{ fetch, close, notify, bus }`,工厂**每请求**建一个新实例(默认无状态、无 session);stdio = `serveStdio(factory, opts)` → `{ close }`(每连接一个实例)。裸 `McpServer` + `server.connect(transport)` 仍是低层/自布线用法(legacy sessionful、自定义 transport)。
- **工具注册**:`server.registerTool(name, config, handler)`;handler 签名 `(args, ctx)`,**无 `inputSchema` 时是 `(ctx)`**;输入校验在 handler 之前由 schema 库执行,`tools/list` 广告由 schema 派生的 **2020-12** JSON Schema。
- **错误二分**:协议错误(JSON-RPC error)vs 工具错误(`isError: true` 结果)。`tools/call` 路径**未知工具 / 工具被禁用 → 协议错误**;**输入校验失败 / execute 抛错 / 输出校验失败 → 一律 `{ content:[{type:'text',text:message}], isError:true }`**;唯一例外是 `UrlElicitationRequiredError`(-32042)透传为协议错误。
- **handler 上下文**:请求面在 `ctx.mcpReq`(`signal` / `_meta` / `notify` / `log` / `id` / `envelope` / `requestState()` / `elicitInput` / `requestSampling`),HTTP 面在 `ctx.http`(`authInfo` / `req` / close 流句柄),另有 `ctx.sessionId`(legacy)。
- **客户端**:`new Client({name,version})` + transport + `connect()`;`StreamableHTTPClientTransport` / `StdioClientTransport`(`client/stdio`,自拥子进程) / `SSEClientTransport` / `InMemoryTransport.createLinkedPair()`;`close()` 拒绝在途请求(`CONNECTION_CLOSED`);stdio 关闭顺序 = 关 stdin → `SIGTERM` → `SIGKILL`。请求头透传走 transport 的 `requestInit`(transport 自管头优先)。
- **规范侧工具名规则与 Balsa 现写法不一致**:规范 SHOULD 为 **1–128 字符、字符集 `A-Z a-z 0-9 _ - .`(含点)**;`docs/architecture/tools.md` 现写 `[a-zA-Z0-9_-]{1,64}`。SDK 侧**未发现**工具名字符集校验(只有重复名报错与 `x-mcp-header` 警告)。

---

## 1. 版本与包面(npm registry 实测 2026-09-30)

| 包 | 版本 | 发布日 | dependencies | peerDependencies | 包体(unpacked) |
| --- | --- | --- | --- | --- | --- |
| `@modelcontextprotocol/server` | **2.2.0** | 2026-09-28 | `zod@^4.2.0`、`@modelcontextprotocol/core@2.2.0`(精确) | — | 6.14 MiB(#6 @2.1.0) |
| `@modelcontextprotocol/client` | **2.2.0** | 2026-09-28 | `zod@^4.2.0`、`jose@^6.1.3`、`cross-spawn@^7.0.5`、`eventsource@^3.0.2`、`pkce-challenge@^5.0.0`、`eventsource-parser@^3.0.0`、`core@2.2.0` | — | 6.44 MiB(#6 @2.1.0) |
| `@modelcontextprotocol/core` | 2.2.0 | 2026-09-28 | `zod@^4.2.0` | — | 1.32 MiB |
| `@modelcontextprotocol/node` | 2.1.0 | 2026-09-23 | `@hono/node-server@^1.19.9` | `hono@^4.11.4`(optional)、`server@^2.1.0` | 0.15 MiB |
| `@modelcontextprotocol/hono` | 2.0.1 | — | 无 | `hono@^4.11.4`、`server@^2.1.0` | 0.06 MiB |
| `@modelcontextprotocol/express` | 2.0.1 | — | `cors@^2.8.5` | `express`(4 或 5)、`server@^2.1.0` | 0.10 MiB |
| `@modelcontextprotocol/fastify` | 2.0.0 | — | 无 | `fastify@^5.2.0`、`server@^2.0.0` | 0.06 MiB |
| `@modelcontextprotocol/server-legacy` | 2.2.0 | 2026-09-28 | `zod`、`cors`、`raw-body`、`content-type`、`pkce-challenge`、`express-rate-limit`、`core@2.2.0` | `express`(4 或 5,optional) | 2.13 MiB |
| `@modelcontextprotocol/sdk`(v1) | 1.31.0 | 2026-09-28 | 17 个(含 `express@^5.2.1`、`hono@^4.11.4`、`ajv` 等) | `zod`、`@cfworker/json-schema`(optional) | 4.14 MiB(#6 @1.30.1) |

- 全部 MIT、`type: module`(双 ESM/CJS 导出)、engines `node >=20`(Balsa 基线是 22.12,无冲突)。
- 子路径导出:`server` = `.` / `./stdio` / `./validators/ajv` / `./validators/cf-worker` / `./_shims`;`client` 同形。
- **版本策略**(`VERSIONING.md`):semver 2.0;`core` / `client` / `server` / `server-legacy` / `codemod` 是 **fixed group**(同版本同发);middleware 包(`node`/`express`/`hono`/`fastify`)随 server peer range 或自身变更独立升版,框架一律 **peer**。
- **依赖策略**(`DEPENDENCY_POLICY.md`):运行期依赖保守更新、caret 范围;自家包 `workspace:*` 发布为**精确钉死**(所以 `server` 精确依赖 `core@2.2.0`);框架集成不打包框架副本。
- `core/internal` 入口**不在兼容承诺内**(可任意版变更);`core-internal` 包为私有。

## 2. 两个协议代(era):设计必须选边

一手来源:`docs/protocol-versions.md`(该页自称「era 差异的唯一副本」)。

| 维度 | `legacy`(2024-10-07 … 2025-11-25) | `modern`(2026-07-28) |
| --- | --- | --- |
| 连接开场 | `initialize` 握手 | `server/discover` 广告(无 initialize) |
| 服务端 HTTP 入口 | `*StreamableHTTPServerTransport` 手布线 | `createMcpHandler`(默认也服务 legacy) |
| 服务端 stdio 入口 | `server.connect(new StdioServerTransport())` | `serveStdio(factory)`(默认也服务 legacy) |
| 客户端身份 | `getClientCapabilities()` / `getClientVersion()`(会话级) | `ctx.mcpReq.envelope`(每请求) |
| 服务端→客户端请求 | `ctx.mcpReq.elicitInput` / `requestSampling` | handler 里 `return inputRequired(...)`(MRTR) |
| 变更通知 | 非主动 `list_changed` / `resources/updated` | `subscriptions/listen` 流 |
| 客户端取消(HTTP) | POST `notifications/cancelled` | 关闭该请求的 SSE 响应流 |
| `ctx.mcpReq.log()` 级别过滤 | 会话级 `logging/setLevel` | 每请求 `_meta.logLevel`(**缺省 = 不发日志**) |
| 会话 | `Mcp-Session-Id`、一 transport 一会话 | **无 protocol session**;状态用显式 handle(见 §8) |
| 存活检查 | `client.ping()` | 未定义 |

- 取消**两条路都最终反映为** `ctx.mcpReq.signal` 中止(`docs/servers/logging-progress-cancellation.md`);被取消的请求 SDK 不回响应、丢弃 handler 的返回。
- deprecation ≠ era:`sampling`、`roots`、`logging` 在 2026-07-28 起 deprecated(SEP-2577),但规范内保留至少 12 个月;各 era 的承载 API 不同(见上表)。

## 3. 服务端入口、工厂模型与生命周期

一手来源:`docs/serving/http.md`、`docs/serving/stdio.md`、`docs/serving/legacy-clients.md`、`packages/server/src/server/mcp.ts`。

### 3.1 HTTP:`createMcpHandler`

```ts
const handler = createMcpHandler(factory, { legacy?, responseMode?, bus? });
// → { fetch: (Request) => Promise<Response>, close(), notify, bus }
```

- **工厂每请求执行一次**,拿到 `{ era, authInfo, requestInfo }`;handler 请求之间不持有状态(默认无状态)。
- `fetch(request, { authInfo?, parsedBody? })`:`authInfo` 是**透传**(SDK 不读头、不验 token),handler 内经 `ctx.http.authInfo` 读取。
- `responseMode`:`'json' | 'sse'`(默认:有 mid-call 通知则升级 SSE,否则单 JSON 体);`subscriptions/listen` 恒为 SSE。
- `handler.close()`:中止在途交换、关闭其 per-request 实例;`close()` 后 `fetch` 抛错。
- `bus`(ServerEventBus):跨节点 `subscriptions/listen` 分发用。
- legacy 姿态:`legacy: 'stateless'`(**默认**,每个 legacy 请求新实例、无 session;legacy 的 `GET`/`DELETE` 返回 `405`)或 `'reject'`(只服务 modern;legacy `initialize` 得 HTTP 400 + `-32022` unsupported-protocol-version,`data.supported` 列版本)。

### 3.2 stdio:`serveStdio`

```ts
const handle = serveStdio(factory, { legacy? }); // → StdioServerHandle { close() }
```

- 工厂**每连接**执行一次;`handle.close()` 拆掉被 pin 的实例与 transport。
- legacy 姿态:`'serve'`(**默认**,每连接按开场钉定 era)或 `'reject'`(拒 2025 开场、连接保持等待 modern 开场)。
- stdin EOF → transport 自行关闭、连接拆除;**在途请求被中止且永不回答**(stdout 是 JSON-RPC 通道,日志必须走 stderr);`server.server.onclose` 可挂清理(如释放 keep-alive 句柄)。
- MCP Inspector:`npx @modelcontextprotocol/inspector node ./build/server.js`。

### 3.3 低层:`McpServer` + `connect(transport)`

- `new McpServer({ name, version }, { capabilities?, jsonSchemaValidator? })`;`server.server` 暴露低层 `Server`(clé `server.server.onclose`);`await server.connect(transport)`;`await server.close()`。
- `connect` 后 server 接管 transport(替换既有回调),不得多方共用同一 transport 实例。

### 3.4 中间件/框架接线(server 侧)

| 运行时 | 接线 |
| --- | --- |
| web-standard(Workers/Deno/Bun) | `export default handler`(`{ fetch }` 对象) |
| 裸 `node:http` | `toNodeHandler(handler)` + `localhostHostValidation()` / `localhostOriginValidation()`(来自 `@modelcontextprotocol/node`) |
| Express | `createMcpExpressApp()`(自带 `express.json()` + Host/Origin 校验)+ `toNodeHandler(handler)`;token 中间件 `requireBearerAuth` → `req.auth` → `ctx.http.authInfo` |
| Hono | `createMcpHonoApp()` + `app.all('/mcp', c => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }))` |
| Fastify | `createMcpFastifyApp()` |
| Node 上的 2025 legacy sessionful | 手布线 `NodeStreamableHTTPServerTransport`(见 §8),或 `isLegacyRequest` + `legacyStatelessFallback` 路由分叉 |
| 旧 HTTP+SSE 服务端 | v2 **不再提供** SSE 服务端;冻结副本 `@modelcontextprotocol/server-legacy/sse`(deprecated,v3 计划移除) |

- DNS rebinding 防护:localhost 绑定时 `Host`/`Origin` 默认校验(非 localhost 值 → 403);绑 `0.0.0.0` 时需显式 `allowedHosts`;无 `Origin` 头恒放行。
- 响应流形状:单 JSON 体;仅当 handler 在结果前发出通知(progress/logging)才升级 SSE。

## 4. 工具注册、handler 契约与 schema

一手来源:`docs/servers/tools.md`、`docs/advanced/schema-libraries.md`、`packages/server/src/server/mcp.ts`、`packages/core/src/schemas.ts`。

### 4.1 注册面

```ts
server.registerTool(
  name,
  {
    description,               // 给模型看
    title?,                    // 展示名
    inputSchema?,              // StandardSchemaWithJSON(见 4.2)
    outputSchema?,             // 同上;存在则校验 structuredContent
    annotations?,              // readOnlyHint / destructiveHint / idempotentHint …(行为提示,不改执行)
    icons?, execution?, scopeChallenge?, _meta?,
  },
  async (args, ctx) => ({ content: [...], structuredContent?, isError? })
);
```

- **无 `inputSchema` 时 handler 签名退化为 `(ctx)`**(源码 `createToolExecutor`:无 schema 只收 ctx)。
- 重复名 → 抛 `Error("Tool X is already registered")`(源码)。**未发现字符集校验**;`x-mcp-header` 非法声明只 `console.warn`(见 §7)。
- 注册返回 `RegisteredTool` 句柄,带 **动态管理面**:`enable()` / `disable()` / `update({ name?, title?, description?, paramsSchema?, outputSchema?, annotations?, icons?, scopeChallenge?, _meta?, callback?, enabled? })` / `remove()`;`update` 的改名**无重复名保护**(源码注释明示)。
- `tools/list` 的 `listChanged: true` 能力 + `handler.notify.toolsChanged()`(变更通知);`tools/list` 集合规范要求不得随连接或其它请求副作用变化、SHOULD 稳定排序(规范 §7)。

### 4.2 schema 与校验时机

- 类型:`StandardSchemaWithJSON`(Standard Schema + 能出 JSON Schema)。Zod v4、ArkType 直用;Valibot 需 `toStandardJsonSchema` 包装;纯 JSON Schema 用 `fromJsonSchema(document, validator?)`(`@modelcontextprotocol/server` 导出)。
- 一个 schema 派生三件事:发给模型的 JSON Schema、handler 之前的入参校验、handler 参数类型推断;**校验在 handler 之前**。
- `registerTool` 的 **raw-shape 重载已 deprecated**(`inputSchema: { name: z.string() }`,内部 `z.object()` 自动包装)。
- JSON Schema 口径:**2020-12**(`tools/list` 广告里带 `$schema: https://json-schema.org/draft/2020-12/schema`);SDK 内 `standardSchemaToJsonSchema(input, 'input')` 转换;无参工具发 `{ type:'object', properties:{} }`(规范推荐 `{ type:'object', additionalProperties:false }`,SDK 未采用)。
- **JSON Schema 验证器**只用于两处:`fromJsonSchema` 的入参、elicitation 表单响应;Node 默认 Ajv、workerd/浏览器用 `@cfworker/json-schema`,可用 `server/validators/ajv` 或 `/validators/cf-worker` 子路径钉死。
- `x-mcp-header`(SEP-2243):生成 `Mcp-Param-{name}` HTTP 头;服务端列工具时扫描并 warn,客户端 **MUST** 剔除非法声明工具(源码 `scanXMcpHeaderDeclarations`,core-internal/server/client 均有)。

### 4.3 记录形状(客户端看到)

`tools/list` 项 = `{ name, title?, description, icons?, inputSchema(JSON Schema), outputSchema?(JSON Schema), annotations? }`(规范 + `core/src/schemas.ts`)。

## 5. handler 上下文(`ctx`)

一手来源:`docs/servers/logging-progress-cancellation.md`、`packages/server/src/server/server.ts`(`buildContext`)。

| 成员 | 事实 |
| --- | --- |
| `ctx.mcpReq.signal` | `AbortSignal`;客户取消、连接关闭时中止;`signal.reason` 携带原因;可直接转交 `fetch` 等 I/O |
| `ctx.mcpReq.id` | 该请求的 JSON-RPC id(源码把它用作 `relatedRequestId`) |
| `ctx.mcpReq._meta` | 每请求 meta(如 `progressToken`) |
| `ctx.mcpReq.notify(payload)` | 发任意通知(如 `notifications/progress`);progress 必须单调递增;无 `progressToken` 时不发 |
| `ctx.mcpReq.envelope` | **modern 专属**每请求信封(客户端能力 / `logLevel` / 版本等) |
| `ctx.mcpReq.requestState<T>()` | MRTR 请求态的类型化读取(配套 `requestStateCodec` 的 `bind`/`mint`/`verify` 缝) |
| `ctx.mcpReq.log(level, data, logger?)` | deprecated(SEP-2577);modern 缺 `_meta.logLevel` 即**完全静默**;需声明 `logging` 能力 |
| `ctx.mcpReq.elicitInput` / `requestSampling` | deprecated(SEP-2577);legacy 路径;modern 用 `inputRequired(...)` |
| `ctx.http` | HTTP 面:`authInfo`(透传)、`req`(web Request,可读头)、关流句柄 |
| `ctx.sessionId` | legacy 会话 id(transport/头来源) |

- 进度、日志、取消都**逐请求**;`notify` 走 in-flight 交换,per-request 托管(任一 era)下没有会话级流可送。

## 6. 错误语义与结构化输出

一手来源:`docs/servers/errors.md`、`packages/server/src/server/mcp.ts`(tools/call handler,精度到分支)。

**`tools/call` 的实际路径**(源码):

1. 工具不存在 → `ProtocolError(InvalidParams, "Tool X not found")`;
2. 工具被 disable → `ProtocolError(InvalidParams, "Tool X disabled")`;
3. try 内:`validateToolInput`(Standard Schema 失败 → `ProtocolError(InvalidParams, "Input validation error: …")`)→ `executeToolHandler` → `validateToolOutput` → 结果投影;
4. catch:**除 `UrlElicitationRequiredError`(-32042)透传为协议错误外,一律 `createToolError(message)` = `{ content:[{ type:'text', text:message }], isError:true }`**。

即:**输入校验失败 / execute 抛错 / 输出校验失败三种都归一为 `isError: true` 工具结果(模型可见、可自纠)**;未知/禁用工具是协议错误(模型不可见)。

**输出校验**细节:有 `outputSchema` 且结果非 `isError`、非 inputRequired 时,`structuredContent === undefined` → 报错「有 output schema 但无 structured content」;`structuredContent` 不合 schema → 报错;两者都经同一 catch 变成 `isError`。structuredContent 可为任意 JSON 值(SEP-2106,判存在用 `=== undefined`)。

**协议错误码表**(SDK 完整词汇):`-32700` ParseError、`-32600` InvalidRequest、`-32601` MethodNotFound、`-32602` InvalidParams(也是 `resources/read` miss)、`-32603` InternalError、`-32002` ResourceNotFound(仅接收容忍,SDK 从不发)、`-32021` MissingRequiredClientCapability、`-32022` UnsupportedProtocolVersion、`-32042` UrlElicitationRequired(-32021/`-32022` 为 2026-07-28 新增)。`ProtocolError` / `ProtocolErrorCode` 取代 v1 的 `McpError` / `ErrorCode`;类型化子类:`ResourceNotFoundError`、`UrlElicitationRequiredError`、`UnsupportedProtocolVersionError`、`MissingRequiredClientCapabilityError`。

**资源/提示/补全回调无 `isError` 通道**:抛 `ProtocolError`(非 ProtocolError → `-32603`)。

## 7. 客户端

一手来源:`docs/clients/connect.md`、`calling.md`、`middleware.md`、`protocol-versions.md`、`packages/client/src/client/streamableHttp.ts`。

### 7.1 连接与生命周期

```ts
const client = new Client({ name, version }, { versionNegotiation?, listMaxPages?, supportedProtocolVersions? });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit?,   // 每请求头（如 bearer）；transport 自管头优先
  authProvider?,  // AuthProvider | OAuthClientProvider（401 自动走 OAuth 流）
  fetch?,         // 中间件注入点（applyMiddlewares(createMiddleware(...))(fetch)）
  sessionId?,     // legacy 重连时可带
}));
```

- transport 家族:`StreamableHTTPClientTransport`(现代)、`StdioClientTransport`(`@modelcontextprotocol/client/stdio`,子进程)、`SSEClientTransport`(老 SSE 服务端回退)、`InMemoryTransport.createLinkedPair()`(同进程对打,**Balsa 的 MCP server/client 对打 example 可直接用**)。
- `await client.connect(transport)` 完成握手;默认 legacy `initialize`(`versionNegotiation: { mode:'auto' }` 先 `server/discover` 探测、失败回退;`{ pin:'2026-07-28' }` 不回退、失败抛 `SdkError(ERA_NEGOTIATION_FAILED)`);`client.getProtocolEra()` 读 era;`getServerVersion()` / `getServerCapabilities()` / `getInstructions()` / `getDiscoverResult()`(有值 = modern,可缓存作 `prior` 跳过探测)。
- **关闭**:`await transport.terminateSession()`(Streamable HTTP,server 未发 session id 时不发请求)→ `await client.close()`;`close()` 拆 transport 并以 `CONNECTION_CLOSED` 拒绝所有在途请求。**`StdioClientTransport.close()` 顺序 = 关 stdin → SIGTERM → SIGKILL**(客户端拥有子进程;服务端子进程归属在客户端侧)。
- 客户端中间件:`createMiddleware` / `applyMiddlewares` / 内置 `withLogging()` / `withOAuth(provider, url)`;`withLogging` 默认写 `console`,stdio 进程里需自供 `logger`。

### 7.2 列表、调用与取消

```ts
const { tools } = await client.listTools();                    // 自动翻页聚合，无 nextCursor
const page = await client.listTools({ cursor });               // 单页原始
const res = await client.callTool({ name, arguments }, {
  signal?,                     // AbortSignal：取消该调用
  onprogress?,                 // 收 notifications/progress
  timeout?, resetTimeoutOnProgress?, maxTotalTimeout?,
});
// res = { content, structuredContent?, isError? }
```

- **翻页**:列表接口自动走 `nextCursor` 聚合;`ClientOptions.listMaxPages` 默认 64,超限抛 `SdkError(LIST_PAGINATION_EXCEEDED)`;显式 `cursor` 调用不受上限约束。
- **失败面二分**:工具执行失败是**结果**(`isError`,需自己查);只有协议级失败(未知工具、超时等)才 **throw**。
- `structuredContent` 为 `unknown`;若先前 `listTools()` 给过该工具 `outputSchema`,**客户端会校验**并在不合时拒绝。
- 取消:客户端 `signal` 中止 →(modern)关闭该请求 SSE 流 /(legacy)`notifications/cancelled`;调用方得到 `SdkError`(如 `the end user clicked Stop`)。
- 错误类型:`SdkError`(`CONNECTION_CLOSED` / `REQUEST_TIMEOUT` / `LIST_PAGINATION_EXCEEDED` / `ERA_NEGOTIATION_FAILED` / `MethodNotSupportedByProtocolVersion`)、`SdkHttpError`(`ClientHttpAuthentication` 401 / `ClientHttpForbidden` 403)。
- **头透传**:`requestInit.headers`(每请求);transport 自管头(如 authProvider 产出的 `Authorization`、`Mcp-Session-Id`)优先,`TransportSendOptions.headers` 不可覆盖。

## 8. 并发、会话与状态

一手来源:`docs/serving/sessions-state-scaling.md`、`docs/serving/http.md`、`docs/serving/stdio.md`。

- **modern HTTP 默认无状态**:每请求新实例、请求间零持有 → 任意负载均衡、无亲和性、无需共享。
- **stdio**:每连接一个工厂实例;连接关闭 → 在途请求中止且不答复;文档未给逐连接请求串行化/并发上限。
- **legacy sessionful 需手布线**(`NodeStreamableHTTPServerTransport`):`sessionIdGenerator` 开启会话;`onsessioninitialized` 建 map;按 `Mcp-Session-Id` 路由 `POST`/`GET`/`DELETE`;未知 id → `404`(客户端应新开会话),无头非 initialize → `400`;`transport.onclose` 清 map;停机逐个 `transport.close()`。
- **可恢复流**:`EventStore` 两方法(`storeEvent(streamId, message)` / `replayEventsAfter(lastEventId, { send })`)+ 客户端带 `Last-Event-ID` 重连。
- **跨节点**:`subscriptions/listen` 的变更事件走 `ServerEventBus`(默认进程内,多节点需自实现 pub/sub 并注入 `createMcpHandler({ bus })`)。
- 规范侧:**MCP 无协议级 session**(2026-07-28 明确),需要跨调用状态的工具应返回**显式 handle**(购物车、浏览器上下文等),由模型在后续调用里带回;handle 需不透名、有界生命期、每次调用重验授权。

## 9. 对 MCP server / client 两张决策票的事实含义(不裁决)

### 9.1 server 包(`createMcpServer({ name, version, tools })` 形态)

- **入口选择是显式分叉**:HTTP 走 `createMcpHandler`、stdio 走 `serveStdio`;二者都接受「工厂」而非单例 server —— 与 Balsa 的动态工具容器(`DynamicArgument<Record<string, Tool>>`)**天然契合**:每请求/每连接按当次容器注册。若要单实例语义,才用低层 `McpServer` + `connect`。
- **ToolContext 合成**(Balsa 六件套 `signal` / `runId` / `toolCallId` / `requestContext` / `traceId` / `spanId`)在 MCP 侧只有部分对应物:`signal` ← `ctx.mcpReq.signal`;**`toolCallId` 的天然候选是 `ctx.mcpReq.id`(JSON-RPC id,SDK 未以其命名)**;`runId` / `traceId` / `spanId` 在 MCP 协议面**无对应物**(需空串/自造),`requestContext` 为空袋。
- **错误三线映射已精确**:Balsa 的「输入校验 / execute 抛错 / 输出校验」三线在 MCP 侧就是 `isError: true` 结果,SDK 自己完成归一(catch 分支);Balsa 只需保证 `execute` 不吞异常、`outputSchema` 与 `structuredContent` 成对出现。
- **工具名合法性要自己校验**:SDK 不查字符集/长度,只在 `x-mcp-header` 上警告;重复名由 SDK 抛错。规范 SHOULD 的字符集(含 `.`,1–128)与 Balsa `tools.md` 现写的 `[a-zA-Z0-9_-]{1,64}` **不一致**。
- **无参工具签名差异**:Balsa 的「省略 inputSchema = 无参」在 SDK 侧对应 handler 变 `(ctx)`;包装层需按 schema 是否存在切换调用形态(源码已如此分支)。
- **schema 桥接零适配成立**:Balsa `Tool.inputSchema` 是 `StandardSchemaV1 & StandardJSONSchemaV1`,SDK 要 `StandardSchemaWithJSON`,结构同源;**但 SDK 输出 2020-12 JSON Schema**,与 Balsa 发 provider 的 draft-07 子集是不同出口,互不影响。
- **era 姿态必须选**:默认两代都服务(`legacy: 'stateless'` / `'serve'`),或显式 `'reject'` 只做 modern;modern 无 session,legacy sessionful 需要用户自布线(超出「一个 `createMcpServer` 即可」的形态)。

### 9.2 client 包(`createMcpClient({ transport })` → `Record<string, Tool>`)

- **连接生命周期**:`Client.connect()` + `client.close()` 是骨架;stdio 子进程由 `StdioClientTransport` 拥有,关闭顺序固定(关 stdin → SIGTERM → SIGKILL);HTTP 需要 `terminateSession()` 才礼貌结束 legacy 会话。
- **`listTools` 已内建翻页聚合**(默认 64 页),Balsa 的「connect 时 listTools 一次并缓存 + `refresh()`」可直接架在其上;单页 `cursor` 也保留。
- **远端错误映射要显式**:`callTool` 的失败面是「`isError` 结果 vs throw」二分;Balsa 的三线归一(一律 error 工具结果回喂)需要在包装层把 throw 也转成 error 结果。
- **schema 直通桥接**:`tools/list` 给的是 JSON Schema,Balsa 侧需自建 Standard Schema 包装(`validate` 直通 / `jsonSchema` 原样)——SDK 不提供该包装;而 SDK 客户端自身会用 `outputSchema` 校验 `structuredContent`,与 Balsa 包装不冲突(注意别双重校验报错语义)。
- **头/认证**:`requestInit.headers` 透传 bearer 等;OAuth 走 `authProvider`(Balsa 裁出 OAuth 助手的话,透传路径已足够)。

### 9.3 依赖预算事实(供基建政策票)

- `server` / `client` 均**直接依赖 zod ^4.2.0**(core 也用 zod 定义协议 schema);「Standard Schema 原生」不减免安装树里的 zod。
- middleware 包把框架列为 **peer**(`node` 唯一运行期依赖是 `@hono/node-server`,hono 为 optional peer);`express` 中间件带 `cors`。
- 自家包发布时**精确钉死** `core@2.2.0`(workspace → 精确),zod 用 caret。

## 10. 未定 / 未见事实(留决策票)

- 文档未给**逐连接请求并发上限/串行化保证**;可观察语义只有「每请求实例」与「close 时在途中止」。
- `ctx.mcpReq.id` 未在文档中被命名为 `toolCallId`(仅源码以 `relatedRequestId` 使用)。
- SDK **不校验工具名字符集**;规范 SHOULD 与 Balsa `tools.md` 现写法不一致(事实已摆;如何对齐归包票)。
- 无参工具的 JSON Schema 是 `{type:'object',properties:{}}`,与规范推荐的 `additionalProperties:false` 不同。
- v2 **不服务 experimental tasks 组件**(SEP-1686);扩展(tasks / DPoP / WIF)在路线图。
- legacy sessionful 路径依赖用户手布线(非两个入口能表达);`server-legacy/sse` 已标 deprecated、v3 计划移除。
- v1 线(1.31.0)仍收 bug/安全修复,窗口 ≥ 2027-01-27(v2.0.0 发布后 6 个月)。

## 附:来源

一手(本地克隆 `modelcontextprotocol/typescript-sdk` main,2026-09-30 拉取;行号/路径为克隆内路径):

- `README.md`(v2 稳定线、包面、最小 server 示例)、`ROADMAP.md`(v2 硬化、v1.x 6 个月窗口、tasks 扩展未服务)、`VERSIONING.md`(fixed group、breaking 定义、deprecation 政策)、`DEPENDENCY_POLICY.md`(caret、自家包精确钉、框架 peer)
- `docs/servers/tools.md`(registerTool、inputSchema 校验、`isError`、structuredContent、content 块)
- `docs/servers/errors.md`(工具错误 vs 协议错误、`isError` 构造面、`ProtocolErrorCode` 全表、子类)
- `docs/servers/logging-progress-cancellation.md`(`ctx.mcpReq.signal` / `notify` / `log`、客户端 `onprogress` / `signal`)
- `docs/advanced/schema-libraries.md`(Standard Schema 各库、`fromJsonSchema`、验证器选择)
- `docs/serving/http.md`(createMcpHandler、工厂每请求、`responseMode`、`close`、authInfo 透传)、`docs/serving/stdio.md`(serveStdio、handle、EOF 语义、stderr)、`docs/serving/legacy-clients.md`(legacy 姿态、`isLegacyRequest`、SSE 去向)、`docs/serving/sessions-state-scaling.md`(session/EventStore/ServerEventBus)、`docs/serving/express.md`、`docs/serving/hono.md`
- `docs/clients/connect.md`(Client/transport/connect/close/`terminateSession`/introspect)、`docs/clients/calling.md`(listTools 聚合、callTool opts、structuredContent 客户端校验)、`docs/clients/middleware.md`(requestInit 头、applyMiddlewares、withLogging)
- `docs/protocol-versions.md`(era 模型与差异矩阵唯一副本、`versionNegotiation`、探测语义)
- `packages/server/src/server/mcp.ts`(McpServer 类、`registerTool` 重载与 `RegisteredTool` 含 `enable/disable/update/remove`、tools/call 错误分支、`createToolError`、`validateToolOutput`、`EMPTY_OBJECT_JSON_SCHEMA`、`scanXMcpHeaderDeclarations`)
- `packages/server/src/server/server.ts`(`buildContext`:`mcpReq.log/envelope/elicitInput/requestSampling/requestState`、`http.authInfo`)
- `packages/core/src/schemas.ts`(协议 Zod schema、`inputSchema`/`outputSchema` 标注 2020-12)、`packages/server/package.json` / `packages/core/package.json`(exports、deps)
- MCP 规范 2026-07-28 Tools:<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>(工具名 SHOULD 1–128 与字符集 `A-Za-z0-9_-.`、`x-mcp-header`/`Mcp-Param-*`、`structuredContent` + `outputSchema`、协议错误 vs 工具错误、无协议级 session 的状态 handle、安全考虑)

npm registry 实测(2026-09-30,`registry.npmjs.org/<pkg>/latest`):`@modelcontextprotocol/server@2.2.0`、`client@2.2.0`、`core@2.2.0`、`node@2.1.0`、`hono@2.0.1`、`express@2.0.1`、`fastify@2.0.0`、`server-legacy@2.2.0`、`sdk@1.31.0`(依赖/peer/unpacked 尺寸见 §1)。

沿前序调研:#6(`docs/research/lightweight-benchmarks-mcp.md`,v2 包数/体积实测)、#7(OTel/semconv 状态,与本票无关)。
