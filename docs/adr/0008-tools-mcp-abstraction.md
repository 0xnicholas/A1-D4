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

(来源:wayfinder ticket #13)
