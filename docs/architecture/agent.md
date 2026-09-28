# Agent 核心抽象

> 来源:wayfinder ticket #10(决策:Agent 核心抽象)。本文件是 Agent 子系统的架构规范。
> 决策记录见 `docs/adr/0005-agent-core-surface.md`;术语见 `CONTEXT.md`。

## 定位

Agent 是框架的核心执行单元:把 name、instructions、model、tools 包装成可 `generate()` / `stream()` 的对象。词汇与体验对齐 mastra,交付遵守轻量轴:**定义表面刻意最小,横切能力一律走 Processor,重能力挂在包边界与子系统协作上**(ADR-0005)。字段取舍的总原则是可逆性不对称——后加可选字段是 minor,删字段是 major,所以默认砍、证明需要再加。

## 定义表面

```ts
interface AgentConfig {
  name: string                                   // 必填,唯一标识(不单设 id)
  instructions: DynamicArgument<string>          // 必填
  model: ModelInput                              // 必填,形状继承模型层规范
  tools?: DynamicArgument<Record<string, Tool>>  // 可选
  description?: DynamicArgument<string>          // 可选,as-tool 组合时给上游模型看
}
```

- **动态参数**:所有字段接受 `T | ((ctx: RequestContext) => T | Promise<T>)`,每次执行按请求上下文解析。`RequestContext = { signal: AbortSignal, runId: string, ...用户 per-call 开放属性袋 }`,纯对象,无 `Agent<TContext>` 泛型。
- **instructions 仅 string**:mastra 的 string[] / SystemMessage / providerOptions 联合全砍,provider 级能力(缓存控制等)证明需要后再加。
- **tools 容器**:`Record<string, Tool>`,键即工具名,构造期完成唯一性校验。Tool 自身定义(Standard Schema 入参、execute 签名)见「Tools/MCP 抽象」规范(`docs/architecture/tools.md`)。
- **memory**:一等可选字段。本规范只钉三件事:字段存在、可选、读写时机固定(模型调用前 recall、每个 step 后 save);接口方法与 thread/resource 语义归「决策:Memory 语义」。
- **组合根关系**:独立 `new Agent(...)` 是一等用法,不强制注入;横切依赖(tracer 等)经组合根分发时 Agent 被动接受,不感知其存在。

砍单与承载缝(砍的是字段位置,不是能力):

| 砍单项 | 承载缝 |
| --- | --- |
| scorers / evals | Processor 或独立 scorer 消费 run 结果;Evals 体系在雾中 |
| voice / browser / channels / workspace / skills | 能力包;Voice/Channels/Workspaces 已在地图 Out of scope |
| editor / rawConfig | Studio 出域 |
| durable / pubsub / backgroundTasks / signals / goal / notifications | 「决策:Harness 语义集」——Harness 持有 agent,不是 agent 持有 Harness |
| defaultOptions / metadata | 用户一行包装 |
| hooks / transform / maxRetries | Processor + 模型 fallback 链 |
| 标题生成 | 应用层职责 |

## 执行语义

- **输入**:`string | Message[]`,Message **直通模型契约的 vendor prompt 类型**——不发明自有消息格式,内部流转与 Memory 存储同一格式;spec 升级时格式跟随,由模型层的 major 跟随策略兜底。
- **输出对象**:`stream()` 返回的对象同时支持两种消费:`for await` 消费 chunk 协议流,`await` 其 promise getter(`text` / `object` / `toolCalls` / `toolResults` / `usage` / `steps` / `finishReason`)拿最终结果。**`generate()` 内部 = `stream()` + await 终值,单一代码路径**,不存在双实现。
- **术语两层**:**run**(一次 generate/stream 调用的完整执行)> **step**(一轮模型调用 + 工具执行);mastra 的第三层 model step 不收。
- **finishReason**:`'stop' | 'length' | 'tool-calls' | 'error'`(`tool-calls` 表示 maxSteps 耗尽时模型仍要求工具调用;审批挂起裁出核心,故无 `'suspended'`)。
- **steps[]**:每步的 text / toolCalls / toolResults / usage 轻量记录,调试、Observability、Workflow 快照共用;`usage` 另有全 run 累计值。
- **执行选项**:`maxSteps`(默认 5)/ `modelSettings`(temperature 等透传袋)/ `providerOptions`(透传)/ `signal`(AbortSignal,沿工具调用与动态参数解析传播)。
- **structuredOutput**:一等支持 `structuredOutput: { schema }`,schema 走 Standard Schema 契约(ADR-0003),结果落 `object`;校验策略固定 strict(失败即报错,不做 errorStrategy 多选一)。

## Agent loop

- **归属**:loop 是 Agent 子系统内部实现,围绕模型契约构建(继承「决策:模型层策略」);Workflows 不复用 agent loop,共享 chunk 协议与 step 词汇即可。
- **停止条件**:模型返回不含 tool-call 即停;`maxSteps` 封顶。不做 stopWhen DSL。
- **工具错误**:execute 抛错捕获为 error 工具结果**回喂模型**,由模型自行恢复或放弃,run 不中止;需要硬停的场景经 Processor 实现。
- **审批 / 挂起**:不在核心。挂起-恢复需要 loop 快照,与 Harness 的 durable 是同一笔机器,已移交「决策:Harness 语义集」统一裁决。

## 扩展点:Processor

Processor 是 Agent 的**唯一横切扩展点**(ADR-0005):guardrails、evals、脱敏、限流等不得以字段形式焊进 Agent 类。v1 三钩,有序执行:

- `processInput` — run 开始一次,可改写输入消息
- `processOutputStep` — 每个 step 完成后,可见可改 step 记录
- `processError` — provider / 工具错误时,观察并可替换错误;不做 abort/retry 机制

chunk 级流式 processor(processOutputStream 类)裁出 v1,保留向后扩展位。Observability 的 tracer 挂钩是内部缝,形态归「决策:Observability 形态」,不占 Processor 名额。

## 多 agent 组合

**核心零内建协议**:Agent 不认识 sub-agent。组合靠 as-tool 模式兜底——`description` + `generate` 签名天然是一个 Tool 的 execute,signal 手动透传,一行包装完成。supervisor 式委派协议(agents 字段、delegation 钩子、memory 隔离、result references)是否/何时内建,归「决策:多 agent 协作语义」。

## 与其它子系统的关系

- **模型层(#9,已定)**:继承 `ModelInput` 三形状、chunk 协议、零依赖红线。
- **Memory(#12)**:本规范钉住字段存在性与 recall/save 时机;接口与 thread/resource 语义归它。
- **Tools/MCP(#13,已定)**:容器形状 `Record<string, Tool>`;Tool 定义与 MCP 能力包见 `docs/architecture/tools.md`。
- **Workflows(#11)**:不复用 agent loop;chunk / step 词汇共用。
- **Observability(#14)**:span 挂在 run / step / 模型调用上,形态归它。
- **Harness(#18)**:审批/挂起、durable、后台能力归它,是「决策:Agent 核心抽象」的正式输入。

## 依赖预算

核心(含 Agent)运行时依赖硬线 = 0,与模型层同一红线(ADR-0001 作内部 CI 回归参考)。
