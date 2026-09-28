# Memory 语义

> 来源:wayfinder ticket #12(决策:Memory 语义)。本文件是 Memory 子系统的架构规范。
> 决策记录见 `docs/adr/0007-memory-semantics.md`;术语见 `CONTEXT.md`。

## 定位

Memory 是框架的记忆子系统:**语义层薄自研**——thread/resource 身份 + 消息历史 + 可选工作记忆,存储走 port、默认内存实现、核心零依赖。重机制不进核心:语义召回(向量 RAG)延后、留 seam;OM 类后台压缩出本地图范围;外部记忆系统经能力包桥接,**bunfold**(TencentDB-Agent-Memory fork,MIT)为头号桥接候选,归路线图阶段判断。供给策略与模型层同构(核心零依赖契约 + 生态直通 + 能力包);依据是候选开源记忆系统(mem0/Zep/Letta/bunfold)全是 server 形态或 hosted API,而语义层薄到没有更轻的可采用对象(调研 #5;#12 决议评论中的 bunfold 探查)。

## 身份模型:thread / resource 双标识

- 每条消息、每个 thread 都同时带 `threadId` 与 `resourceId`;thread 有 owner(resourceId)。
- **memory 子系统不做访问控制**:查询前应用层必须自行校验当前用户有权访问该 resourceId(与 mastra 一致,文档写明)。
- 不提供所有权迁移 API(mastra 的 `updateThreadResourceId` 带补偿回滚逻辑,砍掉);需要时应用层删旧建新。
- per-call 传递 = 显式执行选项,两者必填,缺一则调用期显式报错:

```ts
agent.generate(input, { memory: { thread: 'id' | { id, title?, metadata? }, resource: 'id' } })
```

thread 不存在时自动创建(可带 `title` / `metadata`)。

## 消息历史(唯一默认开启的机制)

- **窗口**:`lastMessages` 默认 10,只按条数截断,不做 token 窗口。
- **消息格式**:即模型契约的 vendor prompt 类型 + 存储信封 `{ id, threadId, resourceId, createdAt }`;内部流转与存储同一格式(「决策:Agent 核心抽象」已钉)。无 mastra 的 `signal` role。消息不可变。
- **单一查询入口**:`memory.recall({ threadId, limit?, before?, order? })`,返回可直接喂模型的消息;Memory 实例方法全公开(chat UI 可直接调用)。
- **时机**(细化「决策:Agent 核心抽象」的钉法):recall 每 run 一次——run 开始、`processInput` 之前;agent loop 内消息列表在内存累积;save 每个 step 后增量落库(首轮含用户输入消息)。
- **顺序语义**:`processOutputStep` 先于 save——processor 的脱敏/过滤在落库前生效。

## 工作记忆(可选,resource 作用域)

- 一块跨会话的小块结构化数据(用户画像/偏好/当前目标),归属 resource——**单 scope,不做 thread/resource 开关**(调研原话:两个都做是双倍语义表面;thread 级暂存有消息历史兜底)。
- **schema-only**:schema 走 Standard Schema 契约(ADR-0003);merge 语义——深合并、`null` 删字段、数组整换。mastra 的 markdown template 形态砍掉(全量替换 = 每次全量 token、易写坏)。
- **更新只走 tool-call**:启用 WM 时框架自动给 agent 挂 `updateWorkingMemory` 工具;校验失败按既有「工具错误回喂」语义返回模型。
- **注入**:独立 system message,追加在 instructions 之后,不改写 instructions 本体。
- read-only 模式裁出 v1(后加 minor)。

## 存储 port:MemoryStore

```ts
interface MemoryStore {
  // 必备 6
  getThreadById(id: string): Promise<StoredThread | null>
  saveThread(thread: StoredThread): Promise<void>          // upsert,兼 create/update
  deleteThread(id: string): Promise<void>                  // 级联删消息,不动 resource 级数据
  listThreads(q: { resourceId: string; limit?: number; before?: string }): Promise<StoredThread[]>
  listMessages(q: { threadId: string; limit?: number; before?: string; order?: 'asc' | 'desc' }): Promise<StoredMessage[]>
  saveMessages(messages: StoredMessage[]): Promise<void>   // 批量
  // 条件 2(仅启用 working memory 时要求;能力标志降级)
  getResource?(id: string): Promise<StoredResource | null>
  saveResource?(resource: StoredResource): Promise<void>   // upsert
}

// StoredThread   = { id, resourceId, title?, metadata?, createdAt, updatedAt }
// StoredMessage  = vendor prompt 消息 + { id, threadId, resourceId, createdAt }
// StoredResource = { id, workingMemory?, metadata?, createdAt, updatedAt }
```

- 裁单(对照 mastra 10 必备 + 3 可选):`updateMessages`(消息不可变)、`listMessagesById`(语义召回延后连带裁)、`updateThread`(并入 upsert)、`cloneThread` / `copyThread`(延后)、`listMessagesByResourceId`(OM 遗物)。
- 核心自带内存 Map 默认实现——不接 storage 即纯内存,无运行时负担。adapter 家族见 `docs/architecture/storage.md`(#15 已定),本清单是其输入。

## 配置表面

```ts
new Memory({
  storage?: MemoryStore,                     // 默认内存实现
  lastMessages?: number,                     // 默认 10
  workingMemory?: { schema: StandardSchema } // 可选;启用才要求 resource 方法
})
```

- Agent 侧 `memory?: DynamicArgument<Memory>`(全域动态,ADR-0005);同一 Memory 实例可被多 agent 共享。
- **无后台写、无 `settled()`**:所有写发生在请求内;存储连接生命周期归 adapter(见 `docs/architecture/storage.md`)。

## 砍单与承载缝

| 砍单项 | 承载缝 |
| --- | --- |
| semantic recall(向量 RAG) | seam:消息落库 hook + embedder 走模型契约模式;能力包方向入雾,归路线图 |
| OM 类后台压缩管线 | 出本地图范围;bunfold 桥接(路线图);summarize-and-truncate = Processor 模式(文档范式) |
| thread cloning | 后加 minor |
| 单条消息 update/delete | `deleteThread` 级联兜底 |
| thread title 生成 | 应用层职责;title 只是 metadata 字段 |
| markdown template WM | schema-only(merge) |
| read-only WM | 后加 minor |
| token 窗口 | `lastMessages` 条数截断 |
| 访问控制 | 应用层 |
| 所有权迁移 | 删旧建新 |

## 与其它子系统的关系

- **Agent(#10,已定)**:`memory` 一等可选字段;recall/save 时机与 Processor 顺序见上。
- **模型层(#9,已定)**:消息格式 = vendor prompt 类型;届时 embedder 复用同一契约模式(vendor EmbeddingModel 结构类型)。
- **Tools(#13,已定)**:WM 更新工具是框架自挂的 Tool,定义规范见 `docs/architecture/tools.md`。
- **存储(#15,已定)**:MemoryStore port(6 必备 + 2 条件)是其输入,与 `WorkflowSnapshotStore` 统一 adapter 家族;扩展面与 adapter 清单见 `docs/architecture/storage.md`。
- **Observability(#14)**:recall/save 是 span 锚点,形态归它。
- **Harness(#18)**:无耦合——无后台写意味着 memory 不需要 `settled()` 式生命周期。
- **多 agent(#19)**:memory 身份经 per-call 显式传递;as-tool 组合时 thread/resource 由调用方决定,委派场景的隔离语义归它。

## 依赖预算

核心(含 Memory)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。存储 adapter 与外部记忆系统桥接归能力包。
