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

- **四字段,无 id/name**:名字的唯一真相源是容器 Record 键(Agent 规范已定 `Record<string, Tool>` + 构造期唯一性校验);MCP 暴露时同键。
- **`createTool(config)` 工厂仅为类型推断**(schema → input/output 类型),返回冻结普通对象;手写字面量合法(结构化类型,工厂不是必需)。
- **字段不逐个动态化**:动态性由 Agent 的 tools 容器(`DynamicArgument<Record<string, Tool>>`)整组承载——per-request 换工具集在容器层整组替换,不在工具内部逐字段解析。
- **schema 契约**:`StandardSchemaV1 & StandardJSONSchemaV1` 双接口(ADR-0003);`~standard.jsonSchema` 出 JSON Schema 发给 provider。
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

第 3 条与 structuredOutput 的 strict 调子一致(失败即报错);注意此时**副作用已经发生**,重复执行防护归工具的幂等设计,框架提供 `toolCallId` 作幂等键。校验由框架调用点执行(agent loop、MCP server 包);手动直调 execute 时校验是调用方责任。

## 组合范式

agent as-tool(Agent 规范已钉一行包装):

```ts
const agentAsTool = createTool({
  description: agent.description ?? agent.name,
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

独立 npm 包(名待「项目命名与品牌」决策),依赖 `@modelcontextprotocol/server` + `@modelcontextprotocol/node`——边际约 2–3 个包,复用 zod@4(#6 实测)。v1 单包 `@modelcontextprotocol/sdk`(92 安装包、硬拉 express+hono)为过时路径,明确排除。

```ts
createMcpServer({ name, version, tools: Record<string, Tool> })
```

- **transport**:stdio + Streamable HTTP;HTTP 经官方 node thin middleware 接入——不绑任何 web 框架,不自实现传输;旧 SSE 传输已废弃,不做。
- **原语范围**:v1 仅 tools;prompts / resources 后加(minor)。
- **工具名合法性**:MCP 字符集 `[a-zA-Z0-9_-]{1,64}`(provider 侧大致相同);Record 键是任意字符串,暴露期校验、非法名即报错——agent 域合法不代表 MCP 域合法。
- Tool 的 inputSchema/outputSchema 本就是 Standard Schema,MCP v2 SDK 原生讲 Standard Schema(ADR-0003),映射零适配层。

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

核心(含 tools 子路径)运行时依赖 = 0(ADR-0001 红线,内部 CI 回归参考);MCP 两能力包各自隔离,不装不付(server ≈ 2–3 包;client 13 包 / 14.1 MiB)。
