# 调研:轻量化基准与 MCP 现状(issue #6)

调研日期:2026-09-28 · 分支:`research/lightweight-benchmarks-mcp` · 目标:为"极致轻量"定位提供可验证的量化参照系,并摸清 MCP 支持成本。**本文只呈现事实,不做决策。**

## TL;DR

- "轻量"在 npm 生态有清晰的可验证坐标:零依赖(hono/zod)、个位数直接依赖(ai SDK v7 = 3 个)、两位数直接依赖即进入"重"区间(mastra/core = 30 个直接依赖、152 个安装包、≥93 MiB)。
- Hono 守住轻量的三件套:**零 runtime 依赖 + preset 分层(公开字节预算)+ PR 上的 CI bundle-size 回归检查**(esbuild minify 后量字节、octocov 出 PR 评论)。
- Edge 硬约束现状:Vercel Edge 按 **gzip 后 1 MB(Hobby)/ 2 MB(Pro)/ 4 MB(Enterprise)** 卡 bundle,是当前最紧的约束;Cloudflare Workers 自 2026-09-04 起只看**未压缩 64 MiB**,真正的硬预算是 **1 秒 startup time**(全局作用域 parse+execute)。
- MCP:官方 TS SDK 已换代。v1 单包 `@modelcontextprotocol/sdk` 要拉 **92 个安装包**(express+hono 双 web 框架都被硬依赖);v2(当前 stable,对齐 2026-07-28 spec)拆成 server/client 两包,**server 端边际成本 ≈ 2 个包**(core+server,zod 复用),client 端 13 个包 / 14.1 MiB。对已有 zod@4 的框架,v2 server 支持几乎零新增依赖。

---

## 1. 同类框架体量基准

### 方法学

- 直接/peer 依赖:npm registry `https://registry.npmjs.org/<pkg>/latest` 清单(2026-09-28 快照)。
- 安装树包数:`npm install --dry-run <pkg>`(npm 11.13.0,空目录、自动安装 peerDependencies;**只解析元数据,不写入 node_modules**)。
- 安装体积:对安装树上每个 `name@version` 取 registry `dist.unpackedSize` 求和。部分老包的元数据缺该字段(express 树缺 7 个、mastra 树缺 13 个、v1 MCP SDK 树缺 9 个),故**体积为下界**。
- packagephobia 的公开 API 当前被其前置安全检查拦截,未采用;上述 registry 方法等价且可复现。

### 基准表(按"轻→重"排序)

| 包@版本 | 直接依赖 | peer 依赖 | 安装树包数 | 安装体积(unpacked 合计,下界) | 包自身 unpacked |
| --- | --- | --- | --- | --- | --- |
| hono@4.13.9 | **0** | 0 | 1 | 1.3 MiB | 1.33 MiB |
| zod@4.6.5 | **0** | 0 | 1 | 5.9 MiB | 5.86 MiB |
| @modelcontextprotocol/server@2.1.0(MCP v2) | 2 | 0 | 3 | 13.2 MiB | 6.14 MiB |
| ai@7.0.118(Vercel AI SDK) | 3 | zod | 11 | 17.7 MiB | 7.37 MiB |
| @langchain/core@1.2.13 | 7 | 0 | 12 | 38.2 MiB | 7.28 MiB |
| @modelcontextprotocol/client@2.1.0(MCP v2) | 7 | 0 | 13 | 14.1 MiB | 6.44 MiB |
| @langchain/langgraph@1.4.18 | 4 | zod, @langchain/core | 22 | 47.8 MiB | 4.19 MiB |
| langchain@1.5.14 | 4 | @langchain/core | 23 | 50.9 MiB | 3.09 MiB |
| express@5.2.1(对照组) | 28 | 0 | 66 | ≥2.0 MiB | 0.07 MiB |
| @modelcontextprotocol/sdk@1.30.1(MCP v1) | 17 | zod, @cfworker/json-schema | 92 | ≥16.2 MiB | 4.14 MiB |
| @mastra/core@1.71.0 | **30** | zod | **152** | **≥93.3 MiB** | **65.8 MiB** |

### 读数要点

- **包数与体积可以脱钩**:express 有 66 个安装包但合计仅约 2 MiB(大量微型工具包);`@langchain/core` 只有 12 个包却有 38.2 MiB——其中 [`js-tiktoken@1.0.21`](https://registry.npmjs.org/js-tiktoken/1.0.21) 单包 21.4 MiB(tokenizer 词表数据),一个"功能型"依赖即可超过整个框架本体。
- **mastra/core 的体积主要是发布物形态**:其单包 65.8 MiB 中大头是 dist 内的 source map(单个 `agent-*.js.map` 达 3.5 MiB)、`dist/docs`(3.7 MiB)、`dist/_types`(3.6 MiB)、`dist/test-utils`(2.0 MiB)(来源:[unpkg 文件清单](https://unpkg.com/@mastra/core@1.71.0/?meta))。30 个直接依赖里还包含 ws、execa、posthog-node、两个版本的 @a2a-js/sdk、三套 @ai-sdk/provider-v5/v6/v7 等。
- **Vercel AI SDK v7 已相当薄**:3 个直接依赖(@ai-sdk/gateway、@ai-sdk/provider、@ai-sdk/provider-utils)+ zod peer;树上出现 undici、@vercel/oidc、@workflow/serde,合计 11 包。
- **LangChain.js 在 1.x 已大幅瘦身**(集成包全部外置),核心三件套树规模 12–23 包;体积主要来自 zod(5.9 MiB)、langsmith(3.25 MiB)与 js-tiktoken。
- **peer 依赖是隐性成本**:`ai`、`@langchain/langgraph`、`@mastra/core` 都把 zod 列为 peer,实际安装时(npm ≥7)会被自动拉入。

## 2. Hono 如何表达并守住"轻量"

事实均来自 [honojs/hono 仓库](https://github.com/honojs/hono)与[官方文档](https://hono.dev/docs/):

1. **零 runtime 依赖**:package.json 无 `dependencies`(registry 可独立验证);只用 Web Standard API,因此同一代码可跑在 Cloudflare Workers / Deno / Bun / Node / Lambda / Fastly。
2. **preset 分层 + 公开字节预算**:同一 `Hono` 类按路由器分 preset——`hono`(SmartRouter)、`hono/quick`、`hono/tiny`(PatternRouter)([presets 文档](https://hono.dev/docs/api/presets));官网公开承诺 "`hono/tiny` preset is under 14kB"。该数字在历代 README 中公开可考且缓涨(12kB → 13kB → 14kB),说明它是一条**长期维护的公开预算线**,而非一次性宣传。
3. **CI 体积回归检查**:
   - [`perf-measures/bundle-check/scripts/check-bundle-size.ts`](https://github.com/honojs/hono/tree/main/perf-measures/bundle-check/scripts):用 esbuild 把 `dist/index.js` bundle + minify(esm, target es2022),直接量字节数,输出 `bundle-size-check` 自定义指标。
   - [`.github/workflows/ci.yml`](https://github.com/honojs/hono/blob/main/.github/workflows/ci.yml) 中的 `perf-measures-check-on-pr` / `perf-measures-check-on-main` job(调用 `./.github/actions/perf-measures`)在每个 PR 与 main 分支上运行;配合 [octocov 配置](https://github.com/honojs/hono/blob/main/perf-measures/.octocov.consolidated.perf-measures.yml)把 bundle size 作为 custom metric 发到 PR 评论与 summary——**体积回归在 review 阶段可见**。
   - 另有 `http-benchmark-on-pr` job 在 PR 上跑 HTTP 吞吐基准,防速度回归。
4. **可借鉴的表达口径**:Hono 量的不是 node_modules 体积,而是"**自身代码经 esbuild minify 后的字节数**"——这正是 edge 平台计费/限制的口径(见下节),也是用户实际付出的成本。

## 3. Edge / serverless 运行时的硬约束

### Cloudflare Workers([官方 limits 页](https://developers.cloudflare.com/workers/platform/limits/),2026-09 现行)

| 约束 | Workers Free | Workers Paid |
| --- | --- | --- |
| Worker size | **64 MiB(未压缩)** | 64 MiB(未压缩) |
| Startup time | **1 秒** | 1 秒 |
| CPU time / 请求 | 10 ms | 30 s(可调至 5 min) |
| 内存 / isolate | 128 MB | 128 MB |

- **体积口径刚变过**:[2026-09-04 changelog](https://developers.cloudflare.com/changelog/) 取消了压缩后 3 MB(Free)/ 10 MB(Paid)的限制,改为只看未压缩 64 MiB,Free/Paid 同权。"bundle 大小"在 Cloudflare 上已基本不是约束。
- **真正的硬预算是 startup time 1 秒**:全局作用域(顶层代码)必须在 1 秒内 parse+execute 完毕,超限部署被拒(error 10021);官方点名"在顶层生成/消费大型 schema"是常见超限原因。可用 `wrangler check startup` 与 `wrangler deploy --dry-run` 本地预检。
- **冷启动**:Workers 用 V8 isolates,[官方称该模型"消除了虚拟机模型的冷启动",isolate 启动比容器内 Node 进程快约两个数量级](https://developers.cloudflare.com/workers/reference/how-workers-works/)。

### Vercel Edge Runtime([官方文档](https://vercel.com/docs/functions/runtimes/edge))

| 计划 | bundle 上限(gzip 压缩后) |
| --- | --- |
| Hobby | **1 MB** |
| Pro | **2 MB** |
| Enterprise | **4 MB** |

- 上限含函数的全部 JS、依赖与打包文件——**框架和用户代码共享这 1–4 MB**。
- 须在 25 秒内开始返回响应;流式可持续至 300 秒。
- 仅提供 Web API 子集 + 少量 Node 模块(events/buffer/util 等);禁止 `eval` 等动态代码执行;node_modules 只在"纯 ESM 且不用 Node API"时可用。Edge runtime 基于 V8 isolates,无容器,冷启动近零。
- 生态信号:同一文档注明 **Next.js 16.3 起移除 `runtime = 'edge'`**,Edge runtime 在 Vercel 体系内正向 middleware/独立 Functions 收缩。

### 对"轻量"框架的含义(事实陈述)

- 若目标平台包含 Vercel Edge Hobby,框架 gzip 后预算必须给用户代码留足空间——框架自身 gzip bundle 需远小于 1 MB(量级上落在几十到几百 KB)。
- 在 Cloudflare 上,bundle 字节数让位于**顶层初始化耗时**(1 s startup):延迟初始化、避免顶层构建大对象,比再省几 KB 更关键。

## 4. MCP(Model Context Protocol)现状

### 规范与 SDK 代际

- 规范最新版为 [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)。
- 官方 TS SDK([modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk))**已换代**:
  - **v2(当前 stable)**:`main` 分支,对齐 2026-07-28 spec,拆分为 `@modelcontextprotocol/server` 与 `@modelcontextprotocol/client` 两个包,外加可选的 thin middleware 包(`@modelcontextprotocol/node` / `express` / `fastify` / `hono`)。工具/prompt schema 走 [Standard Schema](https://standardschema.dev/),可自带 Zod v4、Valibot、ArkType 等。
  - **v1(legacy)**:单包 `@modelcontextprotocol/sdk`(最新 1.30.1),v2 发布后至少再维护 6 个月 bug fix/安全更新。

### 依赖成本(2026-09-28 实测,方法同第 1 节)

**Server 侧(把框架的工具暴露为 MCP server):**

- v2:`@modelcontextprotocol/server@2.1.0` 直接依赖只有 `@modelcontextprotocol/core` + `zod`;安装树 **3 个包**、13.2 MiB(其中 zod 占 5.9 MiB,server 自身 6.14 MiB)。**若框架本就以 zod@4 为 schema 基础,边际成本 ≈ 2 个包、约 7.4 MiB。**
- v1:`@modelcontextprotocol/sdk@1.30.1` 直接依赖 17 个(express、hono、cors、ajv、jose、eventsource、express-rate-limit 等全量硬依赖),安装树 **92 个包**、≥16.2 MiB。

**Client 侧(消费外部 MCP server):**

- v2:`@modelcontextprotocol/client@2.1.0` 直接依赖 7 个——core、zod、jose + pkce-challenge(OAuth)、cross-spawn + which/shebang 系(stdio 拉起子进程)、eventsource + eventsource-parser(SSE);安装树 **13 个包**、14.1 MiB。

**形态参考(v2 server,stdio):**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });
server.registerTool('greet', { description: '...', inputSchema: z.object({ name: z.string() }) },
  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }));
await server.connect(new StdioServerTransport());
```

### 读数要点

- MCP 支持的依赖成本**主要取决于选哪一代 SDK**:v1 是 92 个安装包且硬拉 express+hono 两个 web 框架;v2 server 端对 zod 系框架几乎零边际成本,client 端中等(13 包,大头是 OAuth/SSE/stdio 这些传输与鉴权能力,属功能必需而非浪费)。
- v2 的 middleware 包设计(express/fastify/hono 各自独立、刻意保持 thin)意味着框架方可以只暴露自己运行时需要的适配,不必继承整个 Web 框架栈。

## 5. 结论指向(数据可支撑的水位,供决策参考)

1. **"轻量"的可验证量化标准,生态已给出刻度**:
   - 直接 runtime 依赖:**0 个**(hono/zod 水位)→ **≤5 个**(ai SDK v7 水位)是已被头部项目验证可达的;30 个(mastra)是明确的"重"端点。
   - 安装树:**≤15 个包 / ≤20 MiB unpacked** ≈ ai SDK v7 当前水位;LangChain 系在 12–23 包 / 38–51 MiB;mastra 152 包 / ≥93 MiB。
   - 更贴近用户的口径是 Hono 的:**框架自身 esbuild minify 后字节数**,并对 gzip 后数字做公开承诺(hono/tiny < 14 kB)。若要在 Vercel Edge Hobby(1 MB gzip 总量,含用户代码)上可用,框架 gzip 预算量级应在 ~100–300 KB 以内。
2. **守住轻量的工程机制(Hono 已验证的三件套)**:零(或近零)runtime 依赖;preset/子路径分层让用户只付所用;CI 在 PR 上做 bundle-size 回归(esbuild 量字节 + octocov 评论)。Cloudflare 侧对应补充一条 **startup time ≤ 1 s** 的预算(`wrangler check startup` 可本地量化)。
3. **MCP 支持成本**:走 v2 SDK(@modelcontextprotocol/server + client),server 端边际 ≈ 2 个包(复用 zod@4),client 端 13 个包 / 14.1 MiB;v1 单包路径(92 包)应视为过时。总体判断:**MCP server 支持的依赖成本对"轻量"框架可忽略,client 支持的成本是中等、可按子路径/preset 隔离**。

## 数据来源

一手来源:

- npm registry 清单与 `dist.unpackedSize`:`registry.npmjs.org/{ai,langchain,@langchain/core,@langchain/langgraph,@mastra/core,hono,zod,express,@modelcontextprotocol/sdk,@modelcontextprotocol/server,@modelcontextprotocol/client,@modelcontextprotocol/core}`(2026-09-28 抓取;安装树由 npm 11.13.0 `--dry-run` 解析)
- [unpkg @mastra/core@1.71.0 文件清单](https://unpkg.com/@mastra/core@1.71.0/?meta)
- [Hono 文档(轻量承诺)](https://hono.dev/docs/) · [Hono presets](https://hono.dev/docs/api/presets) · [honojs/hono 仓库:ci.yml、perf-measures/bundle-check、octocov 配置](https://github.com/honojs/hono)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Cloudflare changelog(2026-09-04,64 MiB)](https://developers.cloudflare.com/changelog/) · [How Workers works(isolates 与冷启动)](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Vercel Edge Runtime 文档(1/2/4 MB gzip 上限等)](https://vercel.com/docs/functions/runtimes/edge)
- [modelcontextprotocol/typescript-sdk README(v2 拆包与迁移说明)](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
