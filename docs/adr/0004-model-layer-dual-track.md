# 模型层:双轨契约 + 单一 spec 版本 + 自有 chunk 协议

模型层是全框架最不可能裁剪的子系统。mastra 1.0 的演进验证了"双轨"的可行性与代价,我们采用其稳态形态——核心自有 agent loop / 流协议 / 模型抽象,模型契约在类型级兼容 AI SDK provider spec,AI SDK 互操作独立成能力包;同时裁掉它的两个重量来源:**锁定单一 spec 版本**(永不做多版本适配器;AI SDK 升 spec,我们升 major;模型解析时硬断言 `specificationVersion`),**不内置 provider 注册表与 `'provider/model'` 字符串路由**(降级为能力包候选)。类型契约以 vendor 最小结构类型落地,核心保持零运行时依赖;流式输出用自有最小 chunk 协议,不透出 AI SDK 流格式。

## Considered Options

- **完全自建 provider spec**:被否——切断 AI SDK provider 生态,每个 provider 都需自写/社区适配,对新框架是生态自杀。
- **AI SDK 为运行时底座**(mastra 1.0 前路线):被否——核心背 3 个直接依赖 / 17.7 MiB 安装树,且 mastra v1 迁移文档记录了三笔耦合账:流格式内嵌毁 tree-shaking、消息格式渗入回调、大版本迁移被迫双轨再拆除。
- **peer 依赖 `@ai-sdk/provider`**(而非 vendor 结构类型):被否——vendor 的只是约百行、在 spec major 内冻结的纯类型,CI 对校 + 运行时硬断言足以防漂移;核心字面零依赖更贴"按需组合"。
- **透传/复用 AI SDK 流格式**:被否——核心反正需要自有流式词汇(processors、workflow 快照、observability 都消费流),透出外部格式等于让核心词汇被绑架;mastra 的 `format: 'aisdk'` 教训在案。

## Consequences

- model 字段统一接受 `实例 | fallback 数组 | 动态函数`;fallback 仅在产出任何 chunk 前的失败时切换。Agent 核心抽象(#10)继承此形状。
- embedding 模型(Memory,#12)届时复用同一契约模式。
- 字符串路由能力包进入地图 Not yet specified,路线图阶段再判断做不做。
- **修订(M5 AI SDK 互操作包设计冻结,2026-09-30)**:`@balsa/ai-sdk` 设计冻结(包面 / 目标协议与漂移纪律 / 转换器与帧子集 / chatRoute / 挂起与订阅流表达 / 历史回读 / 裁单),依据 [决策:AI SDK 互操作包](https://github.com/0xnicholas/balsa-framework/issues/77) 决议评论与 `docs/architecture/model.md`「AI SDK 互操作能力包」节:
  - **目标协议**:`ai@7` 代 UI message stream 词汇表 + 线级 `x-vercel-ai-ui-message-stream: v1` 头;**单一代、无 `version` 选项、不做多代适配器**(本 ADR「锁定单一 spec 版本」推广到 UI stream 协议);已发帧子集封闭,可小于目标词汇、不得超出(客户端白名单逐帧解析,未知 `type` 整流抛错)。
  - **对校与预算**:`ai` 精确钉 devDependencies(`7.0.123`),升级为有意 PR;三条对校 = 帧联合对 `UIMessageChunk` 类型可赋值 + 产物 SSE 字节经官方 `uiMessageChunkSchema` / `readUIMessageStream` 往返 + 响应头常量全等;运行时依赖硬线 = 0(数字口径归 `deps-budget.json`)。
  - **转换器**:`toAISdkStream` 只吃 `AsyncIterable<Chunk>`、只产体帧(消息级 `start` / `finish` 归调用方);`tool-call` 只发 `tool-input-available`(`providerExecuted` / `dynamic` 均 true);`tool-result` 按 `isError` 分流;每 step 的 `finish` → `finish-step` 保持原序;无法重建的帧(reasoning / 参数增量 / approval / source / file / custom / data-* / abort 等)一律不外发。
  - **路由与挂起**:`createChatRoute` 为 Web 标准 handler,run 输入 memory 权威(尾条 user 消息 + thread recall,不与客户端全量回放双喂);挂起以 `finishReason: 'other'` + `messageMetadata.suspended` 表达,**不合流 `tool-approval-*`**(逐 approvalId 的流内审批与 run 级挂起是两套机制,且决定为单布尔 N:1);`resume: true` 恢复端点、无状态全量 `UIMessage[] → ModelMessage[]` 转换均裁,重开条件随节。
  - **裁单**:反向互操作(`withMastra` 类)裁——方向倒置会把 AI SDK 流 part 词汇塞进核心 seam;workflow / network 路由裁;订阅流表达为一个订阅一条持续 UI 消息,逐 run 切分不做(订阅通道无 run 边界,step cap 与挂起同形)。

(来源:wayfinder ticket #9)
