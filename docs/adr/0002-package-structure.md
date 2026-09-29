# 包结构:核心单包 + 能力包,组合根可选

pnpm monorepo。**核心单包**以子路径导出各子系统入口(如 `core/agent`、`core/workflows`),自身保持极小;携带外部依赖的能力(MCP、OTel exporter、存储 adapter、AI SDK 互操作)独立成**能力包**,用户按需安装——依赖隔离只能发生在包边界,子路径做不到。组合根(`createApp({ storage, logger, tracer })` 形态)是可选的薄注入点,负责分发横切依赖;子系统独立 `new` 始终是一等用法。刻意不做 mastra 式强制中央实例:它把一切耦合到一个注册对象上,拉低 tree-shaking 上限,与"嵌入而不接管"直接冲突。

## Considered Options

- **全单包、能力也走子路径**:被否——依赖是包级隔离,MCP/OTel 的依赖会变成核心硬依赖。
- **mastra 式每子系统一包**(core/memory/rag/evals/… 20+ 包):被否——发布与维护复杂度对小团队过重,且与子路径导出的粒度重复。
- **强制中央实例**(mastra 式 `new Mastra({...})`):被否,理由见上。

## Consequences

- **修订(M1-15 #36)**:组合根落地为 `createApp({ tracer })` + `app.agent(config)` 工厂——经工厂建出的 Agent 被动接受分发的 tracer(配置自带 tracer 时显式优先),不经工厂的独立 `new Agent(...)` 照旧一等;M1 只分发 tracer,`logger` / `storage` 的位留给后续里程碑。

(来源:wayfinder ticket #8)
