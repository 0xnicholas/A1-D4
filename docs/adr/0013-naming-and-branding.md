# 命名与品牌:对外名 balsa,npm scoped `@balsa/*`,GitHub 个人账号同名仓库

对外项目名定为 **balsa**——最轻的结构木材,"轻但能承重",是「按需组合 + 无运行时负担」(ADR-0001)这一轴的现成隐喻;代号 A1-D4(Attempt 1, Draft 4)退役为历史。npm 采用 **scoped 命名空间**:核心包 `@balsa/core`,能力包一律 `@balsa/<能力>` 短名词、无类型后缀——首版清单 `@balsa/mcp-server`、`@balsa/mcp-client`、`@balsa/otlp`、`@balsa/sqlite`、`@balsa/ai-sdk`、`@balsa/bunfold`;非 scoped `balsa` 已被一个浏览器日志库占用,不争取。GitHub 归属 = 个人账号原地改名 `0xnicholas/balsa`(org 名 `balsa` 被占,派生 org 会造成品牌与仓库不同名的割裂)。定位一句话(英文,兼作 repo description 与 README 首句):"Balsa is an ultralight TypeScript agent framework — compose only what you use, run anywhere, no runtime baggage."

## Considered Options

- **沿用代号 A1-D4**:被否——`a1d4` 在 npm 非 scoped、npm scope、GitHub 三处全空(2026-09-28 查实)且暗合机器人命名,但零表意,候选词中 balsa 的隐喻与「轻量」轴直接对齐,表意价值压过蹲守便利。
- **争取非 scoped `balsa` 转让**:被否——现占用方为低活跃浏览器日志库(1.1.0,2025-01 最后更新),协商周期不可控,而命名是 M1 末 0.1 发布的门(见 #16),不能堵。
- **非 scoped 派生名(`balsa-core`、`balsa-mcp-server` 式)**:被否——不合 TS 生态惯例,能力包名无命名空间保护、易被蹲;scoped 与「按需组合」的包结构(ADR-0002)一一对应。
- **新建 GitHub org 派生名(`balsa-ai`/`balsafw` 等)**:被否——`balsa` org 名已被占,任何派生 org 都让品牌与仓库地址不同名;个人账号同名仓库保留完整品牌面,未来需要时仍可迁入 org(GitHub 迁移自带 redirect)。

## Consequences

- M1 末 0.1 发布门的「定名」前置解除(见 `docs/ROADMAP.md`)。
- 发布 0.1 前需创建 npm org `@balsa`(截至 2026-09-28,该 scope 名下无任何已发布包,可申领;`@balsa/core` 等全部 FREE);org 创建依赖 owner 的 npm 账号,属 M1 实施期 task。
- `CONTEXT.md` 更名为 Balsa 并登记核心包/能力包的具体包名;`AGENTS.md` 同步仓库名;文档内 issue 链接统一改写为 `0xnicholas/balsa`(旧 `0xnicholas/A1-D4` 链接经 GitHub redirect 仍有效)。
- 公共面(README、npm、GitHub description)英文为主;中文文档现状不动。

(来源:wayfinder ticket #20)
