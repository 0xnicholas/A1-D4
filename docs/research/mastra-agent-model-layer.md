# 调研:mastra Agent 抽象与模型层

> wayfinder research for issue #4。只呈现事实与轻量化的取舍含义,不做架构决策。
> 一手来源:mastra 官方文档(mastra.ai,2026-09 抓取)与 `mastra-ai/mastra` 源码 `packages/core`(commit `cceb9ab`,2026-09-27)。
> 注意:mastra 仍在快速演进,ticket 中部分表述(如 "40+ provider"、`.network()`)对应较早版本,文中标注了现状。

## TL;DR

mastra 1.0 之后的事实是**双轨**:核心自建有状态的 agent loop(`packages/core/src/loop`)与模型路由层(`ModelRouterLanguageModel`),对外以 AI SDK 的 provider 规范(`LanguageModelV2/V3/V4`)为类型底座,把 AI SDK 的 UI/流格式互操作拆进独立的 `@mastra/ai-sdk` 包。`Agent` 类本身已长成一个 1 万行、约 25 个配置字段的平台级对象——其"最小核心"只是 `id/instructions/model/tools` + `generate()/stream()`,其余(memory、processors、sub-agents、durable、editor、voice、channels…)全部是挂上去的可选模块。对轻量框架的含义:mastra 验证了"字符串路由 + 网关接口 + 自有 loop + AI SDK 仅作互操作"这条路的可行性,也展示了它的代价(4 个大版本的 AI SDK provider 包并存、208-provider 注册表、持续刷新的模型目录)。

## 1. `Agent` 类的完整表面

### 1.1 构造配置(`AgentConfig`)

源码:`packages/core/src/agent/types.ts:687`(`AgentConfigBase`)、`:1098`(`AgentConfig`);参考文档:[Agent Class](https://mastra.ai/reference/agents/agent)。

必填核心只有三项(当前版本 `id` 可省略、回落到 `name`;v1 迁移时曾改为必填,后放宽):

- `id` / `name` — 标识与展示名
- `instructions` — `string | string[] | CoreSystemMessage | SystemModelMessage | 数组 | 动态函数`,支持 `providerOptions`(如 `openai.reasoningEffort`、`anthropic.cacheControl`)
- `model` — 见 §2;支持字符串、配置对象、LanguageModel 实例、fallback 数组、动态函数

可选模块(全部可缺省):

| 字段 | 作用 |
| --- | --- |
| `tools` / `workflows` / `agents` | 可调用的工具、工作流、sub-agent(监督者形态,§4) |
| `memory` | `MastraMemory`,会话持久化 |
| `inputProcessors` / `outputProcessors` / `errorProcessors` / `maxProcessorRetries` | 横切处理管线(§1.4) |
| `defaultOptions` / `defaultGenerateOptionsLegacy` / `defaultStreamOptionsLegacy` / `defaultNetworkOptions` | 各执行入口的默认参数 |
| `scorers` / `voice` / `skills` / `browser` / `channels` / `workspace` | 评估、语音、技能、浏览器、IM 渠道、文件/沙箱 |
| `durable` / `pubsub` / `backgroundTasks` / `signals` / `goal` / `notifications` | 持久执行与事件 harness |
| `hooks` / `transform` / `maxRetries` / `metadata` / `description` / `requestContextSchema` | 工具钩子、payload 变换、重试、分类元数据 |
| `editor` / `rawConfig` / `options` / `mastra` | Studio 编辑器所有权、stored agent 水合、运行时注入(§5) |

两个贯穿性设计:

- **`DynamicArgument<T>`:几乎所有配置字段都接受 `T | ({ requestContext }) => T | Promise<T>`**,在每次执行时按请求上下文解析(model、instructions、tools、memory…无一例外)。这是 mastra 表达力(多租户、A/B、按 tier 选模型)的主要来源,实现成本只是一个 union 类型 + 统一解析点。
- **Editor 所有权在类型层强制**:`editor: { instructions: true }` 会把 `instructions` 字段变成 `?: never`(`AgentEditableFieldConfig`,types.ts:1087),代码与 Studio 不能同时拥有同一字段。

方法面(`packages/core/src/agent/agent.ts`,**10,470 行**):执行入口 `generate()` / `stream()` / `generateLegacy()` / `streamLegacy()` / `network()`(已废弃)/ `streamUntilIdle()`(已被 `untilIdle` 选项取代);取值器 `getInstructions()` / `getModel()` / `getLLM()` / `getMemory()` / `getTools()` / `listAgents()` / `listScorers()` / `getDefaultOptions()` 等(v1 起直接属性访问 `agent.llm` 等被废弃,统一走 getter);加上工具审批、标题生成、durable/目标/signal 相关与大量 `__` 前缀内部方法。

### 1.2 `.generate()` 语义

来源:[Agent.generate()](https://mastra.ai/reference/agents/generate)。

- 输入:`string | string[] | CoreMessage[] | UIMessageWithMetadata[]`;选项 `AgentExecutionOptions`。
- 返回**完整执行输出对象**(非 AI SDK 的 `GenerateTextResult`):`text`、`object`(structuredOutput)、`toolCalls`/`toolResults`(**mastra 自有 ChunkType 格式,数据包在 `payload` 里**,与 AI SDK 的 ToolCall 形状不同)、`usage`、`steps[]`、`finishReason`(`'stop' | 'tool-calls' | 'suspended' | 'error'`)、`response.headers`(限流信息)、`request.body`、`reasoning`、`sources`、`suspendPayload`(工具审批挂起)、`runId`/`traceId` 等。
- 关键选项:`maxSteps`(默认 5)、`stopWhen`(用 AI SDK 的 `stepCountIs` 等)、`memory: { thread, resource }`、`structuredOutput: { schema, model?, errorStrategy, jsonPromptInjection }`、`requireToolApproval`(返回 `finishReason: 'suspended'` + `suspendPayload`)、`delegation`、`isTaskComplete`、`onIterationComplete`、`modelSettings`(temperature/maxOutputTokens/timeout 等,含 `totalMs`/`stepMs`/`firstChunkMs` 超时预算)、`providerOptions`。

### 1.3 `.stream()` 语义

来源:[Agent.stream()](https://mastra.ai/reference/streaming/agents/stream);源码 `packages/core/src/stream/base/output.ts:211`(`MastraModelOutput`)。

- 返回 `MastraModelOutput`:既可 `for await` 消费 `textStream` / `fullStream`(mastra 自有 ChunkType 流),也有 promise 式 getter(`text`、`usage`、`steps`、`finishReason`、`object`、`objectStream`、`elementStream`、`consumeStream()`、`status`)。一个对象同时满足"流式消费"和"await 最终结果"两种用法。
- 仅支持 AI SDK v5+(spec v2+)模型;v1 模型必须用 `.streamLegacy()`,框架自动检测版本不匹配并报错。
- 选项与 `generate()` 基本同构,另有 `includeRawChunks`、`untilIdle`(配合 background tasks 保持流开启)。

### 1.4 生命周期与 processors

来源:[Agent lifecycle](https://mastra.ai/docs/guides/agent-lifecycle)、[Processors](https://mastra.ai/docs/agents/processors)。

三层结构:**run**(一次 generate/stream)> **loop iteration**(一轮模型调用 + 工具执行)> **model step**(一次 provider 请求)。processor 钩子按序围绕每个 model step:`processInput`(仅初始一次)→ `processInputStep` → `processLLMRequest`(只改发给 provider 的 prompt,不落库)→ 流式响应中 `processOutputStream` → `processLLMResponse` → `processOutputStep` → 工具执行 → `processToolResult`;provider 报错走 `processAPIError`;最终化时 `processOutputResult`。`abort({ retry: true })` 触发带反馈的重试,由 `maxProcessorRetries` 封顶。

Processors 是 mastra 把 guardrails/memory/遥测挤出核心的核心机制——仓库自己的 `packages/core/AGENTS.md` 写着"加功能前先考虑能不能做成 processor"。

## 2. 模型路由

源码:`packages/core/src/llm/model/`;文档:[Model Providers](https://mastra.ai/models)、[Gateways](https://mastra.ai/models/gateways)、[MastraModelGateway](https://mastra.ai/reference/core/mastra-model-gateway)。

### 2.1 `'provider/model'` 字符串解析

- 入口 `resolveModelConfig()`(`resolve-model.ts:77`):接受 ① magic string(`'openai/gpt-5'`、`'openrouter/anthropic/claude-haiku-4.5'`)② 配置对象 `{ id, url?, apiKey?, headers?, api?: 'chat'|'responses' }` ③ 任何带 `specificationVersion` 的 LanguageModel 实例(v1–v4,未知版本但鸭子类型有 `doStream/doGenerate` 的也包一层)④ 动态函数。字符串与对象都实例化为 `ModelRouterLanguageModel`。
- `GatewayManager`(`gateways/gateway-manager.ts:69`)合并 **custom gateways 在前、default gateways 在后** 的链,按 id 去重(first-wins),集中做 `resolveModelId`:找 gateway → 按 gateway 前缀解析出 `providerId/modelId`(models.dev 无前缀;真网关形态是 `[gateway-id]/[provider]/[model]`)。
- 默认网关链(`gateways/defaults.ts:10`):`NetlifyGateway`、`MastraGateway`(mastra 自家托管网关 `gateway-api.mastra.ai`,走 `MASTRA_GATEWAY_API_KEY`)、`ModelsDevGateway`(models.dev 注册表,`provider-registry.json` 内置 **208 个 provider**,207 个来自 models.dev)。文档侧口径是 **"7618 models from 210 providers"**(models.md)——ticket 里的"40+ provider"是更早的数字,机制不变、规模已大得多。内置网关文档另列 Azure OpenAI、Merge、Neon、OpenRouter、Vercel。开发模式下注册表每小时自动刷新(`MASTRA_AUTO_REFRESH_PROVIDERS=false` 关闭),为 IDE 补全与 Studio 服务。
- 认证优先级:显式 `apiKey` > `gateway.resolveAuth()`(OAuth/bearer/headers)> `gateway.getApiKey()`(读环境变量,缺失时报错并指明该设哪个变量)。模型实例按 gateway 缓存,cache key 用随机 secret 做 HMAC(防 key 泄漏进遥测;`router.ts:490`)。
- **Model fallbacks**:`model: [{ model, maxRetries, modelSettings, providerOptions, headers }, …]`,逐项重试后切换,错误上下文沿链保留,流式兼容;每项自身也可以是动态函数。
- 自定义端点:`{ id, url }` 走 OpenAI-compatible(Chat Completions 默认,`api: 'responses'` 切 Responses API),覆盖本地模型(LMStudio/Ollama 类)。

### 2.2 `MastraModelGateway` 自定义网关

抽象基类(`gateways/base.ts`),表面极小:

- 属性:`id`(网关前缀)、`name`
- 方法:`fetchProviders()`(返回 `{ name, models[], apiKeyEnvVar, gateway, url? }` 表)、`buildUrl(modelId, envVars)`、`getApiKey(modelId)`、可选 `resolveAuth()`(返回 `{ apiKey?, bearerToken?, headers?, source? }`)、`resolveLanguageModel({ modelId, providerId, apiKey })`(通常用 `createOpenAICompatible(...).chatModel(modelId)` 实现)
- 注册:`new Mastra({ gateways: { custom: new MyGateway() } })` / `mastra.addGateway()`,模型 id 变成 `'custom/provider/model'`。

## 3. 与 Vercel AI SDK 的关系:1.0 后是互操作层

**接口底座仍在,运行时底座已撤。** 证据链:

1. **自有 agent loop**:`packages/core/src/loop/loop.ts` 的 `loop(LoopOptions)` 是执行核心,产出 `MastraModelOutput`;测试里把 `loop` 包成 AI SDK `generateText` 的签名去跑 `generateTextTestsV5` 测试套件(`loop/test-utils/generateText.ts:20`)——即 mastra 复刻了 AI SDK 的语义而非调用它。
2. **内部规范接口是 provider spec,不是 AI SDK 运行时**:`ModelRouterLanguageModel implements MastraLanguageModelV2`(`router.ts:111`),对内统一讲 `LanguageModelV2`;`MastraLanguageModel = V2 | V3 | V4`(`shared.types.ts:79`)。ticket 问的 `LanguageModelV3` 对应 AI SDK v6 的 provider spec(`@ai-sdk/provider-v6`)——mastra 用 `AISDKV5/V6/V7LanguageModel` 三套适配器把 v2/v3/v4 spec 的模型都转成内部 v2(`router.ts:409-419`),v1 走 legacy 包装。**当前 mastra 同时 vendored 了 4 个大版本的 `@ai-sdk/provider` 与一大批按版本别名的 provider 包**(`packages/core/package.json` 里 `@ai-sdk/openai-v5/v6/v7`、`@ai-sdk/provider-v4/v5/v6/v7` 等并存)——这是"跟随 AI SDK 生态"策略的直接重量。
3. **v1.0 迁移文档明示解耦**([upgrade-to-v1/agent](https://mastra.ai/reference/migrations/upgrade-to-v1/agent)):`stream()/generate()` 上的 `format: 'aisdk'` 参数被**移除**,AI SDK 格式转换挪到独立包 `@mastra/ai-sdk`,理由是改善 tree-shaking;`generateVNext`/`streamVNext`(AI SDK v5 过渡 API)删除,v5+ 成为标准实现;`prepareStep` 回调的消息从 AI SDK ModelMessage 改为 mastra 自有 `MastraDBMessage` 格式。
4. **互操作面(`@mastra/ai-sdk` 包)**: [`toAISdkStream(stream, { from: 'agent'|'network'|'workflow', version: 'v5'|'v6'|'v7', sendReasoning, … })`](https://mastra.ai/reference/ai-sdk/to-ai-sdk-stream) 把 mastra 流转成 AI SDK UI stream;[`chatRoute({ path: '/chat/:agentId', version })`](https://mastra.ai/reference/ai-sdk/chat-route) 一行注册与 `useChat()` 对接的 HTTP 端点(转发 `AbortSignal`,断连即中止);另有 `handleChatStream` / `networkRoute` / `workflowRoute` / `toAISdkMessages` / [`withMastra(model, { processors, memory })`](https://mastra.ai/reference/ai-sdk/overview)(反向:给纯 AI SDK 用户套上 mastra 的 processor/memory)。
5. **AI SDK 模型对象仍被一等接受**:`model: groq('gemma2-9b-it')` 可出现在任何接受 `"provider/model"` 字符串的位置,包括 fallback 数组(models.md)。

## 4. 多 agent 形态(只记录事实)

- **`.network()`**([reference](https://mastra.ai/reference/agents/network)):**已废弃,将在未来 major 移除**。路由 agent 循环调度 `agents`/`workflows`/`tools` 三类 primitive,返回 `MastraAgentNetworkStream`(network 专用 chunk 类型 + `status`/`result`/`object` promise)。
- **Supervisor / sub-agents**(替代者,`@mastra/core@1.8.0` 加入;[Subagents](https://mastra.ai/docs/subagents)、[迁移指南](https://mastra.ai/reference/migrations/network-to-supervisor)):不再用独立 API——父 agent 配 `agents: {...}`,**委派以工具调用形式发生在普通 agent loop 内**,直接用 `agent.stream()`/`agent.generate()`;父模型靠各 sub-agent 的 `description` 决定何时委派。配套能力:`delegation.onDelegationStart`(改 prompt/限 maxSteps/拒绝)、`onDelegationComplete`(`bail()` / `feedback` 进父记忆 / `resultText` 替换给父模型看的结果)、`messageFilter`(裁剪传给 sub-agent 的上下文)、`enableResultReferences`(后续委派引用前次结果原文);**memory 隔离**(sub-agent 收全量上下文,但只把委派 prompt+回复存入自己的记忆,每次委派新 thread);工具审批与 `abortSignal` 沿委派链传播;委派可挂为 background task 配合 `untilIdle`;版本覆盖(`versions.agents`)沿委派链传播。
- 其他相关形态(此处不展开):workflow 的 `.agent()` 步骤、`DurableAgent`、A2A/ACP 连接、`AgentController`(harness 方向的新API)。

## 5. Stored(DB 定义的)agents

来源:[Editor 文档](https://mastra.ai/docs/studio/editor);源码线索:`AgentConfig.rawConfig`("hydrated from a stored config",types.ts:1016)、`agent.ts` 的 `__markStoredVersionApplied`。

- **Editor(`@mastra/editor`)= "agent 的 CMS"**:TypeScript 代码定义默认值,协作者在 Studio 里改 instructions/tools,改动**作为 override 单独存储**,不动源码;`id`/`name`/`model` 永远归代码所有。
- **存储双轨**:默认存 DB(复用 Mastra storage,可用 `MastraCompositeStore` 分库),或 `source: 'code'` 存为仓库内 JSON 文件(如 `mastra/editor/agents/support-agent.json`),走 Git PR 评审。
- **版本化**:DB 后端有 draft/published;`mastra.getAgentById(id, { status: 'draft'|'published' } | { versionId })` 按请求选版本,也适用于 supervisor 调 sub-agent;REST `PATCH /api/stored/agents/:id`、Client SDK、`mastra.getEditor().agent.update()` 均可编程操作。
- 完全在浏览器里创建/管理的 stored agents 由托管产品 Agent Builder 承担。

## 6. 结论指向:轻量化的取舍含义

事实归纳成三个选项的代价/收益(决策不在本调研范围):

**A. 自建模型层(mastra 现状的全量版)**
得到:字符串路由、fallback 链、网关扩展点、自有 chunk 流。代价可见:mastra 为此维护了 208-provider 注册表(开发期每小时刷新)、网关链 + 认证解析 + HMAC 实例缓存(`router.ts` 667 行),以及**4 套 AI SDK provider spec 适配器**——对一个"极致轻量"框架,大头成本不在 loop 而在"跟进整个 provider 生态"。

**B. 以 AI SDK 为底座(1.0 前 mastra)**
省掉 loop 与流格式。但 v1 迁移文档记录了 mastra 离开的原因:流格式耦合(`format: 'aisdk'` 内嵌 → tree-shaking 差)、消息格式耦合(AI SDK ModelMessage 渗进回调)、大版本迁移时被迫双轨再拆除(`generateVNext` → 删除)。

**C. 双轨(mastra 实际选择):自有抽象 + AI SDK 仅作互操作包**
mastra 的证据表明这条路可行且是它们演进后的稳态。对轻量框架的两点压缩空间:
- mastra 的适配税主要来自同时支持 spec v1–v4;**锁定单一 spec 版本**(如只接受 `LanguageModelV3`)可以把适配层从 4 套砍到 0-1 套,`@ai-sdk/provider` 只是类型+协议包,不带运行时重量。
- 互操作(`toAISdkStream` / `chatRoute` 等价物)放独立可选包,核心零 AI SDK 运行时依赖——mastra 正是以 tree-shaking 为由把它拆出去的。

**Agent 抽象的最小表面(从 mastra 反推)**:
- 不变量核心:`id`、`instructions`、`model`、`tools` + `generate()` / `stream()` 两个入口;mastra 的其余 ~20 个字段全是可选模块,说明它们都不必进核心。
- 值得低价抄的两件事:**`DynamicArgument`(所有配置可传 `({ requestContext }) => T`)**——一个 union 类型换来多租户/动态选模型等表达力;**`stream()` 返回"既可 for-await 又可 await 最终结果"的输出对象**(`MastraModelOutput` 模式),一个类型同时服务流式与求值调用方。
- 扩展点只留一个就够:processors(input/output/error 钩子 + tripwire)。mastra 自己的仓库守则("先考虑做成 processor")说明它足以承载 guardrails、memory、限流等横切关注,避免它们长进核心。memory 则适合做成 processor 可消费的可选接口,而非 Agent 的必填概念。

## 附:主要来源

文档(均 2026-09-28 抓取):
- [Agent Class](https://mastra.ai/reference/agents/agent) · [generate()](https://mastra.ai/reference/agents/generate) · [stream()](https://mastra.ai/reference/streaming/agents/stream) · [Agent lifecycle](https://mastra.ai/docs/guides/agent-lifecycle)
- [Model Providers](https://mastra.ai/models) · [Gateways](https://mastra.ai/models/gateways) · [MastraModelGateway](https://mastra.ai/reference/core/mastra-model-gateway)
- [AI SDK 互操作:overview/withMastra](https://mastra.ai/reference/ai-sdk/overview) · [chatRoute()](https://mastra.ai/reference/ai-sdk/chat-route) · [toAISdkStream()](https://mastra.ai/reference/ai-sdk/to-ai-sdk-stream) · [v1 迁移:Agent](https://mastra.ai/reference/migrations/upgrade-to-v1/agent)
- [.network()](https://mastra.ai/reference/agents/network) · [Subagents](https://mastra.ai/docs/subagents) · [.network() → supervisor 迁移](https://mastra.ai/reference/migrations/network-to-supervisor) · [Editor/stored agents](https://mastra.ai/docs/studio/editor)

源码(`mastra-ai/mastra` @ `cceb9ab`,2026-09-27;均为 `packages/core/` 下):
- `src/agent/agent.ts`(10,470 行)、`src/agent/types.ts:687`(`AgentConfigBase`)、`:1087`(`AgentEditableFieldConfig`)、`:1098`(`AgentConfig`)
- `src/llm/model/router.ts:111`(`ModelRouterLanguageModel`)、`resolve-model.ts:77`、`shared.types.ts:79`、`gateways/{defaults,gateway-manager,base,mastra}.ts`、`provider-registry.json`
- `src/loop/loop.ts`、`src/loop/test-utils/generateText.ts:20`、`src/stream/base/output.ts:211`(`MastraModelOutput`)、`packages/core/package.json`(@ai-sdk 多版本别名)
