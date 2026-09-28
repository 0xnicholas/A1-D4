# 多 agent 协作:as-tool 组合为唯一规范形态,核心零内建委派协议

多 agent 协作的规范形态定为 **as-tool 组合**:Agent 经 `description` + `generate`/`stream` 包装为 Tool 进入父 agent 容器,核心不内建 `agents` 字段与 supervisor 委派协议——正式了结 ADR-0005 的暂缓项,且不永久裁出(演化门见 Consequences)。依据:mastra 委派协议的配套机器(messageFilter、memory 隔离、delegation 钩子、result references)全部服务于「委派隐式共享父上下文」这一前提,而 as-tool 显式组合下父上下文默认零透传,这些机器退化为用户态平凡代码,内建买到的只是人体工学;按可逆性不对称原则(ADR-0005),字段后加是 minor、先加后删是 major,默认砍。配套两条边界:**嵌套审批不支持**——审批闸只挂最外层入口 agent(与「Harness 持有 agent」同构),内层 sub-agent 不做 durable 包装,sub run 以 `suspended` 收尾时包装器按普通文本结果回喂,恢复 = 应用层 resume sub + signal 唤醒父;**trace 连续性缝**——工具 ctx 增写 `traceId` 与 `spanId`(四件套 → 六件套,修订 ADR-0008 的 ctx 表面),委派 run 经既有 run option 挂为当前 tool-call span 的子 span,多 agent 观测树不断裂。

## Considered Options

- **内建 supervisor 最小集(`agents` 字段 + 委派为 loop 内工具调用)**:被否——语义件在显式组合下全部用户态可表达,内建买到的只是人体工学;按可逆性不对称,人体工学以后能补,字段加了收不回。
- **核心 `asTool()` 助手**:被否(暂缓)——标准化 signal/trace 透传的价值真实,但目前是五行用户态代码的语法糖;真实痛点出现时随演化门一并评估。
- **正式裁出规范(多 agent 永不入规范)**:被否——与「从原型到生产一体化」叙事相悖,且 `description` 字段(ADR-0005)正为 as-tool 而留;裁的是内建协议,不是协作叙事。
- **支持嵌套挂起传播(mastra 式审批沿委派链)**:被否——快照套快照 + resume 级联是实重,与「挂起语义只在 durable 包装内存在」(ADR-0011)冲突;组合规则(闸挂入口)已覆盖主场景。

## Consequences

- 演化门:真实需求信号(as-tool 模式的重复痛点——包装样板、传播遗漏、嵌套审批诉求)触发重开;落点 = `createSupervisor` 类**能力包优先**(全部可建于公开表面),仅当能力包证明需要核心新缝时才以 minor 字段进核心。归路线图(#16)阶段判断,已登记地图 Not yet specified。
- ADR-0008 的 ctx 表面修订:additive-only 纪律下四件套增为六件套(+`traceId`、`spanId`),属 minor。
- `docs/architecture/agent.md`「多 agent 组合」节承载完整 recipe;`docs/architecture/tools.md` 组合范式同步 trace 衔接写法。

(来源:wayfinder ticket #19)
