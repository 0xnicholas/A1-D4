# 模型层 (Model Layer)

> 来源:wayfinder ticket #9(决策:模型层策略)。本文件是模型子系统的架构规范。
> 决策记录见 `docs/adr/0004-model-layer-dual-track.md`;术语见 `CONTEXT.md`。

## 定位

**双轨**:核心自有的模型抽象与 agent loop,模型契约在**类型级**兼容 AI SDK 的 provider spec——用户把 `@ai-sdk/openai` 等生态包产出的模型实例直接传入,核心不依赖 AI SDK 运行时。与 AI SDK 的格式互操作(UI stream 转换、`useChat` 路由)收敛在独立的 AI SDK 互操作**能力包**中,核心对它零依赖。

## 模型契约

- 核心内 **vendor 最小结构类型声明**:当前一代 AI SDK provider spec 中实际被消费的接口子集(`specificationVersion` / `provider` / `modelId` / `doGenerate` / `doStream` + prompt 与流 part 类型,约百行纯类型)。核心零运行时依赖、零类型依赖;TS 结构类型使各 provider 包的实例天然满足契约。
- **锁定单一 spec 版本**。模型解析时硬断言 `specificationVersion`,不匹配即在解析期抛显式错误,指出该升级框架还是降级 provider 包。
- **版本跟随策略**:AI SDK 发布新一代 spec → 本框架升自己的 major,只支持新 spec;留在旧 provider 包的用户留在本框架旧 major。永不做多 spec 适配器。
- 漂移防护:CI 类型测试以 devDependency 中的真实 `@ai-sdk/provider` 对校 vendor 类型。

## model 字段形状

凡接受模型的位置(Agent 配置、结构化输出专用模型等),统一接受三种形状:

```ts
type ModelInput =
  | Model                                            // 满足模型契约的实例
  | Model[]                                          // fallback 链
  | ((ctx: RequestContext) => Model | Promise<Model>) // 动态解析
```

- **fallback 语义(初版保守)**:按数组顺序逐项尝试;仅在"尚未产出任何 chunk"的失败时切换下一项;流中途失败不切换、直接报错(部分输出已发给调用方,切换会产生拼接幻觉)。错误上下文沿链保留。
- **动态函数**:每次执行按请求上下文解析,一个 union 类型换来多租户、按 tier 选模型等表达力。

此形状由 [决策:Agent 核心抽象](https://github.com/0xnicholas/A1-D4/issues/10) 继承。

## Chunk 协议

- 核心定义**自有最小 chunk 类型集**(text-delta / tool-call / finish / usage 量级的小集合),是 `stream()` 输出、processors、workflow step 快照、observability 事件共用的流式词汇。
- 模型 spec 原生流 → chunk 协议的归一化层在核心内,保持薄。
- **核心不透出 AI SDK 流格式**;chunk → AI SDK UI stream 的转换器在互操作能力包。

## Provider 生态

- **无自有 provider SPI、无注册表、无 `'provider/model'` magic string。** AI SDK 生态的 provider 包就是插件机制;网关类需求(OpenRouter 等)由对应 provider 包承担。
- 自定义端点(Ollama / LMStudio / OpenAI-compatible 网关):用户自装 `@ai-sdk/openai-compatible` 类现成包,核心无特殊机制。
- 字符串路由(models.dev 目录 + 解析器)若做,是独立能力包——已登记地图 Not yet specified,路线图阶段再判断。

## AI SDK 互操作能力包

- 职责:chunk 协议 → AI SDK UI stream 的转换器(`toAISdkStream` 等价物);对接 `useChat()` 的 fetch 风格路由 handler(`chatRoute` 等价物,转发 `AbortSignal`)。
- 目标 **0 直接依赖**(自实现协议转换;CI 以 devDependency 的 `ai` 包做格式对校),上限 2 个且仅限类型/协议级包。

## 依赖预算

- **核心(含模型层)运行时依赖硬线 = 0**。模型层是全框架最不可能裁剪的子系统,正因如此它必须守住零依赖,否则"按需组合"名存实亡。
- 互操作能力包预算如上。所有数字按 ADR-0001 作内部 CI 回归参考(超预算 PR 亮黄灯),不对外承诺。

## 与其它子系统的关系

- **Agents(#10)**:继承 model 字段形状与 chunk 协议;agent loop 围绕模型契约构建。
- **Workflows(#11)**:step 边界 JSON 快照与流式事件复用 chunk 协议词汇。
- **Observability(#14,已定)**:`agent-step` span 的 model/provider/usage/finishReason 取自模型契约的 finish/usage chunk;见 `docs/architecture/observability.md`。
- **Memory(#12)**:如需 embedding 模型,复用同一契约模式(接受 AI SDK spec 的 EmbeddingModel 实例、vendor 结构类型),届时确认。
