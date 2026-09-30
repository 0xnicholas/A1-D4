# 调研:SQLite 驱动现状——node:sqlite vs libsql（四 port 需求对账）

> Issue: [#66](https://github.com/0xnicholas/balsa-framework/issues/66) · 日期:2026-09-30 · 分支:`research/sqlite-driver-landscape` · 性质:事实收集,**不做决策**（供主票「决策:SQLite 参考 adapter」冻结驱动选型）。

## TL;DR

- **node:sqlite 是 Node 内置**（0 依赖、0 安装体积）。v22.5.0 引入时在 `--experimental-sqlite` 后面；**v22.13.0 / v23.4.0 起免 flag 但仍标 experimental**；main 分支文档已到 **Stability 1.2 - Release candidate**（v25.7.0 起）。**实测:Node 22.12.0（本仓库 engines 基线）无 flag 直接 `ERR_UNKNOWN_BUILTIN_MODULE`**——用 node:sqlite 要么把基线抬到 22.13+，要么要求 `--experimental-sqlite`。
- node:sqlite **全同步 API**（阻塞事件循环），**无内置事务封装**（事务用 `exec("BEGIN IMMEDIATE")`/`COMMIT`）；WAL、busy_timeout、JSON 函数、upsert（`ON CONFLICT … DO UPDATE`）、外键约束均可用；捆绑 SQLite 3.47.0（22.12）/ 3.47.2（22.13）/ 3.53.1（26.2）。
- **@libsql/client（0.18.0，MIT）** 是 Promise 型客户端:本地文件走 `file:` → 原生 libsql 引擎（SQLite fork，平台二进制）。npm 实测:非平台部分 **3.34 MiB**、单平台安装 **≈12.8 MiB**、全平台解析 **78.7 MiB**（9 个平台可选包）。
- **定位漂移是本次最值得注意的事实**:Turso 官方 quickstart 现在写「**Recommended: `@tursodatabase/database` (Local / Embedded)**」，把 `@libsql/client` 定位为「远程 libSQL + ORM 兼容」；官方对照表的「Concurrent writes」一栏 @libsql/client 为 **Not supported**。
- **四个 port 的存储需求全部落在「JSON 文本列 + 标准 SQL（排序/游标/upsert/事务）」范围内**，两种驱动都能表达；差异集中在驱动形态（内置 vs 原生二进制）、版本门槛、同步/异步、平台覆盖与可选扩展实现，**不在 SQL 能力**。
- edge 面:node:sqlite 在 Cloudflare Workers（flag，默认 2026-01-29 起；workerd 实现被官方描述为「stub」）/ Deno 2.2+ / Bun（PR 已 merged、官方 compatibility 页标「🟢 Fully implemented」，但官方 API reference 页仍写「Not implemented」——同源文档自相矛盾）；@libsql/client 的 `/web` 子路径**只支持远程 URL**，本地文件是 native-only。

## 0. 口径与方法

- 日期:**2026-09-30**（所有「官方现状」以该日抓取为准）。
- node:sqlite 事实来源:Node 官方 API 文档 [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html)（含 History 表）+ 官方文档源 [doc/api/sqlite.md](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md) + Node 22.x 文档 [docs/latest-v22.x/api/sqlite.html](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)；运行时实测:`npx node@22.12.0`、`npx node@22.13.0`、本机 `node v26.2.0`。
- libsql 事实来源:npm registry（`npm view` 实测）+ 仓库源码 [tursodatabase/libsql-client-ts](https://github.com/tursodatabase/libsql-client-ts) + 官方文档 [docs.turso.tech/sdk/ts/reference](https://docs.turso.tech/sdk/ts/reference) / [quickstart](https://docs.turso.tech/sdk/ts/quickstart)。
- SQLite 语义来源:SQLite 官方网站（[WAL](https://sqlite.org/wal.html)、[JSON1](https://sqlite.org/json1.html)、[UPSERT](https://sqlite.org/lang_upsert.html)、[事务](https://sqlite.org/lang_transaction.html)、[外键](https://sqlite.org/foreignkeys.html)）。
- 体积口径沿 #6:`npm install --package-lock-only` 解析安装树 → 逐包 `npm view <name>@<version> dist.unpackedSize` 求和（只解析元数据，不写 node_modules）；**这是下界**（缺字段的包不计）。
- 仓库侧:四个存储 port 的类型与语义取自 `packages/core/src/**`（§3 逐条标注文件）。

## 1. node:sqlite（Node 内置）

### 1.1 版本门槛与稳定性（逐条）

- **Added in: v22.5.0**（[API 文档](https://nodejs.org/api/sqlite.html)）。
- History 表:**v23.4.0, v22.13.0 —「SQLite is no longer behind `--experimental-sqlite` but still experimental」**;**v25.7.0 —「SQLite is now a release candidate」**（[文档源 sqlite.md](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md)）。
- 稳定性标注:main 分支文档 **Stability: 1.2 - Release candidate**；Node 22.x 文档 **Stability: 1.1 - Active development**（同页另有一处 `Stability: 1 - Experimental` 标注，2026-09-30 抓取，未逐条定位其所在节）。
- 模块只以 `node:` 前缀可用（`import sqlite from 'node:sqlite'` / `require('node:sqlite')`）；SQL trace 事件经 `diagnostics_channel` 的 `'sqlite.db.query'` 观察。
- **运行时实测**（本调研，2026-09-30）:

| 运行时 | 命令/方式 | 结果 |
| --- | --- | --- |
| Node 22.12.0（本仓库 engines 基线） | `require("node:sqlite")` | `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite` |
| Node 22.12.0 | `--experimental-sqlite` + `require("node:sqlite")` | 可用；`process.versions.sqlite = 3.47.0`；打印 ExperimentalWarning |
| Node 22.13.0 | `require("node:sqlite")`（无 flag） | 可用；`process.versions.sqlite = 3.47.2` |
| Node 26.2.0（本机） | `require("node:sqlite")` | 可用；`process.versions.sqlite = 3.53.1` |

**推论（事实层）**:仓库 `packages/core` 的 `engines` 为 `node >=22.12.0`，而 node:sqlite 在 22.12.0 还需 flag——若某能力包直接依赖 node:sqlite，最低基线事实上是 **22.13.0**（或要求 flag，或抬高 engines）。

### 1.2 API 面（[官方文档](https://nodejs.org/api/sqlite.html)）

- `DatabaseSync`（构造即 open；`open()` 备用）+ 构造选项:`open`、`readOnly`、`enableForeignKeyConstraints`（默认 `true`）、`enableDoubleQuotedStringLiterals`、`allowExtension`、**`timeout`（busy timeout，毫秒；v24.0.0 / v22.16.0 加入）**、`readBigInts`、`returnArrays`、`allowBareNamedParameters`、`allowUnknownNamedParameters`、`defensive`（默认 `true`，v25.5.0 / v24.14.0）、`limits`。
- `database.exec(sql)`（可多语句）、`database.prepare(sql[, options])` → `StatementSync`（`run` / `get` / `all` / `iterate` / `columns` / `close`）、`aggregate()`、`function()`、`setAuthorizer()`、`loadExtension()`、`location()`、`isOpen`、`isTransaction`、`serialize()` / `deserialize()`（v26.1.0）、`createSession()` / `applyChangeset()`、`createTagStore()`（预编译语句 LRU 缓存）、`limits`、`[Symbol.dispose]()`。
- 文档原文:**「All APIs exposed by this class execute synchronously」**（DatabaseSync 与 StatementSync 均有此句）→ 阻塞事件循环；**无内置事务 API**，事务 = `exec("BEGIN IMMEDIATE")` / `COMMIT` / `ROLLBACK`，`isTransaction` 反映状态（依据:文档 API 清单无事务方法 + 本调研实测:`exec("begin")` 后 `isTransaction === true`）。
- 语句缓存:`createTagStore([maxSize])`（v24.9.0），或应用侧自行缓存 prepared statement。

### 1.3 类型映射（[官方文档「Type conversion」](https://nodejs.org/api/sqlite.html)）

| SQLite 存储类 | 写入（JS → SQLite） | 读回（SQLite → JS） |
| --- | --- | --- |
| NULL | `null` / `undefined` | `null`（永远不是 `undefined`） |
| INTEGER | `number` / `bigint` / `boolean`（写为 1/0） | `number` 默认，`bigint` 可选（`readBigInts`） |
| REAL | `number` | `number` |
| TEXT | `string` | `string` |
| BLOB | TypedArray / DataView / ArrayBuffer / SharedArrayBuffer | `Uint8Array` |

- 超出 JS 安全整数范围且未开 `readBigInts` 时读 INTEGER 会抛 `ERR_OUT_OF_RANGE`；超 64 位有符号范围的 bigint 写入抛 `ERR_INVALID_ARG_VALUE`。

### 1.4 四 port 关心项（本调研实测，Node 26.2.0 / 捆绑 SQLite 3.53.1）

| 需求 | 实测结果 |
| --- | --- |
| JSON 文本列 / `json_extract` | 可用（`select json_extract('{"a":41}','$.a')` → 41）。`pragma_compile_options` 里**没有** JSON 项——SQLite 官方:「The JSON functions and operators are built into SQLite by default」（[json1](https://sqlite.org/json1.html)）。22.12 捆绑 3.47.0 同样可用（实测）。 |
| WAL | `PRAGMA journal_mode=WAL` → `wal`（文件库实测）。SQLite 官方:「WAL provides more concurrency as readers do not block writers and writers do not block readers and readers do not block writers」，且 **WAL 不适用于网络文件系统**（[wal.html](https://sqlite.org/wal.html)）。 |
| busy_timeout | 构造选项 `timeout` 即 busy timeout（文档）；实测 `new DatabaseSync(path, { timeout: 2500 })` → `PRAGMA busy_timeout` = 2500。 |
| 事务 / CAS | `BEGIN IMMEDIATE` 立即进入写事务（SQLite 官方:「IMMEDIATE causes the database connection to start a new write…」[lang_transaction](https://sqlite.org/lang_transaction.html)）；CAS（期望值匹配才写）= 普通条件 `UPDATE … WHERE`，靠事务串行化。 |
| 批量 upsert | `INSERT … ON CONFLICT … DO UPDATE SET …`（官方 [lang_upsert](https://sqlite.org/lang_upsert.html)）；实测按 id upsert 成功。 |
| 级联删除 | FK 约束默认开启（构造选项 `enableForeignKeyConstraints` 默认 `true`）+ `ON DELETE CASCADE`；SQLite 层面「Foreign key constraints are disabled by default」（[foreignkeys](https://sqlite.org/foreignkeys.html)），node:sqlite 主动打开。 |
| 排序 / 游标分页 | 标准 `ORDER BY` / `WHERE` / `LIMIT`。注意:`ScheduleStore.list` 要求「`nextFireAt` 升序、`null` 最后、`id` tie-break」——SQLite 默认 ASC 是 **NULL 在前**，需显式 `ORDER BY nextFireAt IS NULL, nextFireAt, id`（SQL 层事实，非驱动差异）。 |
| 跨进程 | 同步单连接；多进程各开自己的连接 → WAL + busy_timeout 是并发面（SQLite 语义，见上）。 |
| STRICT 表 | 实测 `create table … strict` 可用（3.53.1）。 |

### 1.5 运行时覆盖（node:sqlite）

| 运行时 | 状态 | 来源 |
| --- | --- | --- |
| Node | 内置（`node:` 前缀） | [API 文档](https://nodejs.org/api/sqlite.html) |
| Cloudflare Workers | 有 `enable_nodejs_sqlite_module` / `disable_nodejs_sqlite_module` 两个 flag，官方 compatibility-flags 页标注「Default as of **2026-01-29**」，描述为「enables the node:sqlite module **stub** in Workers」 | [兼容性 flags 页](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)（另:2026-08-04 起 `nodejs_compat` / `nodejs_compat_v2` 默认开启，[Node.js compatibility 页](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)） |
| Deno | **v2.2 起实现**；Deno 2.7 又补 `DatabaseSync.setAuthorizer()` 等 | [Deno node:sqlite 文档](https://docs.deno.com/api/node/sqlite/)、[Deno 2.2 发布说明](https://deno.com/blog/v2.2)、[Deno Node APIs](https://docs.deno.com/runtime/reference/node_apis/) |
| Bun | 曾长期未实现（[discussion #27092](https://github.com/oven-sh/bun/discussions/27092)，2026-02 仍答「not implemented」）；[PR #32498](https://github.com/oven-sh/bun/pull/32498)「node:sqlite: implement the module and pass the Node v26.3.0 test suite」**2026-07-17 merged**；官方 [Node.js Compatibility 页](https://bun.com/docs/runtime/nodejs-compat)现标「node:sqlite 🟢 Fully implemented」、[Bun 1.4 发布说明](https://bun.com/blog/bun-v1.4)报「node:sqlite 100%」测试通过；**但官方 API reference 页仍写「Not implemented. Consider using `bun:sqlite`」**（[bun.com/reference/node/sqlite](https://bun.com/reference/node/sqlite)，2026-09-30 抓取）——同源文档矛盾。 |

## 2. @libsql/client 系

### 2.1 定位与维护现状（Turso 官方，2026-09-30）

Turso 官方 TS 文档的四个包对照（[reference](https://docs.turso.tech/sdk/ts/reference)）:

| 包 | 用途 | 引擎 | 依赖 | 并发写 |
| --- | --- | --- | --- | --- |
| `@tursodatabase/database` | 本地 / 嵌入 | Turso（重写） | Native（Node.js、WASM） | Yes（MVCC） |
| `@tursodatabase/sync` | 本地 + 云同步 | Turso（重写） | Native（Node.js） | Yes（MVCC） |
| `@tursodatabase/serverless` | 远程 Turso | Turso | 仅 `fetch`，零原生依赖 | Yes（MVCC） |
| **`@libsql/client`** | **远程 libSQL + ORM（Drizzle、Prisma）** | **libSQL（SQLite fork）** | **Requires Node.js 或 `/web` 子路径** | **Not supported** |

- quickstart 一手措辞:「**Recommended: `@tursodatabase/database` (Local / Embedded)** … the recommended package for local and embedded use cases (Node.js, Electron, mobile, IoT)」；「`@libsql/client` is the package for applications that connect to a **remote** libSQL database on Turso Cloud. It is also the package to use for **ORM integration**」（[quickstart](https://docs.turso.tech/sdk/ts/quickstart)）。
- 仓库 README 自述:「**Use `@libsql/client` if you need a battle-tested driver today with ORM integration**」，并指向 `@tursodatabase/serverless`「the lightest option with zero native dependencies, and **will be the driver to later support concurrent writes**」（[README](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-client/README.md)）。
- 版本节奏（registry）:`@libsql/client` **0.18.0 发布于 2026-09-02**；2023-01 起共 119 个版本（0.17.2 → 2026-03、0.17.4 → 2026-06、0.18.0 → 2026-09）。配套:`libsql`（原生）0.5.29；`@tursodatabase/database` 0.8.1（2026-09-29 有更新）、`@tursodatabase/serverless` 1.4.0。
- 许可:MIT（`@libsql/client`、`libsql`、`@tursodatabase/database` 均 MIT）。

### 2.2 依赖与安装体积（npm 实测，2026-09-30）

- `@libsql/client` 直接依赖（registry）:`libsql@^0.5.28`、`js-base64@^3.7.5`、`@libsql/core@^0.18.0`、`promise-limit@^2.7.0`、`@libsql/hrana-client@^0.10.0`。
- `package-lock-only` 解析出的安装树 **22 项**，其中 **9 项是平台可选包**（`@libsql/{darwin-x64,darwin-arm64,linux-x64-gnu,linux-x64-musl,linux-arm64-gnu,linux-arm64-musl,linux-arm-gnueabihf,linux-arm-musleabihf,win32-x64-msvc}`，均 0.5.29）。
- 体积（registry `dist.unpackedSize` 求和）:

| 口径 | 数值 |
| --- | --- |
| 非平台部分小计（13 项） | **3.34 MiB** |
| 单平台安装（非平台 + 最大的平台二进制） | **≈12.8 MiB** |
| 全平台解析（22 项全计） | **78.7 MiB** |

- 平台二进制单体规模示例:`linux-x64-gnu` 9.72 MB、`win32-x64-msvc` 8.88 MB、`darwin-x64` 8.76 MB、`darwin-arm64` 7.84 MB（unpacked）。
- 非平台部分里值得单列:`@libsql/hrana-client` 305,584 B；`ws` 151,410 B；`@libsql/core` 51,376 B；`libsql` 43,990 B；**`@types/node` 2,545,763 B + `@types/ws` 42,711 B + `undici-types` 120,779 B**（经 `@libsql/isomorphic-ws` 的**运行时**依赖 `@types/ws` 进入安装树）。

### 2.3 本地文件模式、事务、并发、类型

- 入口分流（仓库源码）:node 入口 [node.ts](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-client/src/node.ts) 按 scheme 分派——`file:` → [sqlite3.ts](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-client/src/sqlite3.ts)（`import Database from "libsql"`，原生引擎）；`ws/wss` → ws 客户端；`http/https` → http 客户端。[web.ts](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-client/src/web.ts)（browser/workerd/netlify/edge-light 入口）**只分派 ws/wss 与 http/https**。
- **本地文件 = `file:`（native-only）**；`sqlite3.ts` 明确拒绝非 `file:` scheme:「URL scheme … is not supported by the local sqlite3 client」。内存库亦支持（官方 reference「In-Memory Databases」）。
- 事务（官方 reference）:batch = 多条语句在隐式事务里顺序执行、失败整体回滚；interactive transaction = `execute()` / `commit()` / `rollback()` / `close()`；事务模式表:`write` = `BEGIN IMMEDIATE`（在副本上转发 primary，不可并行）、`read` = `BEGIN TRANSACTION READONLY`、`deferred` = `BEGIN DEFERRED`。
- 并发:官方 reference「By the default, the client performs up to `20` concurrent requests」（`concurrency` 配置）。
- 类型:`intMode` 配置（`"number" | "bigint" | "string"`），源码默认 **`intMode ??= "number"`**（[config.ts:57](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-core/src/config.ts)）；`Value = null | string | number | bigint | ArrayBuffer`，`InValue = Value | boolean | Uint8Array | Date`（[api.ts:492](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-core/src/api.ts)）。
- 其它:`ATTACH` 支持；嵌入式副本（`syncUrl` / `syncInterval` / `readYourWrites` / `offline`）；加密（cipher 列表见官方 reference）。

### 2.4 WAL 与外键的缺口（文档未明说，源码可查的部分）

- **外键**:`sqlite3.ts`（main，2026-09-30 检视）中 `PRAGMA foreign_keys` 只出现在 `migrate()` 的 off/on 包里；连接建立处**未见**开启语句 → 本地模式的外键状态实际跟随 SQLite 默认（「Foreign key constraints are disabled by default」，[foreignkeys](https://sqlite.org/foreignkeys.html)）。**与 node:sqlite 默认开启相反**（后者构造选项默认 `true`）。
- **WAL**:官方 TS SDK 文档未直接描述本地文件模式的 WAL 行为；可查到的官方口径是「Concurrent writes: Not supported」（@libsql/client 一行）。libsql 是 SQLite fork，WAL 机制同源，但**「@libsql/client 本地文件在多进程下的 WAL/busy 行为」本次未找到一手陈述**——列为未验证缺口（§5）。

### 2.5 edge

- `@libsql/client` 的 `exports` 里有 `./web`，且 `browser` / `workerd` / `netlify` / `edge-light` 条件都指向 `lib-esm/web.js`（registry 元数据）；官方 reference 的兼容环境列表含「Node.js 12+、Deno、CloudFlare Workers、Netlify & Vercel Edge Functions」。
- 但 `/web` 只分派 `ws/wss` 与 `http/https`（源码）→ **edge 上只能连远程 libSQL/Turso，不能用本地文件**。本地文件模式需要原生二进制（`libsql` + 平台包）。

## 3. 四 port 需求对账

### 3.1 逐 port 需求（仓库一手，`packages/core/src/**`）

| Port | 方法（`packages/core/src/**`） | 对存储的实际要求 |
| --- | --- | --- |
| `MemoryStore`（6+2，`memory/store.ts`） | `getThreadById` / `saveThread`（整条 upsert）/ `deleteThread`（级联删消息）/ `listThreads`（`resourceId`；`updatedAt` desc、`id` tie-break；`before` 游标；`limit` 锚定最新端）/ `listMessages`（`threadId`；`createdAt` + `id` tie-break，`order` 只翻转呈现；游标）/ `saveMessages`（按 id 批量 upsert）/ 可选 `getResource` + `saveResource`（整条 upsert） | JSON 文本列（`metadata`、`workingMemory`、消息体）+ 复合排序 + tie-break + 游标分页 + 批量 upsert + 级联删除 + 时间戳映射（`Date` 进 `types.ts`，存 ms 或 ISO） |
| `WorkflowSnapshotStore`（`workflows/snapshot.ts`） | `load(runId)` / `save(runId, snapshot)` | JSON-only 快照（`input` / `stepResults` / `iterationSite` 均是 `unknown` 嵌套）+ 整条覆盖（latest-only）；**CAS 只是可选扩展**（`compareAndSave`，`docs/architecture/storage.md` 参考形状） |
| `AgentRunSnapshotStore`（`durable-agent/snapshot.ts`） | `load(runId)` / `save(runId, snapshot)` | JSON-only 快照（`messages` 数组可能较大、`suspendPayload`）；**无 CAS**（`harness.md` 明示）；可选扩展 `deleteSnapshot` / `listSuspended` |
| `ScheduleStore`（`schedules/types.ts` + `schedules/in-memory-store.ts`） | 记录 CRUD + `list`（soonest-first:`nextFireAt` asc、`null` 最后、`id` tie-break；`before` 游标）/ `listDue(now)`（`enabled && nextFireAt !== null && nextFireAt <= now`，同序） | 数值列排序 + NULL 排序控制 + 索引 + 可选事务性 upsert；`next` 函数不进存储（进程内按 id 配对） |

### 3.2 SQL 能力清单（两驱动逐条）

| SQL 能力 | node:sqlite | @libsql/client（本地 `file:`） |
| --- | --- | --- |
| JSON 函数（`json_extract` 等） | ✅ 内置（实测；[json1](https://sqlite.org/json1.html)） | ✅（SQLite fork；本次未单独实测，按引擎同源记） |
| 事务（BEGIN IMMEDIATE / 提交 / 回滚） | ✅ `exec("BEGIN IMMEDIATE")` + `isTransaction`（无封装） | ✅ batch 隐式事务 + interactive transaction + 三模式（官方表格） |
| 条件更新（CAS） | ✅ 条件 `UPDATE … WHERE` + 事务 | ✅ 同（事务模式 write / deferred） |
| 批量 upsert（`ON CONFLICT … DO UPDATE`） | ✅ 官方语法 + 实测 | ✅（同一 SQL 面） |
| 外键 + 级联删除 | ✅ 默认开启（选项 `true`） | ⚠️ 客户端未见开启（默认 off），需应用显式 `PRAGMA foreign_keys=on` 或手写级联 |
| 排序 / NULL 控制 / 游标分页 | ✅ 标准 SQL | ✅ 标准 SQL |
| 多进程并发 | WAL + `timeout`(busy)（SQLite 语义） | 官方只说「并发写 Not supported」；多进程行为未一手陈述（§5） |
| 异步 / 非阻塞 | ❌ 全同步、阻塞事件循环 | ✅ Promise 型；客户端并发上限 20 |

### 3.3 缺口逐条（相对四 port 的需求）

1. **node:sqlite 的版本门槛**是唯一的「环境性」缺口:22.12.0 需 flag，22.13.0+ 免 flag 但仍标 experimental（1.1）；main 已 RC（1.2）。仓库 engines 基线与之错位一版。
2. **node:sqlite 无事务封装**（需手写 `BEGIN IMMEDIATE` 等）——纯实现面，非能力缺口；`isTransaction` 可作断言面。
3. **@libsql/client 本地模式的外键默认关闭**（源码只在校验/迁移处开关）——级联删除与引用完整性需应用侧处理，或每个连接显式开 PRAGMA。
4. **@libsql/client 的并发写限制**（官方 Not supported；MVCC 在 @tursodatabase/* 新引擎里才有）——跨进程/并发写的可用面与 node:sqlite（WAL + busy timeout）需要各自核实。
5. **@libsql/client 本地文件是 native-only**（平台二进制 12.8 MiB/单平台；edge 只能远程）——与「按需组合、无运行时负担」的轴存在张力（体积与安装期成本），但这是取舍事实，不是缺陷。
6. **Turso 自己的本地推荐位已转向 `@tursodatabase/database`**（新引擎、MVCC、async I/O、Drizzle beta）；@libsql/client 在官方叙事里是「远程 libSQL + ORM」。

## 4. 横向对照表

| 维度 | node:sqlite | @libsql/client（0.18.0） |
| --- | --- | --- |
| 引入/门槛 | Node 22.5（22.12 需 `--experimental-sqlite`；22.13+ 免 flag、experimental；25.7+ RC） | Node 12+；本地文件需平台原生包 |
| 依赖 / 体积 | **0 依赖、0 安装体积**（内置） | 非平台 3.34 MiB；单平台 ≈12.8 MiB；全平台解析 78.7 MiB |
| API 形态 | 同步（阻塞）`DatabaseSync` / `StatementSync` | 异步 Promise；`execute` / `batch` / `transaction` |
| 事务 | `exec("BEGIN IMMEDIATE")` + `isTransaction`（无封装） | batch / interactive / `write`(“BEGIN IMMEDIATE”)、`read`、`deferred` |
| 本地文件 | 路径或 `:memory:` | `file:`（native）/ `:memory:` |
| WAL / busy | `PRAGMA journal_mode=WAL`；构造 `timeout` = busy timeout | 文档未直述；官方对照表并发写「Not supported」 |
| JSON | SQLite 内置 JSON（实测 3.47/3.53） | 同源引擎（未单独实测） |
| 外键默认 | **开启**（选项默认 `true`） | **关闭**（连接建立处未开启；仅 `migrate()` 开关） |
| 整数读取 | `number` 默认 / `readBigInts` → bigint | `intMode` 默认 `"number"` / `bigint` / `string` |
| 运行时覆盖 | Node；Workers（flag/stub，默认 2026-01-29 起）；Deno 2.2+；Bun（已实现，官方文档矛盾） | Node（本地/远程）；`/web`（远程 URL only） |
| 维护/定位 | Node 官方，向 RC 演进 | Turso 维护，MIT；官方把「本地/嵌入推荐」给 `@tursodatabase/database`，自身定位为远程 + ORM |

## 5. 未验证 / 留待决策或后续查

- **node:sqlite 版本门槛的选择**（抬高 engines 到 22.13+ / 要求 flag / 暂不用）——决策点，本调研不做裁决。
- **@libsql/client 本地文件的多进程并发写语义**（官方文档未逐条列；对照表只说并发写 Not supported）——需实测或查 libsql 引擎文档才能落定。
- **Workers 的 node:sqlite 是 workerd 的 stub 实现**，与 Node 实现的行为差异未逐条核对。
- **Bun 的官方文档自相矛盾**（compat 页 Fully implemented vs reference 页 Not implemented）；PR #32498 于 2026-07-17 merged，但哪个发布版本开始可用未在发布说明中逐条确认。
- **libsql fork 的 SQLite 版本**、STRICT 表 / 生成列等版本特性差异未逐条核对。
- **libsql 本地模式 WAL 行为**（journal_mode 默认、busy 语义）本次未找到一手陈述。

## 来源

**node:sqlite（一手）**

- [Node.js API: SQLite（含 History 表）](https://nodejs.org/api/sqlite.html) · [文档源 doc/api/sqlite.md](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md) · [Node 22.x 文档](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)（Stability 1.1）
- 实测:`npx node@22.12.0`（无 flag → `ERR_UNKNOWN_BUILTIN_MODULE`；`--experimental-sqlite` → SQLite 3.47.0）、`npx node@22.13.0`（无 flag → 3.47.2）、本机 `node v26.2.0`（SQLite 3.53.1；JSON/WAL/busy_timeout/upsert/STRICT 实测）

**SQLite 语义（一手）**

- [Write-Ahead Logging](https://sqlite.org/wal.html)（读者/写者互不阻塞；不支持网络文件系统）· [JSON Functions](https://sqlite.org/json1.html)（默认内置）· [UPSERT](https://sqlite.org/lang_upsert.html) · [BEGIN/事务](https://sqlite.org/lang_transaction.html)（IMMEDIATE）· [Foreign Keys](https://sqlite.org/foreignkeys.html)（默认关闭）

**@libsql/client / Turso（一手）**

- [TypeScript SDK Reference](https://docs.turso.tech/sdk/ts/reference)（四包对照表、事务模式表、batch/interactive、并发 20、嵌入式副本、加密）· [TypeScript Quickstart](https://docs.turso.tech/sdk/ts/quickstart)（「Recommended: @tursodatabase/database (Local / Embedded)」）
- 仓库:[libsql-client-ts](https://github.com/tursodatabase/libsql-client-ts)（README、`src/node.ts`、`src/sqlite3.ts`、`src/web.ts`、`libsql-core/src/config.ts`、`libsql-core/src/api.ts`）
- npm registry 实测（2026-09-30）:`@libsql/client@0.18.0`、`libsql@0.5.29`、`@libsql/core@0.18.0`、`@libsql/hrana-client@0.10.0`、`@tursodatabase/database@0.8.1`、`@tursodatabase/serverless@1.4.0` 的依赖/`dist.unpackedSize`/发布时间；安装树 = `npm install --package-lock-only` 解析

**运行时覆盖（一手）**

- [Cloudflare Workers compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)（`enable_nodejs_sqlite_module`，Default as of 2026-01-29，描述为 stub）· [Cloudflare Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Deno node:sqlite](https://docs.deno.com/api/node/sqlite/) · [Deno 2.2 release](https://deno.com/blog/v2.2) · [Deno Node APIs](https://docs.deno.com/runtime/reference/node_apis/)
- [Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat)（node:sqlite 🟢 Fully implemented）· [Bun API reference: node:sqlite](https://bun.com/reference/node/sqlite)（Not implemented——矛盾项）· [Bun PR #32498（merged 2026-07-17）](https://github.com/oven-sh/bun/pull/32498) · [Bun v1.4](https://bun.com/blog/bun-v1.4)

**仓库内（一手）**

- `packages/core/src/memory/store.ts`、`memory/types.ts`、`workflows/snapshot.ts`、`durable-agent/snapshot.ts`、`schedules/types.ts`、`schedules/in-memory-store.ts`
- `docs/architecture/storage.md`（CAS 参考形状、adapter 清单、演化纪律）、`docs/architecture/harness.md`（快照端口与可选扩展）、`docs/architecture/memory.md`
