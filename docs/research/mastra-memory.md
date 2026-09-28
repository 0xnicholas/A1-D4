# 调研:Mastra Memory 子系统

> 研究 ticket:#5。目的:为 A1-D4(极致轻量 TS/Node agent 框架)的 memory 设计提供事实基础。
> 本文只呈现事实与轻量化的取舍含义,不做架构决策。
> 调研日期:2026-09-28。当时最新稳定版 `@mastra/memory@1.32.1`(2026-09-24 发布),1.0 稳定版发布于 2026-01-20。

## TL;DR

Mastra 的 memory 以 **thread(会话)/ resource(用户或实体)双标识**为骨架:每条消息同时属于一个 thread 和一个 resource。1.0 起 working memory 与 semantic recall 默认 **resource 作用域**(跨线程共享),而 Observational Memory(OM)默认 thread 作用域,且 OM 的 resource 作用域已于 2026-09 被官方 deprecated。OM(2026-02 随 `@mastra/memory@1.1.0` 引入)目前是文档标注的 "Recommended",但仍是 opt-in(`observationalMemory: false` 为默认),它是一个由两个后台 LLM agent(Observer/Reflector)驱动的三层压缩系统,给存储适配器接口增加了约 14 个方法——这是 mastra memory 全部复杂度的一半以上。对轻量框架而言:必须保留的语义是 thread/resource 模型、消息持久化 + 最近 N 条窗口、单一消息格式 + 可分页的 `recall()` 查询、以及一个小而正交的存储适配器核心(约 10 个方法);OM、semantic recall(向量库 + embedder 依赖)、resource 级 working memory(需第三张表)、存储内 thread 复制都可以裁剪或延后。

## 来源

主要一手来源:

- 官方文档(v1 现行):[Memory overview](https://mastra.ai/docs/memory/overview)、[Message History](https://mastra.ai/docs/memory/message-history)、[Working Memory](https://mastra.ai/docs/memory/working-memory)、[Semantic Recall](https://mastra.ai/docs/memory/semantic-recall)、[Observational Memory](https://mastra.ai/docs/memory/observational-memory)、[Memory Processors](https://mastra.ai/docs/memory/memory-processors)、[Storage](https://mastra.ai/docs/memory/storage)
- 参考文档:[Memory Class](https://mastra.ai/reference/memory/memory-class)、[recall()](https://mastra.ai/reference/memory/recall)、[cloneThread()](https://mastra.ai/reference/memory/cloneThread)、[v1 memory 迁移指南](https://mastra.ai/reference/migrations/upgrade-to-v1/memory)
- 源码(mastra-ai/mastra `main` 分支,2026-09-28 拉取):
  - `packages/core/src/storage/domains/memory/base.ts` — `MemoryStorage` 抽象类(存储适配器的 memory 域接口)
  - `packages/core/src/storage/domains/memory/inmemory.ts` — 内存参考实现(1255 行)
  - `packages/core/src/storage/types.ts` — `StorageListMessagesInput` 等输入输出类型
  - `packages/core/src/memory/types.ts`、`packages/core/src/agent/message-list/state/types.ts` — `StorageThreadType` / `MastraDBMessage`
  - `packages/memory/src/index.ts` — `Memory` 类(3936 行)
  - `packages/memory/CHANGELOG.md` + npm registry 发布时间(用于版本/时间线核实)

## 1. Thread / Resource 作用域模型

### 概念

- **thread** = 一次会话;**resource** = 用户或实体的稳定标识。每条消息落库时同时带 `threadId` 和 `resourceId`。([overview](https://mastra.ai/docs/memory/overview))
- 调用时传入:`agent.generate(msg, { memory: { thread: "conversation-123", resource: "user-456" } })`。thread 可以只传 id 字符串,或带 `title` / `metadata` 的对象。([message-history](https://mastra.ai/docs/memory/message-history))
- thread 与 message 在调用 `generate()`/`stream()` 时自动创建,也可手动 `createThread()` / `saveMessages()`。
- 每个 thread 有一个 owner(`resourceId`)。overview 称"创建后不可更改",但源码中已存在 `updateThreadResourceId()`(`MemoryStorage` 基类提供默认实现:先改 thread,再批量迁移消息,失败时做补偿回滚,补偿失败则显式抛出"ownership 可能分裂"的错误)。调用方负责授权,该方法不做 ownership 检查。(`packages/core/src/storage/domains/memory/base.ts`)
- **memory 系统不做访问控制**:查询前应用层必须自行校验当前用户有权访问该 `resourceId`。(message-history 页 Warning)

### 各特性的作用域默认值(重要,且 ticket 背景需要修正)

| 特性 | 默认 scope | 备注 |
|---|---|---|
| Working memory | `resource`(1.0 起) | 1.0 前为 `thread`;resource 级存 `mastra_resources` 表,仅 libsql/pg/upstash/mongodb 适配器支持 |
| Semantic recall | `resource`(1.0 起) | 跨该用户所有线程检索;`scope: 'thread'` 可退回 |
| Observational Memory | `thread` | `resource` scope 曾标 experimental,**2026-09 在 1.32.2 中正式 deprecated**(PR [#24933](https://github.com/mastra-ai/mastra/pull/24933)):官方理由是 prompt caching 效果差、多线程并行时任务连续性差;官方建议改用 `retrieval` 或 resource 级 working memory 实现跨线程连续性 |

即:ticket 背景中"mastra 1.0 后 resource-scoped 为默认"对 working memory / semantic recall 成立,但**不适用于 OM**——OM 始终 thread-scope 默认,且其 resource scope 已被放弃。这是一个重要的信号:mastra 自己也在从"一切跨线程共享"往回收。

### 多 agent 场景

- 委托(delegation)时自动隔离:每次委托生成全新 `threadId` + 确定性 `resourceId = {parentResourceId}-{agentName}`,所以 subagent 每轮干净开始、但 resource 级记忆跨委托保留。
- 直接调用时,两个 agent 用相同 `resourceId` 即共享 resource 级 WM 与向量 embedding;用相同 `threadId` + `resourceId` 则共享完整消息历史。([overview](https://mastra.ai/docs/memory/overview))

## 2. 四种 memory 机制

### 2.1 Message history(消息历史)

- 最基本的一层,默认启用。`lastMessages` 默认 **10 条**(1.0 前为 40)。自动把最近 N 条注入上下文;新消息在 LLM 响应后自动持久化。([message-history](https://mastra.ai/docs/memory/message-history)、[v1 迁移指南](https://mastra.ai/reference/migrations/upgrade-to-v1/memory))
- 存储格式为 `MastraDBMessage`(1.0 由 `MastraMessageV2` 改名而来,`MastraMessageV3` 已删除):

```ts
// packages/core/src/agent/message-list/state/types.ts
type MastraDBMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'signal';
  createdAt: Date;
  threadId?: string;
  resourceId?: string;
  type?: string;
  content: MastraMessageContentV2; // { format: 2; parts: [...]; metadata?; ... }
};
```

- 注意 role 里有 `'signal'`(框架内部信号消息);`recall()` 有 `hideSignals` 参数控制是否返回信号消息。轻量实现可以不要 signal 概念。

### 2.2 Working memory(工作记忆)

- 本质:**一块持续维护的 Markdown 文本或 JSON 对象**,作为 system message 注入(或经 `useStateSignals` 作为 state signal 注入),agent 通过 `updateWorkingMemory` tool 更新。用于用户画像、偏好、当前目标等"永远相关"的小数据。([working-memory](https://mastra.ai/docs/memory/working-memory))
- 两种定义方式(互斥):
  - `template`(Markdown 模板):**replace 语义**——每次更新必须给完整文本;
  - `schema`(Zod / JSONSchema):**merge 语义**——只给要改的字段,对象深合并、字段设 `null` 删除、数组整体替换。
- 1.0 移除了 `use: 'text-stream'` 模式,只保留 tool-call 模式。
- scope:`resource`(默认,存 `mastra_resources` 表,要求适配器实现 resource 方法)/ `thread`(存 `thread.metadata.workingMemory`,任何适配器都行)。
- 支持 read-only 模式(路由 agent / subagent 只读引用);支持编程式写入(`createThread` 的 metadata、`updateThread`、`updateWorkingMemory()`)。
- OM 开启 `observation.manageWorkingMemory` 后可由 Observer 托管 working memory 更新,主 agent 不再调用 WM tool。

### 2.3 Semantic recall(语义召回)

- 即对消息历史做 RAG:新消息先 embed → 查向量库取 topK 相似消息(可带前后文窗口)→ 注入上下文;响应后新消息再 embed 落向量库。([semantic-recall](https://mastra.ai/docs/memory/semantic-recall))
- **1.0 起默认关闭**(迁移指南与 Memory Class reference 均写明 `Default: false`;semantic-recall 文档页仍残留"enabled by default"的旧表述,两处矛盾,以迁移指南/reference 为准)。默认 topK=4、messageRange={before:1, after:1}(1.0 基于 RAG 研究调优;旧默认 topK=2、range={2,2})。
- 硬依赖:vector store + embedder。支持 17+ 向量库适配器;embedder 可用 model router 字符串(如 `openai/text-embedding-3-small`)或 AI SDK embedding model,另有本地 `@mastra/fastembed`。
- 性能注意:每轮调用多一次 embed + 一次向量查询;实时语音等低延迟场景建议关闭。

### 2.4 Observational Memory(OM,观察记忆)

- 引入时间:`@mastra/memory@1.1.0`,npm 发布时间 **2026-02-04**(PR [#12599](https://github.com/mastra-ai/mastra/pull/12599));1.0 发布于 2026-01-20,即 OM 是 1.0 后两周加入的。当前文档 overview 将其标为 **"(Recommended)"**,但它仍是 opt-in(`Memory` 构造参数默认 `observationalMemory: false`)。所以准确表述是"2026-02 起引入并被官方推荐",而非"默认开启"。
- 机制:**两个后台 agent** —— Observer 与 Reflector —— 把历史压缩成带优先级/时间戳的观察日志:
  1. **Recent messages**:原始最近历史;
  2. **Observations**:消息 token 数超阈值(默认 30,000)时 Observer 把旧消息压缩成观察(典型压缩比 5–40×),被观察的消息移出上下文;
  3. **Reflections**:观察 token 数超阈值(默认 40,000)时 Reflector 再压缩合并。
- **Async buffering 默认开启**:每积累 `bufferTokens`(默认 0.2 × messageTokens,即约每 6k token)在后台预计算观察 chunk;到阈值时 buffer "激活",agent 不停顿。跟不上时 `blockAfter`(默认 1.2×)强制同步观察。还有 `bufferOnIdle`、`activateAfterIdle`(可设为 `'auto'`,按 provider 的 prompt cache TTL 选择 5min/1h/24h)、`activateOnProviderChange` 等围绕 **prompt cache 友好性**的激活策略。
- token 计数:`tokenx` 本地估算 + 图片的 provider-aware 启发式;估算结果缓存进 `part.providerMetadata.mastra`。
- 模型:默认 `google/gemini-2.5-flash`;Observer/Reflector 可分别配;`ModelByInputTokens` 按输入 token 数分档选模型(1.10.0 加入)。
- **Retrieval 模式**:`retrieval: true` 时每个 observation group 记录源消息 id range(`startId:endId`),agent 获得一个 `recall` 工具可翻原始消息;`retrieval: { vector: true }` 再加语义搜索(复用 Memory 的 vector/embedder);`scope: 'thread'|'resource'` 控制工具可浏览范围。
- **Extractors**:在观察/反思时顺手做结构化抽取(zod schema),内置 current task / suggested response / thread title;`WorkingMemoryExtractor` 实现 OM 托管 WM。
- 存储支持:**仅 pg / libsql / mongodb / convex 四个适配器**实现 OM;适配器有 `supportsObservationalMemory` 能力标志。OM 需要 `listMessagesByResourceId`(跨线程列消息)等额外存储方法。
- 生命周期:后台循环在 `agent.generate()` 返回后仍在写库;`memory.settled()` 用于在关闭存储连接前 drain 后台工作(这是后台机制带来的典型运维负担)。
- 衍生能力:`summarizeConversation()` / `memory.summarizeThread()`(一次性总结,复用 Observer 管线但不写回,也不需给 agent 挂 OM);thread title 生成;temporal gap markers(>10 分钟间隔插入时间提示)。
- 官方定位:"In practical terms, OM replaces both working memory and message history, and has greater accuracy (and lower cost) than Semantic Recall."(OM 文档页)

## 3. Thread cloning

- `memory.cloneThread({ sourceThreadId, ... })`:复制 thread 及其消息,返回 `{ thread, clonedMessages, messageIdMap }`;若不需要消息内容用 `copyThread()`(不加载消息到内存,适配器可用 `INSERT … SELECT` 在库内完成)。([cloneThread reference](https://mastra.ai/reference/memory/cloneThread))
- 过滤:`options.messageLimit`(最近 N 条)、`options.messageFilter = { startDate, endDate, messageIds }`。
- 克隆 thread 的 metadata 带 `clone: { sourceThreadId, clonedAt, lastMessageId }`。
- 联动行为:开启 semantic recall 时自动为克隆消息重建 embedding;working memory 按 scope 复制(thread scope / 跨 resource)或共享(resource scope 同 resource);OM 开启时克隆当前 generation 的 OM 记录并重映射内部消息 id(旧 generation 不复制,in-progress 标志重置)。
- 存储层:`copyThread` 与 `cloneThread` 在 `MemoryStorage` 基类里互相 fallback——适配器只需实现其中一个。

## 4. `recall()` API

- 1.0 由 `query()` 改名而来;`rememberMessages()` 被合并删除;返回值简化为 `{ messages: MastraDBMessage[] }`(源码实际还返回 `total/page/perPage/hasMore/usage`);`format` 参数删除,UI 格式转换移到 `@mastra/ai-sdk/ui` 的 `toAISdkV5Messages()`。([v1 迁移指南](https://mastra.ai/reference/migrations/upgrade-to-v1/memory)、[recall reference](https://mastra.ai/reference/memory/recall))
- 入参直接对齐存储层 `StorageListMessagesInput`:

```ts
// packages/core/src/storage/types.ts
type StorageListMessagesInput = {
  threadId: string | string[];
  resourceId?: string;              // 提供时校验 thread 归属该 resource
  perPage?: number | false;         // false = 取全部
  page?: number;                    // 0 起
  orderBy?: { field: 'createdAt'; direction: 'ASC' | 'DESC' };
  filter?: { dateRange?: { start?; end?; startExclusive?; endExclusive? };
             metadata?: Record<string, string|number|boolean|null> }; // 浅层标量 AND
  includeTotal?: boolean;           // false 时跳过 COUNT(*)
  include?: { id; threadId?; withPreviousMessages?; withNextMessages? }[];
};
// recall() 额外加:threadConfig(覆盖 lastMessages/semanticRecall 等)、
// vectorSearchString(语义搜索)、hideSignals
```

- 实现细节(`packages/memory/src/index.ts` 的 `recall()`):`perPage` 缺省取 `lastMessages`;未指定 orderBy 且限量时按 DESC 取**最新**再反转为时间正序(修过"lastMessages: 64 返回最旧 64 条"的 bug);`vectorSearchString` + `threadConfig.semanticRecall` 走向量检索再按 id include 回取。

## 5. 存储层依赖:memory 域适配器接口的形状

Mastra 的存储按**域(domain)**划分(memory / workflows / observability / scores / ...),一个适配器实现一个或多个域;`MastraCompositeStore` 可把不同域路由到不同后端。([storage 文档](https://mastra.ai/docs/memory/storage))

memory 域的接口 = 抽象类 `MemoryStorage`(`packages/core/src/storage/domains/memory/base.ts`,727 行)。官方内存参考实现 `inmemory.ts` 共 1255 行、约 30 个方法,其中一半以上只为 OM 服务。

**必须实现的抽象方法(10 个):**

| 方法 | 作用 |
|---|---|
| `getThreadById` / `saveThread` / `updateThread` / `deleteThread` | thread CRUD |
| `listThreads` | 按 resourceId / metadata 过滤 + 分页 + 排序 |
| `listMessages` / `listMessagesById` / `saveMessages` / `updateMessages` | 消息查询(分页/过滤)与读写 |

**有"默认抛错"实现的可选方法(按需实现):**

- resource 级 working memory:`getResourceById` / `saveResource` / `updateResource`(对应 `mastra_resources` 表)
- `deleteMessages`、`listMessagesByResourceId`(OM resource scope 与评测用)
- OM 专用约 14 个方法:`getObservationalMemory` / `initializeObservationalMemory` / `updateActiveObservations` / `updateBufferedObservations` / `swapBufferedToActive` / `createReflectionGeneration` / `updateBufferedReflection` / `swapBufferedReflectionToActive` / 4 个 in-progress flag setter / `insertObservationalMemoryRecord` / `clearObservationalMemory` / `setPendingMessageTokens` / `updateObservationalMemoryConfig`
- `copyThread` / `cloneThread`(互为默认实现)

**能力标志(capability flags):**`supportsObservationalMemory`、`supportsPartialThreadUpdate`——上层按标志降级行为(如旧适配器的 `patchThread` 回填逻辑)。

**实体与表:**

```ts
type StorageThreadType   = { id; title?; resourceId; createdAt; updatedAt; metadata? };
type StorageResourceType = { id; workingMemory?; metadata?; createdAt; updatedAt };
// 表:mastra_threads / mastra_messages / mastra_resources / mastra_observational_memory
```

基类还内置:metadata key 校验(防 SQL 注入与原型污染)、分页参数校验、`updateThreadMetadata` 的进程内 per-thread 串行化(promise 队列;跨进程原子性留给适配器覆盖)。

**默认存储:** `Memory` 不传 `storage` 时默认 `DefaultStorage`——实为 `LibSQLStore` 的别名(`stores/libsql/src/storage/index.ts`),即"零配置"也会落一个 `file:memory.db`。另有测试用的纯内存实现。

## 6. Memory processors(装配方式)

- 给 agent 配了 `memory` 后,Mastra 自动把三个 processor 装进 agent 的处理管线:`MessageHistory`(输入侧取历史、输出侧落库)、`SemanticRecall`(输入侧向量检索、输出侧建 embedding)、`WorkingMemory`(输入侧注入)。1.0 起 `processors` 配置从 `Memory` 移到 Agent 层。([memory-processors](https://mastra.ai/docs/memory/memory-processors))
- 执行顺序:输入侧 memory processors 最先,输出侧最后——**guardrail `abort()` 时消息不会落库**(安全默认)。这个"先过滤、后持久化"的顺序语义值得轻量框架保留。

## 7. 对轻量 memory 的取舍含义

### 必须保留的语义

1. **thread / resource 双标识**。这是整个模型的骨架:消息按 thread 隔离、按 resource 共享;thread 有 owner。成本极低(thread 表一个 `resourceId` 列、消息表一个 `resourceId` 列),但决定了上层所有共享语义。注意 mastra 的教训:resource 级共享有用(WM/语义召回默认 resource),但"跨线程合并压缩历史"(OM resource scope)被实践证明问题大而回滚——轻量框架应从 thread 隔离起步,把 resource 共享只用于小的结构化状态。
2. **消息持久化 + 最近 N 条窗口**(message history)。唯一默认开启的机制;自动保存 + 自动注入。
3. **单一消息格式 + 一个查询入口**。mastra 1.0 的方向就是收敛:一种 DB 格式(`MastraDBMessage`)、一个 `recall()`(分页、时间过滤、按 id 取上下文)。轻量版可以是:`recall({ threadId, before?, limit? })` 级别的分页查询,返回直接可喂给模型的消息。
4. **小而正交的存储适配器核心**:thread CRUD + 消息 list/save(带分页与排序)+ 可选 delete,约 8–10 个方法即可覆盖 message history + 手动查询 + 简单 WM(thread 级,存 thread metadata)。mastra 接口的膨胀(30 方法)几乎全来自 OM 与 resource 表。
5. **持久化时机语义**:输入过滤先于模型调用、输出过滤先于落库(guardrail abort → 不写库)。

### 可裁剪或延后的

1. **OM 整体延后**。它的代价:两个后台 LLM agent、buffering 状态机(buffered→active 的原子 swap、4 个 in-progress flag)、14 个存储方法、token 估算与缓存、模型分档、`settled()` 生命周期管理。轻量替代路径(按递增复杂度):
   - 什么都不做:`lastMessages` 截断;
   - 同步 summarize-and-truncate:超阈值时用主模型一次性总结旧消息、替换上下文(mastra 自己的 `summarizeConversation()`/`summarizeThread()` 证明"Observer 管线的一次性、非持久化版本"可以独立存在);
   - 真要长期记忆,再考虑后台压缩——且先做 thread scope(官方已弃 resource scope)。
2. **Semantic recall 作为可选模块**:默认关闭(mastra 1.0 也是),因为它引入 vector store + embedder 两个依赖和每轮一次额外网络调用。保留 seam(消息落库后可挂 embedding hook)即可。
3. **Resource 级 working memory 可简化为 thread 级**:省掉第三张表和 3 个适配器方法;代价是用户画像不跨会话。也可以反过来只做 resource 级(如果目标场景是单用户助手)——但不要两个都做。
4. **Thread cloning 延后**:语义本身简单(复制行 + 新 id + clone metadata),但非核心路径;存储内复制(`copyThread`)更是优化。
5. **避免后台写**:OM 的 `settled()` 存在本身就说明后台 memory 写入带来连接生命周期问题;轻量框架应尽量让所有写入发生在请求内。
6. **访问控制留给应用层**:与 mastra 一致(memory 不 enforce 授权),轻量框架只需在文档里写明。

## 附:关键时间线(以 npm 发布时间核实)

| 时间 | 事件 |
|---|---|
| 2026-01-20 | `@mastra/memory@1.0.0`:`query()`→`recall()`;WM/语义召回默认 resource scope;`lastMessages` 默认 40→10;语义召回改为默认关闭;`MastraMessageV2`→`MastraDBMessage` |
| 2026-02-04 | `@mastra/memory@1.1.0`:引入 Observational Memory(PR #12599) |
| 2026-03-24 | 1.10.0:OM 按输入 token 分档选模型 |
| 2026-09-24 | 1.32.x:OM `scope: 'resource'` deprecated(PR #24933);当前最新稳定 1.32.1 |
