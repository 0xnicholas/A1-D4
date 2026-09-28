# Schema 校验契约:Standard Schema 双接口,无适配器

凡需要校验或生成 JSON Schema 的边界(tool 入参、workflow step IO 等),契约统一为 `StandardSchemaV1 & StandardJSONSchemaV1`(`@standard-schema/spec` 的类型):`~standard.validate()` 负责校验,`~standard.jsonSchema` 负责出 JSON Schema(给 LLM provider 发 tool schema 等场景)。用户自带 zod@4 / valibot / arktype 等实现;运行时成本仅为一次 validate 调用。我们**不写** Zod v3 / AI SDK Schema / 裸 JSON Schema 对象的适配层——mastra 的 schema-compat 包有数千行此类代码,是其重量来源之一;MCP v2 SDK 原生讲 Standard Schema,互通零成本。

## Consequences

- 核心包对 schema 库保持零依赖(schema 库成为用户的可选项)。
- 使用旧版 schema 库(如 Zod v3)的用户需要自行升级;这是有意的立场,不是缺陷。

(来源:wayfinder ticket #8)
