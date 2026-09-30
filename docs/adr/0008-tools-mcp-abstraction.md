# Tools/MCP 抽象:四字段普通对象 + 两参 execute + MCP 双能力包双向流通

Tool 收敛为四字段普通对象(`description` + 可选 `inputSchema`/`outputSchema` + `execute`),无 id/name——名字的唯一真相源是容器 Record 键;`createTool` 工厂仅为类型推断,字面量合法;字段不逐个动态化(动态性由 Agent 的 tools 容器整组承载)。`execute(input, ctx)` 两参签名,ctx 四件套(`signal` / `runId` / `toolCallId` / `requestContext`);核心零权限概念——取消 = signal,审批归 Harness(#18),授权归应用层。三种失败(input 校验、execute 抛错、output 校验)统一为 error 工具结果回喂模型,run 不中止。MCP server 与 client 都做、各成独立能力包:server 包把 `Record<string, Tool>` 暴露为 MCP(stdio + Streamable HTTP 经官方 node middleware,v1 仅 tools 原语);client 包把外部 MCP 工具转译为本框架 Tool 直接进 agent 容器(headers 透传,OAuth 助手与变更订阅裁出 v1)。同一份 Tool 定义双向流通,agent 不感知 MCP 存在。依据:按需组合轴(server/client 依赖成本悬殊——边际约 2 包 vs 13 包,合包即连坐)、Standard Schema 双接口与 MCP v2 SDK 原生互通(#6 实测、ADR-0003),以及可逆性不对称——字段默认砍,能力挂包边界。

## Considered Options

- **工具带 id/name 字段(mastra 式)**:被否——容器 Record 键已是名字,第二真相源只会漂移。
- **execute 单袋签名(workflow StepContext 风)**:被否——工具输入是模型生成的 JSON,与框架上下文分参边界更清晰;AI SDK 用户熟悉两参。
- **工具字段逐个动态化**:被否——agent 的 tools 容器本身是 DynamicArgument,整组替换已覆盖动态场景;逐字段动态只加解析复杂度。
- **mastra 式 MCPConfiguration 平行容器**:被否——client 工具转译为本框架 Tool 直接进 agent 容器,少一层概念,agent 不感知 MCP。
- **MCP server/client 合为单包**:被否——依赖是包级粒度,server 用户会连坐 client 的 13 包,违背按需组合。
- **MCP v1 SDK 路径**:被否——92 安装包、硬拉 express+hono 双 web 框架(#6 实测),已过时。
- **outputSchema 失败中止 run / 不校验**:被否——前者违背「工具错误不中止 run」总原则;后者削弱校验承诺,与 structuredOutput 的 strict 调子不一。统一回喂,幂等防护归工具设计(toolCallId 作幂等键)。
- **OAuth 授权流助手进 v1**:被否(暂缓)——headers 透传已覆盖多数远程 server;裁的是产品面不是安装树(SDK 整包照装),后加是 minor。

## Consequences

- 工具形状是公开 API:四字段 + 两参签名一旦发布,改动是 major;新增字段须先过「为什么 Processor / 能力包 / 用户袋承载不了」一问(沿用 ADR-0005 的审查纪律)。
- 无参工具的 `input` 类型为 `undefined`,provider 侧收空 object schema;桥接工具的 inputSchema 是 JSON Schema 直通包装(validate 直通、jsonSchema 原文),远端校验失败经 execute 错误回喂。
- MCP server 包暴露期校验工具名合法字符集 `[a-zA-Z0-9_-]{1,64}`,非法即报错(agent 域合法不代表 MCP 域合法)。
- prompts / resources 原语、OAuth 助手、listChanged 订阅均为 minor 后加位,不进 v1。
- **修订(M5 MCP server 设计冻结,2026-09-30)**:`@balsa/mcp-server` 设计冻结(包面 / era 姿态 / ToolContext 合成 / 结果与错误投影 / 工具名口径 / 依赖与绑定),依据 [决策:MCP server 能力包](https://github.com/0xnicholas/balsa-framework/issues/74) 决议评论与 `docs/architecture/tools.md`「MCP server 能力包」节:
  - **包面**:`createMcpServer({ name, version, tools }, { http?: { legacy } })` 返回单对象——`server.fetch(request, opts?)`(HTTP,web-standard handler)、`server.serveStdio({ legacy?, transport? })`(stdio)、`server.close()`(闭合已开入口、中止在途);SDK 的 `notify` / `bus` 不暴露。
  - **era 姿态**:默认双代全服务(HTTP `legacy: 'stateless'`、stdio `'serve'`),两处可切 `'reject'`;legacy sessionful 不做,需要者用官方 SDK 自布线。
  - **依赖与绑定**:直连仅 `@modelcontextprotocol/server@^2.2.0`(传递闭包 3 包:server / core / zod;数字口径归 `deps-budget.json`,实施图落基线);Node `node:http` 绑定与 Host/Origin 防护归用户侧(官方 `@modelcontextprotocol/node`),不绑 web 框架、旧 SSE 不做。
  - **ToolContext 合成**:`signal ← ctx.mcpReq.signal`;`toolCallId ← String(ctx.mcpReq.id)`;`runId` / `traceId` / `spanId` 空串(无 run、不注入 tracer);`requestContext` 冻结空袋(仅框架写的 `signal` / `runId: ''`)。
  - **结果与错误投影**:`outputSchema` 存在 → `structuredContent` = output 原文 + text 渲染(`string` 原样 / 其余 `JSON.stringify`);三线错误(输入校验 / execute 抛错 / 输出校验)全交 SDK 归一为 `isError` 结果,未知 / 禁用工具为协议错误(wire 错误还原归 client 包)。
  - **工具名口径改写**:暴露期校验由上文 `[a-zA-Z0-9_-]{1,64}` 改为对齐 MCP 规范 SHOULD 的 `[A-Za-z0-9_.-]{1,128}`(含点、上限 128),在 `createMcpServer()` 构造期逐键校验;上文 Consequences 相应行为本修订取代。

(来源:wayfinder ticket #13)
