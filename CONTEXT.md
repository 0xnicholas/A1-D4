# A1-D4

一个轻量的 TypeScript/Node agent 框架：设计目标对齐 mastra(从原型到生产的一体化体验),差异化轴是"轻量"。本文件是项目术语表——只放定义,不放实现细节与架构决策(后者在 `docs/adr/`)。

## Language

**轻量 (Lightweight)**:
本项目的差异化轴,两层含义:**按需组合**——用户只为用到的能力付出,不用的子系统既不占依赖树也不占概念空间;**无运行时负担**——不强制任何基础设施(DB、队列、长驻进程),随处可跑,嵌入宿主应用而不接管它。心智表面小是贯穿的设计品味,但不是轴。
_Avoid_: 把"轻量"等同于依赖数/字节数等硬性数字指标(数字仅作内部 CI 回归参考,不是定义)

**核心包 (Core package)**:
框架的单数核心 npm 包,以子路径导出各子系统入口;自身保持极小,是"按需组合"的载体。
_Avoid_: 内核、平台包

**能力包 (Capability package)**:
因携带外部依赖而与核心包隔离的独立 npm 包(如 MCP、OTel exporter、存储 adapter、AI SDK 互操作),用户按需安装。
_Avoid_: plugin、integration

**组合根 (Composition root)**:
可选的薄组装点,负责把 storage/logger/tracer 等横切依赖注入给挂上来的子系统;子系统不挂它也能独立完整使用。
_Avoid_: 中央实例、registry(易与模型注册表混淆)
