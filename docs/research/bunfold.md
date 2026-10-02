# 调研:bunfold 现状与桥接点(issue #69)

> 主票:[决策:bunfold 桥 go/no-go——桥接形态或重开条件](https://github.com/0xnicholas/balsats-framework/issues/79)(地图 [M5 生态能力包](https://github.com/0xnicholas/balsats-framework/issues/65))。调研日期:2026-09-30。分支:`research/bunfold`。
> 目的:为 bunfold 桥的 **go/no-go** 与桥接形态提供一手事实。**本文只呈现事实,不做决策**;§8 的对账只做事实映射与缺口登记。
> 钉点:上游仓库与 fork 快照 2026-09-30;fork `0xnicholas/bunfold` 默认线 `feat/server_team`(最新 commit 2026-09-11)+ `vendor` 分支(最新 commit 2026-09-21);npm registry 为 2026-09-30 实时查询。

## TL;DR

- **bunfold = [`0xnicholas/bunfold`](https://github.com/0xnicholas/bunfold)**,即上游 **[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)** 的 fork/镜像(fork 的 `PATCHES.md` 自述「本仓是 `TencentCloud/TencentDB-Agent-Memory` 的 fork(tokencamp-pro #215/#216)」);MIT([LICENSE](https://github.com/0xnicholas/bunfold/blob/feat/server_team/LICENSE))。上游是**团队级 Agent 记忆平台**(team memory hub),活跃度极高:27,552 stars / 2,654 forks / 858 open issues(2026-09-30 实测),最新提交 2026-09-29,最新 stable `v2.0.1`(2026-08-25),`v2.0.2-beta.x` 持续到 2026-09-21。
- **形态 = 服务器优先,不可嵌入**:MemoryCore 是 Node `>=22.16` 的 HTTP 网关(默认 `127.0.0.1:8420`)+ SQLite/本地文件(数据目录 `~/.memory-tencentdb/memory-tdai`);标准部署是**三服务**(memory-core `:8420` + panel/hub `:8125` + proxy `:8096`),官方镜像 ~920 MB。`MemoryCore` 清单 **27 个直接 runtime 依赖**(含原生件 `sqlite-vec`、`@node-rs/jieba`);`MemoryKnowledge` 29 个;`MemoryProxy` 13 个。
- **客户端极轻**:TS SDK [`@tencentdb-agent-memory/memory-sdk-ts-v2`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/sdk/memory-core/typescript/package.json) 运行时**仅 `undici` 一个依赖**;v3 API 强制 `team_id + agent_id + user_id` 三元组隔离,`session_id` 可选。
- **standalone 的唯一外部依赖 = 一套 OpenAI 兼容 LLM API**:抽取/聚合必须有凭据,只读查询可不触发 LLM。
- **上游自己的规范接入形态是代理拦截**(MemoryProxy 改 base URL 零代码接入,自称「No plugin, hook, or MCP server is required」);其框架插件(openclaw / hermes / pi)也全部走 proxy。
- **与本框架 memory seam 的关键鸿沟**(§8):消息面只有 `role: user|assistant` + 纯字符串 `content`(1–8192 字),**无 system / tool / 多 part**;本框架的不可变消息历史 ↔ bunfold 的「L0 原始对话 → **异步**蒸馏为 L1/L2/L3」(fork 的 vendor P1/P2 更把蒸馏后的 L0 原文**物理删除**、默认不写 JSONL 镜像);工作记忆没有 resource 作用域的 schema 记录(最近似物是 L1 `persona` 原子或 team+agent 级 L2/L3 文档)。
- 与「无运行时负担」的张力是**结构性**的:必须跑服务 + 必须给 LLM 凭据 + 数据落盘 + 后台抽取。**可回避**的是 Panel / Proxy / Knowledge(仅取 MemoryCore 即可 standalone)与远程 embedding(默认关,BM25 本地检索)。
- fork 的附加价值是**纪律参照**:`vendor` 分支 = 锁定上游基线 + 原子 patch + [`PATCHES.md`](https://github.com/0xnicholas/bunfold/blob/vendor/PATCHES.md) 台账 + `vendor-invariants.yml` 不变量 CI(2026-09-21 台账记录:MemoryCore 10 文件 53 测试、MemoryKnowledge 3 测试全绿);10 个 patch(P1–P10)全为 tokencamp 业务向(零原文存储、归属头 fail-closed、client-supplied id、L1 直写、id 熵),**不改记忆语义**。

## 1. 口径与钉点

- 上游仓库:[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)(创建 2026-04-07,默认线 `feat/server_team`)。
- fork:[0xnicholas/bunfold](https://github.com/0xnicholas/bunfold)(创建 2026-08-27,公开,非 GitHub fork 关系、`fork=false`;分支仅 `feat/server_team` 与 `vendor`;无 tag、无 release)。
- 本框架侧:[`docs/architecture/memory.md`](../architecture/memory.md)、[ADR-0007](../adr/0007-memory-semantics.md)、[`docs/ROADMAP.md`](../ROADMAP.md)、[issue #12 决议评论](https://github.com/0xnicholas/balsats-framework/issues/12)。
- 数字口径:依赖数 = `package.json` 的 `dependencies` 实数;registry 事实 = `registry.npmjs.org` 实测;仓库事实 = GitHub API / 仓库文件原文(见文末来源)。

## 2. 项目盘面(上游 + fork)

| 项 | 上游 TencentCloud/TencentDB-Agent-Memory | fork 0xnicholas/bunfold |
| --- | --- | --- |
| 定位 | 团队级 Agent 记忆平台(「Memory Hub」):Chat Memory / Skill / LLM-Wiki / Code-Graph 四类资产 | 同上,加 tokencamp 引擎 patch(`vendor` 分支) |
| 创建 | 2026-04-07 | 2026-08-27 |
| 默认分支 | `feat/server_team` | `feat/server_team`(最新 commit 2026-09-11;**镜像落后上游**,上游 HEAD 已到 2026-09-29) |
| 另一分支 | — | `vendor`(最新 commit 2026-09-21) |
| License | 仓库字段 `Other/NOASSERTION`;`LICENSE` 正文为 **MIT**(Tencent copyright) | 同上游(镜像) |
| 规模/热度 | 27,552 stars / 2,654 forks / 858 open issues;仓库体积 37,449 KB(~37 MB) | 0 star / 0 fork |
| 发布 | `v2.0.1`(2026-08-25,最新 stable)、`v2.0.2-beta.1~3`(至 2026-09-21)、`v1.0.3`(2026-09-22,prerelease);共 20+ tag | 无 tag / release |
| 节奏 | 每日提交;issue 存量 858(含大量待办) | 仅维护 patch 台账 |

上游 release 时间线(部分):`v2.0.0`(2026-08-03)、`v2.0.1-beta.1`(08-14)、`v2.0.1`(08-25)、`v2.0.2-beta.1~3`(09-07→09-21)、`v1.0.3`(09-22,prerelease)(来源:[releases](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases))。

## 3. 形态与运行时

**MemoryCore(记忆内核,服务器)** —— 来源 [`MemoryCore/README.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/README.md):

- 独立运行的 HTTP Gateway,**默认监听 `127.0.0.1:8420`**;存储 = SQLite + 本地文件 + 进程内状态;数据目录默认 `~/.memory-tencentdb/memory-tdai`。
- **「Requires no external service other than an LLM API」**;远程 embedding 默认关闭,`BM25` 检索可无 embedding provider 工作。
- 依赖:Node.js `>=22.16.0` + npm + **一套 OpenAI 兼容 LLM API**;**只读查询可能不调用 LLM,但记忆抽取与聚合需要有效凭据**。
- 启动(standalone):`node --import tsx src/gateway/server.ts` + `TDAI_LLM_API_KEY` / `TDAI_LLM_BASE_URL` / `TDAI_LLM_MODEL`;多机暴露需另配 `TDAI_GATEWAY_HOST` + `TDAI_GATEWAY_API_KEY`,此后除 `/health` 与 CORS 预检外都要 `Authorization: Bearer <TDAI_GATEWAY_API_KEY>` + `x-tdai-service-id`。

**整体部署** —— 来源 [`INSTALL.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/INSTALL.md)、[`README.docker.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/README.docker.md)、[`deploy/global-images/`](https://github.com/0xnicholas/bunfold/tree/feat/server_team/deploy/global-images):

| 服务 | 端口 | 角色 |
| --- | --- | --- |
| Memory Core | `8420` | 记忆读写、鉴权、Skill/RAG 数据面 |
| Panel UI(`memory-hub`) | `8125` | 团队记忆控制面板 |
| Proxy | `8096` | LLM 请求代理(Anthropic / OpenAI 双协议) |

- 一键栈 = `./start-all.sh`(交互式,写 `.env` 并启动三服务;脚本含 `start-memory-core.sh` / `start-memory-hub.sh` / `start-proxy.sh` / `stop-all.sh` / `verify.sh`);另有 `./start-all-mongo.sh`(可选 MongoDB 后端)。
- Docker:镜像 `tencentdb-agent-memory`,基础 `node:22-slim`,**大小 ~920 MB**,uid 10001,PID 1 = tini;两种配置模板 = `tdai-gateway.standalone.yaml`(单机零外部依赖)/ `tdai-gateway.service.yaml`(**K8s 多副本,需 Redis**)。
- 默认存储为 sqlite;MongoDB 为试验特性(可选,默认关,`./start-all-mongo.sh`);切换后端**不迁移已有数据**。
- 数据格式跨代迁移工具是 **Python** 脚本(`scripts/migrate-v2-to-v3/v2-to-v3-migrate.py`,v1/v0 数据格式 v2 → v2.0.0+ 格式 v3)。

## 4. 模块与依赖盘面

| 模块 | package name | version(仓库) | 直接 runtime 依赖 | 角色 |
| --- | --- | --- | --- | --- |
| `MemoryCore/` | `@tencentdb-agent-memory/memory-tencentdb-v2` | 1.0.2-beta.1 | **27** | 记忆内核 HTTP 网关(`:8420`) |
| `MemoryKnowledge/` | `@tencentdb-agent-memory/knowledge-service` | 0.1.0 | **29** | Wiki 解析 / CodeGraph 索引检索(独立服务;MemoryCore 只存知识元数据) |
| `MemoryProxy/` | `context-proxy` | 0.1.0 | **13** | 透明 LLM 请求代理(`:8096`) |
| `MemoryPanel/` | `team-memory-control` | 0.1.0 | 6 | 团队记忆面板(`:8125`,`web/` 另有前端包) |
| `sdk/memory-core/typescript/` | `@tencentdb-agent-memory/memory-sdk-ts-v2` | 1.0.1-beta.1 | **1(`undici`)** | TS SDK(v3 strict-isolation API) |

MemoryCore 的 27 个直接依赖(逐条,来源 [`MemoryCore/package.json`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/package.json)):`@ai-sdk/openai` `^3.0.53`、`@node-rs/jieba` `^2.0.1`、`@opentelemetry/api` `^1.9.0`、`@opentelemetry/api-logs` `^0.218.0`、`@opentelemetry/exporter-logs-otlp-http` `^0.218.0`、`@opentelemetry/exporter-trace-otlp-http` `^0.218.0`、`@opentelemetry/resources` `^2.7.1`、`@opentelemetry/sdk-logs` `^0.218.0`、`@opentelemetry/sdk-node` `^0.218.0`、`@opentelemetry/sdk-trace-base` `^2.7.1`、`@opentelemetry/semantic-conventions` `^1.41.1`、`@tencentdb-agent-memory/memory-sdk-ts-v2` `1.0.1-beta.1`、`@tencentdb-agent-memory/tcvdb-text` `^0.1.1`、`ai` `^6.0.164`、`crc-32`、`dayjs`、`fflate`、`js-tiktoken`、`js-yaml`、`json5`、`jszip`、`mongodb` `^6.21.0`、`sqlite-vec` `0.1.7-alpha.2`、`tsx` `^4.21.0`、`undici` `^8.1.0`、`yaml`、`zod` `^4.4.3`。

- `optionalDependencies`(8):`@clickhouse/client`、`@opentelemetry/context-async-hooks`、`@opentelemetry/exporter-{logs,trace}-otlp-grpc`、`cos-nodejs-sdk-v5`、`ioredis`、`kafkajs`、`opik`。
- `peerDependencies`(2):`node-llama-cpp` `^3.16.2`、`openclaw` `>=2026.3.7`——**两者均标记 `optional: true`**(`peerDependenciesMeta`)。
- `engines.node`: `>=22.16.0`;包描述自述为「Four-layer local memory system **plugin for OpenClaw**…(L0→L1→L2→L3 pipeline)」——即 npm 包的主形态是 OpenClaw 插件,但仓库同时提供独立网关运行方式(§3)。
- 与 #12 探查(D2)的一致性:当时所述「MemoryCore 27 个直接依赖」**当前实测仍为 27**;「入口耦合 OpenClaw plugin-sdk」对应的是插件入口(`openclaw.plugin.json` + `openclaw-plugin/`),而 standalone HTTP 网关不依赖它(peer `openclaw` 为 optional)。

## 5. API 面(v3)

来源:[`MemoryCore/v3-api-memorycore-doc.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/v3-api-memorycore-doc.md)(文档自述其维护约定:接口变更须同 PR 更新文档)。

- **规模**:`/v3/*` 共 **108 个接口**——L0–L3 数据面 18、Skill 17、Knowledge 5、Chat-Memory 1、Memory-Prompt 7、Memory-Generation-Log 2、Meta 55、Internal Meta 2、Instance Destroy 1。
- **协议**:全部 `POST`(RPC 风格);统一响应信封 `{ code, message, request_id, data }`;分页 `limit` 默认 20/上限 100。
- **鉴权四层**:Layer 1 = `Authorization: Bearer <KERNEL_AUTH_TOKEN>`(apiKey 未配置时不强制);数据面另需 `x-tdai-service-id`;元数据面再加 `x-tdai-user-key`。
- **隔离字段(强)**:数据面接口接受 `team_id / agent_id / user_id / task_id`(body 或 Header:`x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id` / `x-tdai-task-id`,body 优先);**v3 数据面强制 team + agent + user 三元组,缺省回落 `default` 桶**。
- **写入 L0**:`POST /v3/conversation/add`
  - 入参:`session_id`(必填,业务会话 ID)、`messages`(1–100 条,`{ role: "user"|"assistant", content: 1–8192 字, timestamp?, recorded_at? }`)+ 隔离字段。
  - 出参:`accepted_ids` / `accepted_versions`(新建固定 `v1`)/ `total_count`。
  - **写成功后异步触发 L1 抽取 pipeline(`notifyPipeline`)**。
- **读取/召回面(无单一 `recall` 入口,组合在调用方)**:
  - `POST /v3/conversation/query`:分页查 L0(`session_id?`、时间窗);`POST /v3/conversation/search`:关键词检索 L0(`limit` 默认 5/上限 100,返回带 `score`)。
  - `POST /v3/atomic/query` / `POST /v3/atomic/search`:L1 原子(`type`: `episodic` / `persona` / `instruction`),返回 `AtomicDetail{ id, version, type, background?, content, created_at, updated_at, 隔离字段 }`。
  - `POST /v3/scenario/ls|read`(L2 场景文件)、`POST /v3/core/read|write`(L3 核心记忆 `persona.md`;**文件不存在返回 200 且 `content: null`**)。
- **删除/清空**:`POST /v3/conversation/delete`(`message_ids` ≤5000 或 `session_ids` ≤100)、`POST /v3/atomic/delete`、`POST /v3/chat-memory/clear`(清空若干记忆的 L0/L1/L2/L3 **内容**、保留资产/归属/ACL)。
- **记忆分层**:L0 原始对话(conversation)→ L1 记忆原子(含 `episodic`/`persona`/`instruction` 三类)→ L2 场景文件(scenario)→ L3 核心人格(core,`persona.md`)。
- **Memory-Prompt(7 接口)**:L1/L2/L3 三层 **prompt 模板**管理(`create/get/update/delete/set/setting/list/log`;单实例上限 500);非召回 API。
- **文档自陈的不一致(成熟度信号)**:`atomic/update` 返回 `version` 为字符串 `"v{n}"`,而 `query`/`search` 返回数字 —— 文档原文标注「版本类型不一致…前端需按接口分别处理」。

## 6. SDK 面

来源:[`sdk/memory-core/typescript/README_CN.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/sdk/memory-core/typescript/README_CN.md)、[`package.json`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/sdk/memory-core/typescript/package.json)、[`AGENT_GUIDE.typescript.zh-CN.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/sdk/memory-core/typescript/AGENT_GUIDE.typescript.zh-CN.md)。

- 包 `@tencentdb-agent-memory/memory-sdk-ts-v2`(v1.0.1-beta.1),`engines.node >=18`;运行时依赖仅 `undici ^6.21.3`;导出 `.` 与 `./v3` 两个子路径。
- v3 客户端构造:**`teamId` / `agentId` / `userId` 三元组必填** + `endpoint` / `apiKey` / `serviceId`,可选 `sessionId`。
- **`sessionId` 语义(决定性)**:传入时 L0/L1 按单会话收敛;不传或 `withIsolation({ sessionId: null })` 时 L0/L1 按 `(team, agent, user)` **跨 session 聚合**;**L2/L3 是 team+agent 级 profile,不消费 `sessionId`**。
- 方法面(节选):`addConversation()` / `queryConversation()` / `searchConversation()`(L0)、`searchAtomic()`(L1)、`readScenario()`(L2)、`readCore()`(L3)、`withIsolation()`。
- v2 兼容客户端保留(默认导出 `MemoryClient`;v3 从子路径或 `V3MemoryClient` 导入)。

## 7. 集成形态(上游自己的四类)

1. **HTTP Gateway + SDK**:任何应用直连 `:8420`(§5、§6)。
2. **MemoryProxy 拦截(上游的规范形态)** —— 来源 [`MemoryProxy/README.md`](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryProxy/README.md):透明 LLM 请求代理,**原样转发 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`**;在转发前后自动做 session 初始化、上下文注入、会话回写、鉴权与用量上报;仓库根 README 宣称「One Proxy, unchanged protocol, zero-code integration… **No plugin, hook, or MCP server is required**」。注入策略:**L2/L3 直接注入 system prompt,L0/L1 以只读工具形式暴露给模型**(文档理由:避免上游 KV-cache 失效);客户端接入方式即把 base URL 指到 proxy(如 `ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default`)。
3. **框架插件**:`MemoryCore/openclaw-plugin`、`MemoryCore/hermes-plugin`、`MemoryCore/pi-plugin`(包 `@tencentdb-agent-memory/pi-tdai-client` v0.1.0,peer `@earendil-works/pi-coding-agent`,自述「routes Pi through the TDAI Memory Proxy」);`adapters/` 目录另有 `claude-code` / `codebuddy` / `codex` / `dsh` / `hermes` / `openclaw` / `opencode` / `workbuddy` 与 `setup-proxy.sh`。
4. **多节点部署形态**:`tdai-gateway.service.yaml`(K8s 多副本)+ ProxyStorage 五后端(Redis / COS / SQLite / FS / Memory)→ 企业级形态。

## 8. 与本框架 memory seam 的对账(事实映射 + 缺口登记)

**本框架侧基线**(来源:[`docs/architecture/memory.md`](../architecture/memory.md)、[ADR-0007](../adr/0007-memory-semantics.md)、[`CONTEXT.md`](../../CONTEXT.md)、[#12 决议](https://github.com/0xnicholas/balsats-framework/issues/12)):

- 身份 = `thread`(会话隔离)+ `resource`(跨会话稳定锚);消息格式 = vendor prompt 类型 + `{id, threadId, resourceId, createdAt}` 信封;**消息不可变**。
- `MemoryStore` port = 6 必备(`getThreadById` / `saveThread` upsert / `deleteThread` 级联 / `listThreads` / `listMessages` / `saveMessages`)+ 2 条件(`getResource` / `saveResource`,仅 WM 启用时要求)。
- 时机:recall 每 run 一次(processInput 前,`lastMessages=10` 窗口 + `recall()` 单一入口);save 每 step 后增量(processOutputStep 后);**无后台写**。
- 工作记忆 = resource 作用域、schema-only(Standard Schema + merge)、tool-call 更新、system message 注入。
- 核心运行时依赖硬线 = 0;轴 = 「按需组合 + 无运行时负担(不强制任何基础设施:DB、队列、长驻进程)」。

**映射与缺口**:

| 本框架 | bunfold 最近似物 | 缺口 / 事实 |
| --- | --- | --- |
| `thread` | `session_id`(L0/L1 收敛维度) | session 不是一等实体:无 thread CRUD / listThreads;不传 sessionId 即按 `(team,agent,user)` 跨 session 聚合 |
| `resource` | `user_id` | v3 **强制**三元组 `team+agent+user`;team/agent(/task)在本框架无对应,桥接须填常量或另立概念 |
| — | `team_id` / `agent_id` / `task_id` | 上游多租户/团队模型的轴;本框架无等价术语 |
| 消息历史 | L0 conversation(raw) | **只有 `user`/`assistant` + 纯字符串 `content`(1–8192 字)、1–100 条/次**;无 `system`/`tool` 角色、无多 part、无 tool-call 结构 → vendor prompt 消息(工具调用/结果)不能原样往返 |
| `recall()` 单一入口 | `conversation/query` + `atomic/query|search` + `scenario/read` + `core/read` | **无单一 recall**;组合由调用方承担(上游由 MemoryProxy 做);检索以 BM25 关键词/混合为主(远程 embedding 默认关) |
| save(每 step、同步) | `conversation/add` | 写入后**异步**触发 L1 抽取(`notifyPipeline`,后台 LLM 管线);本框架明言「无后台写」 |
| 工作记忆(resource 作用域 schema) | L1 `persona` 原子 / L2 / L3 | **无 schema 记录、无 merge 语义**:L1 原子为自由文本(KV/版本自增,非结构化校验);L2/L3 是 **team+agent 级文档**(`persona.md`),不消费 `sessionId` |
| 消息不可变 | L1 原子可 `update`(版本自增);L0 可 `delete` | 语义相反:上游把记忆视为可演化/可删的蒸馏产物 |
| — | vendor P1/P2(零原文存储) | fork 的 `vendor` 分支默认「L1 蒸馏游标落盘后**物理删除已消费 L0 行**」「默认不写 standalone JSONL 原文镜像」→ 与「消息历史可回读」直接冲突(PATCHES.md 自陈:删除 best-effort、失败后该行**永久残留看不到**、reconcile 属将来 patch) |
| `deleteThread` 级联 | `conversation/delete` + `chat-memory/clear` | 级联语义不等价:L0 按 session/message 删、L1 按 id 删、L2/L3 另有清空面;需要逐项核对映射 |

**观察到的候选桥接形态(登记事实与摩擦点,不做取舍)**:

1. **`MemoryStore` port adapter(HTTP/SDK 之上)**:把 thread↔session、resource↔user 映射到 port 方法。摩擦:保留/不可变语义相反(若目标是 fork 的 vendor 默认,P1 使 `listMessages`/窗口召回在蒸馏后**变空**;上游保留 L0 但持续增长)、消息面不支持 tool/system/parts、无 `listThreads`/thread upsert 对应、`deleteThread` 级联需自行组合。
2. **Proxy 拦截形态(复刻上游规范接入)**:本框架用户把模型 base URL 指向 MemoryProxy 即可,零框架代码——本框架 example 已有 `OPENAI_BASE_URL` 可配形态;但身份来自 proxy 的 `x-team-id`/`x-agent-id`/`x-task-id` + user key(非本框架 thread/resource),且把第三个服务放进请求路径(延迟/成本/可用性)。
3. **seam façade(薄客户端 + 挂在本框架既有缝上)**:本框架文档留的语义召回缝是「消息落库 hook + embedder 走模型契约模式」,横切唯一扩展点是 Processor 三钩;据此可只做「SDK 客户端 + recall/save 组合」而不实现 port,本框架自身 MemoryStore 不动。事实支撑:SDK 运行时仅 `undici`(客户端侧成本小),服务器侧成本不变(§9)。
4. **作为依赖内嵌**:事实否——27 个直接依赖 + 原生件(`sqlite-vec`、`@node-rs/jieba`)+ 服务器优先架构 + gateway/plugin 入口形态;与 ADR-0007 所述「可嵌入依赖角色不成立」一致(#12 探查当时即此结论)。

## 9. 成本面与「无运行时负担」张力

**硬冲突(事实层面绕不开)**:

- **必须跑服务**:MemoryCore 是独立进程/容器(默认 `:8420`);标准形态还含 panel/proxy。
- **必须给 LLM 凭据**:抽取与聚合需 OpenAI 兼容 LLM API;即「外部 LLM 成本 + 网络依赖」在写入路径上(本框架的回忆/落库是纯本地/内存/port)。
- **后台写**:`conversation/add` 异步触发蒸馏 pipeline;与「无后台写」「无长驻进程」正面冲突。
- **数据落盘**:SQLite + 本地文件(默认 `~/.memory-tencentdb/memory-tdai`);容器镜像 ~920 MB(node:22-slim 基线)。
- **版本漂移快**:v1→v2→v3 数据格式迁移(迁移工具为 Python);npm 发布面滞后仓库(§10);上游 858 open issues,API 仍在演进(文档自陈 `atomic` 版本类型不一致等)。

**可回避/可裁剪(事实层面)**:

- 只取 **MemoryCore** 即可 standalone(`tdai-gateway.standalone.yaml`),不需要 Panel / Proxy / MemoryKnowledge(Wiki/CodeGraph 是独立服务,29 依赖)。
- 远程 embedding 默认关(本地 BM25 + `sqlite-vec`/`jieba`),不需要向量库/embedding API。
- 可选后端(MongoDB / Redis / ClickHouse / Kafka / COS)与可选依赖默认不启用;`node-llama-cpp`、`openclaw` 两个 peer 均为 optional。
- 客户端侧成本极小(TS SDK 单依赖 `undici`)。

**fork 特有的部署姿态**:`vendor` 分支把「LLM 回调必须带归属头(`x-tc-instance`/`x-tc-agent`),缺失即 fail-closed」与「蒸馏后删原文」做成默认(P3/P4/P5/P8、P1/P2)——即 fork 默认姿态面向 tokencamp 的多租户成本归属与零原文存储,非通用默认。

## 10. npm 发布面与版本漂移(2026-09-30 实测)

| 包 | npm latest | 发布时间 | 版本数 | 备注 |
| --- | --- | --- | --- | --- |
| `@tencentdb-agent-memory/memory-tencentdb` | 1.0.3 | 2026-09-22 | 40 | README badge 指向的包(OpenClaw 插件线) |
| `@tencentdb-agent-memory/memory-tencentdb-v2` | 1.0.0-beta.1 | 2026-08-06 | 1 | 仓库清单为 1.0.2-beta.1、27 依赖;npm 上该版本 dependencies 仅 1 项(指向 SDK `1.0.0-beta.2`)→ **发布物 ≠ 仓库当前状态** |
| `@tencentdb-agent-memory/memory-sdk-ts-v2` | 1.0.0-beta.1 | 2026-07-21 | 3 | 仓库清单为 1.0.1-beta.1(依赖 `undici`);npm 上该版本 deps = 0 |
| `@tencentdb-agent-memory/memory-sdk-ts` | 1.0.0 | 2026-05-29 | 5 | v2 兼容线 |
| `bunfold` / `memory-tencentdb-v2` 新版 | — | — | — | registry 无 `bunfold` 包(npm search 0 命中)→ 「bunfold」目前**只是 fork 仓库名**,不是发布包名 |

## 11. fork(bunfold)的 vendor 差异盘面

来源:[`PATCHES.md`(vendor 分支)](https://github.com/0xnicholas/bunfold/blob/vendor/PATCHES.md)、[`vendor-invariants.yml`](https://github.com/0xnicholas/bunfold/blob/vendor/.github/workflows/vendor-invariants.yml)。

- **基线沿革**:初始锁定 `0468a2a` → rebase 到 `29bb8df`(上游 `feat/server_team` HEAD);10 个 patch commit 全部无冲突平移(`range-diff` 逐条 `=`);上游 16 个新 commit 与 patch 文件集交集为空;新基线自带两处安全修复 `41dee1f`(Knowledge `/v3` 写/管理端点 service key 门禁,#1385)与 `5017e2b`(MemoryCore `asset/get`、`asset/list` 调用方作用域 ACL,#1464)。
- **纪律**:一 patch 一原子 commit(前缀 `vendor(Pn):`)+ 代码内 `VENDOR PATCH Pn` 锚点 + 每个 patch 配**不变量测试**(`MemoryCore/__tests__/vendor-invariants/`、`MemoryKnowledge/__tests__/vendor-invariants/`)+ CI 强制常绿;台账逐 patch 登记动机/落点(文件:行)/不变量/测试位置/偏离声明。
- **patch 清单(P1–P10 + FTS5 backport)**:P1 蒸馏游标落盘后删已消费 L0 行(崩溃安全顺序、best-effort、永久残留已登记);P2 关 standalone JSONL 原文镜像(单开关,默认关);P3 standalone LLM chat 回调注入归属头且缺头 fail-closed(并加「L1 失败即 abort、游标不推进」组合规则防静默丢原文);P4 embedding 回调归属头 fail-closed;P5 wiki(MemoryKnowledge)LLM 回调归属头 fail-closed;P6 实例销毁物理删除 standalone 数据存储;P7 v3 meta team/agent create 接受 client-supplied id;P8 蒸馏/embedding 回调注入 `x-tc-work` 词表头 fail-closed;P9 v3 `/atomic/create` L1 直写端点(client id 幂等、撞 id 409、`metadata_json` provenance 透出);P10 L1 `record_id` 铸 id 熵 32→64 位;FTS5 = 上游 main 线 MATCH 注入修复 backport。
- **验证口径(台账 2026-09-21 记录)**:升级后 `MemoryCore` vendor-invariants 10 文件 53 测试全绿、`MemoryKnowledge` 3 测试全绿。
- **已知上游既有问题(台账登记、非 fork 引入)**:`MemoryCore` 的 `build:seed-v2` 引用不存在的 `scripts/seed-v2/tsconfig.json`;`MemoryKnowledge` `typecheck` 有 1 个既有错误(`src/middleware/response-envelope.ts:47`,hono 4.13.7 `BodyCache` 类型变更)。
- **与 #12 探查的口径差**:当时记录「vendor 分支 **9 个** patch 全为 tokencamp 业务向」;当前台账为 **10 个 patch(P1–P10)+ 1 个 FTS5 backport**(新增 P10 等),结论(业务向、不改记忆语义)不变。

## 附:来源

上游与 fork(2026-09-30 实测):

- fork 仓库:[github.com/0xnicholas/bunfold](https://github.com/0xnicholas/bunfold)(`feat/server_team` / `vendor`;无 tag/release)
- fork `PATCHES.md`(vendor):[blob/vendor/PATCHES.md](https://github.com/0xnicholas/bunfold/blob/vendor/PATCHES.md)
- fork `LICENSE`:[blob/feat/server_team/LICENSE](https://github.com/0xnicholas/bunfold/blob/feat/server_team/LICENSE)
- 仓库根 README:[blob/feat/server_team/README.md](https://github.com/0xnicholas/bunfold/blob/feat/server_team/README.md)
- `MemoryCore/README.md`:[blob/feat/server_team/MemoryCore/README.md](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/README.md)
- `MemoryCore/package.json`:[blob/feat/server_team/MemoryCore/package.json](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/package.json)
- v3 接口文档:`MemoryCore/v3-api-memorycore-doc.md`:[blob/feat/server_team/MemoryCore/v3-api-memorycore-doc.md](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryCore/v3-api-memorycore-doc.md)
- SDK:[sdk/memory-core/typescript/](https://github.com/0xnicholas/bunfold/tree/feat/server_team/sdk/memory-core/typescript)(README_CN / AGENT_GUIDE / package.json)
- MemoryProxy:`MemoryProxy/README.md`:[blob/feat/server_team/MemoryProxy/README.md](https://github.com/0xnicholas/bunfold/blob/feat/server_team/MemoryProxy/README.md);`package.json`(13 依赖,包名 `context-proxy`)
- MemoryKnowledge:`MemoryKnowledge/package.json`(包名 `@tencentdb-agent-memory/knowledge-service`,29 依赖)
- MemoryPanel:`MemoryPanel/package.json`(包名 `team-memory-control`)
- 部署:`INSTALL.md`、`README.docker.md`、`deploy/global-images/`(start-all.sh 等)
- pi 插件:`MemoryCore/pi-plugin/package.json`(`@tencentdb-agent-memory/pi-tdai-client`)
- 上游:[github.com/TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) · [releases](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases) · `ROADMAP.md` / `CHANGELOG.md`
- npm registry:`registry.npmjs.org/@tencentdb-agent-memory%2Fmemory-tencentdb-v2`、`…%2Fmemory-sdk-ts-v2`、`…%2Fmemory-sdk-ts`、`…%2Fmemory-tencentdb`(2026-09-30 实测)

本框架(仓库内):

- [`docs/architecture/memory.md`](../architecture/memory.md)、[`docs/adr/0007-memory-semantics.md`](../adr/0007-memory-semantics.md)、[`CONTEXT.md`](../../CONTEXT.md)、[`docs/ROADMAP.md`](../ROADMAP.md)
- [决策:Memory 子系统(issue #12)决议评论](https://github.com/0xnicholas/balsats-framework/issues/12)(bunfold 探查要点、MemoryStore 6+2、时序钉点)
- [调研:mastra Memory 子系统(issue #5)](https://github.com/0xnicholas/balsats-framework/issues/5)
