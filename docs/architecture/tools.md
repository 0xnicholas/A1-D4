# Tools/MCP 抽象

> 来源:wayfinder ticket #13(决策:Tools/MCP 抽象)。本文件是 Tools 子系统与 MCP 能力包的架构规范。
> 决策记录见 `docs/adr/0008-tools-mcp-abstraction.md`(ctx 六件套修订见 `0012-multi-agent-collaboration.md`);术语见 `CONTEXT.md`。

## 定位

工具是框架向模型开放的唯一动作通道。设计遵守轻量轴:**定义表面刻意最小(四字段普通对象),MCP 互通全部挂包边界,核心零依赖零 MCP 概念**。北极星是同一份 Tool 定义双向流通——server 包把它暴露给 MCP 生态,client 包把外部 MCP 工具转译成它——agent 不感知 MCP 存在。

## Tool 定义表面

```ts
interface ToolConfig {
  description: string,                        // 必填,给模型看
  inputSchema?: StandardSchema,               // 可选;省略 = 无参工具
  outputSchema?: StandardSchema,              // 可选;存在则校验输出
  execute: (input, ctx: ToolContext) => output | Promise<output>,
}
```

- **四字段,无 id/name**:名字的唯一真相源是容器 Record 键(Agent 规范已定 `Record<string, Tool>` + 构造期唯一性校验);MCP 暴露时同键。Record 键本身唯一——同一字面量里重名是 TypeScript 编译错误,构造期唯一性校验因此落在编译期;运行期无法表达重复键(程序化组装在到达容器前已被对象语义折叠)。
- **`createTool(config)` 工厂仅为类型推断**(schema → input/output 类型),返回冻结普通对象;手写字面量合法(结构化类型,工厂不是必需)。
- **字段不逐个动态化**:动态性由 Agent 的 tools 容器(`DynamicArgument<Record<string, Tool>>`)整组承载——per-request 换工具集在容器层整组替换,不在工具内部逐字段解析。
- **schema 契约**:`StandardSchemaV1 & StandardJSONSchemaV1` 双接口(ADR-0003);`~standard.jsonSchema` 出 JSON Schema 发给 provider——目标固定 draft-07(与模型契约的 `JsonSchema` 子集一致),转换器产物原样直通,核心不改写 schema。
- **无参工具**:inputSchema 省略时,发给 provider 的 parameters 补空 object schema(`{ type: 'object', properties: {} }`),`input` 类型为 `undefined`。

## 执行上下文

`execute(input, ctx)` 两参签名:`input` 是 schema 校验后的模型生成参数(类型从 schema 推出),`ctx` 是框架上下文。**模型给的与框架给的分属两个参数,不混装一袋**(与 workflow `StepContext` 的 inputData-in-bag 刻意不同——step 输入是上游管道数据,工具输入是模型 JSON)。

```ts
interface ToolContext {
  signal: AbortSignal,            // 取消传播,沿 run 下发(Agent 规范已定)
  runId: string,                  // 日志/追踪关联
  toolCallId: string,             // provider 生成的调用 id;幂等键
  requestContext: RequestContext, // 用户 per-call 开放袋(嵌套不拍平,与 StepContext 对齐)
  traceId: string,                // 当前 run 的 trace id;as-tool 组合时透传给委派 run(ADR-0012)
  spanId: string,                 // 当前 tool-call span id;委派 run 经 run option 挂为其子 span
}
```

- **零权限模型**:取消 = `signal`;审批/挂起 = Harness(#18)统一裁决;授权 = 应用层(与 Memory 决策同一条线)。
- **不注入 agent / memory 引用**:mastra 把两者传给工具,是耦合源;需要时经 `requestContext` 用户袋或闭包获取。
- agent loop 内调用时框架保证六件套齐备(含 provider 真值 toolCallId);未挂 tracer 时 `traceId`/`spanId` 为空串(与观测规范的 NoOpSpan 语义对齐)。手动直调时 toolCallId 由调用方自供(如 workflow 包装用 step id),`traceId`/`spanId` 不需要时同样传空串。

## 校验与错误语义

**三线归一**——以下三种失败统一转为 error 工具结果**回喂模型**,run 不中止(沿用 Agent 规范「工具错误回喂」总原则):

1. input 校验失败(模型生成的参数不合 inputSchema)
2. execute 抛错
3. output 校验失败(execute 返回不合 outputSchema)

同语义的第四类:模型调用了工具容器中不存在的名字(Record 无此键)——框架没有可执行的 execute,同样直接以 error 结果回喂。

第 3 条与 structuredOutput 的 strict 调子一致(失败即报错);注意此时**副作用已经发生**,重复执行防护归工具的幂等设计,框架提供 `toolCallId` 作幂等键。校验由框架调用点执行(agent loop、MCP server 包);手动直调 execute 时校验是调用方责任。

## 组合范式

agent as-tool(Agent 规范已钉包装形态;Agent 的 `description` 是动态参数,故它在包装处经 `resolveDynamicArgument` 取值——Tool 的 description 是构造期静态字段):

```ts
const agentAsTool = async (ctx: RequestContext) =>
  createTool({
    description: (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name,
    inputSchema: z.object({ prompt: z.string() }),
    execute: (input, { signal, traceId, spanId }) =>
      agent.generate(input.prompt, { signal, traceId, parentSpanId: spanId }),
  })
```

workflow 中用工具(无 `createStep(tool)` 特化,ADR-0006):

```ts
createStep({
  id: 'search',
  inputSchema, outputSchema,
  execute: ({ inputData, runId, signal, requestContext }) =>
    searchTool.execute(inputData, { signal, runId, toolCallId: 'search', requestContext }),
})
```

## MCP server 能力包

独立 npm 包 `@balsa/mcp-server`(ADR-0002 M5 修订;`@balsa/core` 走 peer,清单三件套沿能力包先例)。直连依赖仅 `@modelcontextprotocol/server@^2.2.0`——传递闭包 server / core / zod 3 包;Node `node:http` 绑定与 Host/Origin 防护归用户侧(官方 `@modelcontextprotocol/node`,文档钉接线),不直连。v1 单包 `@modelcontextprotocol/sdk`(92 安装包、硬拉 express+hono)为过时路径,明确排除。数字口径归 `deps-budget.json`(实施图落基线),本节只冻包集合与版本线。

```ts
const server = createMcpServer(
  { name, version, tools: Record<string, Tool> },
  { http?: { legacy?: 'stateless' | 'reject' } }, // 创建期选项;省略 = SDK 默认
)

server.fetch                                // web-standard handler:(Request, opts?) => Promise<Response>
server.serveStdio({ legacy?, transport? })  // → { close } — 起 stdin/stdout 服务
await server.close()                        // 闭合已开入口、中止在途
```

- **传输接入面**:HTTP = `server.fetch`,可直接 `export default { fetch }` 或挂任意 web 框架/运行时,`opts` 透传 SDK 的 `{ authInfo?, parsedBody? }`(v1 不消费 `authInfo`;`parsedBody` 给预解析 body 的框架);Node `node:http` 宿主自装官方 `@modelcontextprotocol/node`(`toNodeHandler` + `localhostHostValidation` / `localhostOriginValidation`,文档给片段)——不绑 web 框架、不自实现传输;旧 SSE 传输已废弃,不做。stdio = `server.serveStdio()`,options 里的 `transport` 是 in-process 接缝(`InMemoryTransport` 仅连 2025 代;modern 的 in-process 入口就是 `server.fetch`);v1 只收 `legacy` / `transport` 两项,其余沿 SDK 默认。`close()` 沿 SDK 语义:modern 在途交换被中止、闭合后 `fetch` 拒绝,legacy stateless 交换不被追踪。SDK 的 `notify` / `bus` 不暴露(静态工具无 listChanged;跨节点分发出 v1)。
- **era 姿态**:默认双代全服务(HTTP `legacy: 'stateless'`、stdio `legacy: 'serve'`);可切 `'reject'` 只服务 modern。legacy sessionful 不做——需要者用官方 SDK 自布线(`McpServer.connect(transport)`;更底层的 `Server` 类已 deprecated)。
- **原语范围**:v1 仅 tools;prompts / resources 后加(minor)。
- **ToolContext 合成**:`signal ← ctx.mcpReq.signal`;`toolCallId ← String(ctx.mcpReq.id)`(JSON-RPC 请求身份,跨连接不保证稳定);`runId` / `traceId` / `spanId` 为空串——MCP 无 run、v1 不注入 tracer,与 NoOpSpan / 手动直调语义对齐;`requestContext` 冻结空袋(框架只写 `signal` 与 `runId: ''`,不塞 `authInfo` / `era` 等 MCP 事实;授权归传输层中间件,需要 per-request 工具集的宿主走官方 SDK 自布线)。
- **结果与错误投影**:`outputSchema` 存在 → `structuredContent = output` 原文 + `content = [{ type: 'text', text: render(output) }]`;无 `outputSchema` → 仅 content。`render` = `string` 原样、其余 `JSON.stringify`(`undefined` 退化 `String`)。输入校验 / execute 抛错 / 输出校验三线全由 SDK 归一为 `{ content: […], isError: true }` 结果——Balsa 不加层、不改消息;未知 / 禁用工具沿 SDK 的协议错误(JSON-RPC error),wire 错误还原为本框架语义是 client 包的职责。
- **工具名合法性**:`[A-Za-z0-9_.-]{1,128}`(对齐 MCP 规范 SHOULD,ADR-0008 修订);`createMcpServer()` 构造期逐键校验,非法即抛——agent 域合法不代表 MCP 域合法。
- **每请求实例**:SDK 工厂模型——HTTP 每请求、stdio 每连接(含 discover 探测重进)新建实例;桥接层按次整组注册全部工具(工具 Record 本身不改),工厂须廉价、无副作用。
- **schema 零适配**:Tool 的 inputSchema/outputSchema 是 `StandardSchemaV1 & StandardJSONSchemaV1`(ADR-0003);SDK 以 `~standard.validate()` 校验(输入/输出,transform 生效)、以 `~standard.jsonSchema` 目标 `draft-2020-12` 出 JSON Schema(与发 provider 的 draft-07 目标同源不同出口);inputSchema 需 object 根。执行输入是 SDK 校验后的值——校验职责整体移交 SDK,与 agent loop 的框架侧校验同义。

## MCP client 能力包

独立 npm 包,依赖 `@modelcontextprotocol/client`(13 包 / 14.1 MiB,#6 实测;大头是 OAuth/SSE/stdio,属功能必需)。**与 server 包分开是按需组合的硬要求**:依赖是包级粒度,合包则 server 用户连坐 client 的 13 包。

```ts
const client = await createMcpClient({ transport: … })
// client.tools: Record<string, Tool> —— execute 代理到远端,直接展开进 agent 容器
```

- **接入形态唯一**:外部 MCP 工具转译为本框架 Tool 直接进 agent 容器;不做 mastra 式 MCPConfiguration 平行容器。
- **连接**:stdio(`command + args + env`,拉起子进程)+ Streamable HTTP(`url + headers`)。
- **认证**:headers 透传(bearer 等)覆盖多数远程 server;OAuth 授权流助手裁出 v1(后加 minor)。注意裁它不缩小安装树(SDK 整包照装),裁的是产品面。
- **发现**:connect 时 `listTools` 一次并缓存,`refresh()` 手动刷新;不做 listChanged 变更订阅(长驻监听与无运行时负担有张力)。
- **名冲突**:纯函数 helper `prefixTools(tools, prefix)`——不冲突零概念,冲突时一行解决;不进 client 配置面。
- **桥接工具的 schema**:「JSON Schema 直通」的 Standard Schema 包装——`~standard.validate` 直通成功(校验在远端,失败经 execute 错误回喂),`~standard.jsonSchema` 返回远端原文;零依赖零适配层。

## 与其它子系统的关系

- **模型层(#9,已定)**:chunk 协议承载 tool-call / tool-result 事件;工具 schema 经双接口出 JSON Schema 发给 provider。
- **Agent(#10,已定)**:容器形状 `Record<string, Tool>`、工具错误回喂、maxSteps、signal 传播全部继承;审批/挂起不在核心,无 `requireToolApproval` 字段。
- **Workflows(#11,已定)**:无特化重载,一行手写包装;`ToolContext` 与 `StepContext` 对齐(signal / runId / requestContext)。
- **Memory(#12,已定)**:授权归应用层同一条线;工具要记忆经 requestContext 用户袋或闭包。
- **Harness(#18)**:审批/挂起的统一裁决归它;届时若进核心按 minor 扩展(ADR-0005 consequence)。
- **Observability(#14,已定)**:ctx 携带 `traceId`/`spanId`,供 as-tool 组合经 run option 续接 trace、把委派 run 挂为当前 tool-call span 的子 span(ADR-0012)。

## 依赖预算

核心(含 tools 子路径)运行时依赖 = 0(ADR-0001 红线,内部 CI 回归参考);MCP 两能力包各自隔离,不装不付(server = server / core / zod 3 包,node 绑定归用户侧;client 13 包 / 14.1 MiB)。
