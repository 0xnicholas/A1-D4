# 调研:croner 现状（next helper 的 API/体积/DST 输入）

> Issue: #71 · 日期:2026-09-30 · 分支:`research/croner` · 性质:事实收集（API 面、体积、依赖、DST 语义、与 `NextFn` 形状对齐），不做决策。
> 测量环境:Node v26.2.0 / npm 11.13.0（Darwin）;契约性用例在 Node v22.23.2（与仓库 engines 基线 22.12 同线）复跑一致。npm 数字为 2026-09-30 快照。

## TL;DR

- **包**:croner 10.0.1,MIT,零运行时依赖,engines `>=18.0`,`type: module` 且 ESM/CJS/UMD 三构建 + 双 d.ts;单维护者 hexagon;npm 周下载 **11,397,812**（2026-09-22~28,node-cron 同期 5,877,556）;`npm audit --omit=dev` 0 漏洞。
- **体积**:安装树 = **1 包**（0 依赖）;`dist/croner.js` 实测 **27,551 B / gzip 8,059 B**;registry `dist.unpackedSize` 154,686 B。README 自报「Minified 22.7 KB / minzip 6.8 KB」是 2023-10-10 的旧口径。
- **与 `NextFn` 对齐**:`nextRun(from?)` 的签名与语义逐字对上框架的 `next: (from: Date) => Date | null`——严格「from 之后」、结果毫秒归零、穷尽返回 `null`（一次性时刻已过、年份界外均实测）;不带 fn 的构造是**惰性**的（不登记 `scheduledJobs`、不起定时器）。
- **DST 缺口**:v10.0.1 实测**不「跳过」**——春季跳变日 `30 2 * * *`（Europe/Stockholm）返回 `2026-03-29T01:30:00Z`,本地渲染 **03:30 CEST**,与 `30 3 * * *` 的返回**同一时刻**;而 README 写的是「gaps are skipped」。重叠日与 README 一致（只跑第一次出现）。见 §4。
- **记录形状偏差**:票面写的 `ScheduleRecord.host` 在类型中**不存在**;记录只带 `timezone?: string`（IANA,原样）,cron **表达式本身不落记录**——宿主须自存「id ↔ 表达式」并在加载时重建 `Cron`。见 §5。
- **错误面**:`new Cron(expr)` 同步抛 `TypeError`（part 数/非法字符/`@reboot` 等结构性错误）或 `RangeError`（数值越界）;**非法 IANA 时区延迟到 `nextRun` 才抛 `TypeError`**。

## 1. 包与维护现状

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 版本 / 许可 | 10.0.1 / MIT | [registry](https://registry.npmjs.org/croner) |
| 运行时依赖 | 0（`dependencies` / `peerDependencies` 均无） | registry + 本地 `npm install --dry-run`（added 1 package） |
| engines | `node >= 18.0` | registry `engines` |
| 模块面 | `type: module`;`exports` 同时给 `import`（d.ts）/ `require`（d.cts）/ `browser`（umd）;`files: dist/*` | 本地 `node_modules/croner/package.json` |
| 维护者 | hexagon（单一维护者） | registry `maintainers` |
| 维护信号 | 未归档;latest release `10.0.1`（2026-02-01）;最近提交 2026-03-01（renovate 合并）;open issues 4;stars 2,597 | [GitHub API](https://api.github.com/repos/hexagon/croner) |
| npm 元数据更新 | 2026-09-28T22:24Z（`time.modified`;版本仍 10.0.1） | registry |
| 周下载 | 11,397,812（2026-09-22~28）;node-cron 5,877,556 | [npm downloads API](https://api.npmjs.org/downloads/point/last-week/croner) |
| 安全 | `npm audit --omit=dev` → 0 vulnerabilities | 本地实测 |
| 文档 / 镜像 | 文档站 croner.56k.guru;JSR `@hexagon/croner`;Deno/Bun/浏览器均支持 | [README](https://raw.githubusercontent.com/Hexagon/croner/master/README.md) |

## 2. API 面（next 计算所需子集）

构造:`new Cron(pattern: string | Date, options?: CronOptions, fn?)`。

- **纯计算用法（本框架所需）**:`new Cron(expr, { timezone })` 不带 fn——**惰性**,不注册、无定时器（实测 `scheduledJobs.length === 0`;源码亦只在传入 fn 时调 `schedule()`）。
- **occurrence 方法**（[d.ts](https://raw.githubusercontent.com/Hexagon/croner/master/dist/croner.d.ts)）:
  - `nextRun(prev?: CronDate | Date | string | null): Date | null`
  - `nextRuns(n: number, previous?: Date | string): Date[]`
  - `previousRuns(n, reference?)` / `previousRun()` / `currentRun()` / `msToNext(from?)`
  - `match(date): boolean`,`getPattern(): string | undefined`,`getOnce(): Date | null`
- **控制方法**（`trigger` / `pause` / `resume` / `stop`）与状态（`isRunning` / `isStopped` / `isBusy`）存在,但纯计算包装不需要;`stop()` 会从 `scheduledJobs` 摘名。
- **`getPattern()` 返回原样字符串**（首尾空格不归一:输入 `"  0 9 * * MON  "` → 返回同串）;一次性模式返回 `undefined`（改用 `getOnce()`）。

### CronOptions 全字段（d.ts）

`name, paused, kill, catch, unref, maxRuns, interval, protect, startAt, stopAt, timezone, utcOffset, domAndDow, dayOffset, legacyMode(deprecated), mode, context, alternativeWeekdays, sloppyRanges`。

与 next 计算相关的:`timezone`（IANA 名）、`startAt` / `stopAt`（参与 `nextRun` 的钳制）、`utcOffset`（**与 `timezone` 互斥**,组合即抛 `Error`;显式不处理 DST）、`mode`（`auto | 5-part | 6-part | 7-part | 5-or-6-parts | 6-or-7-parts`）、`domAndDow`（默认 OR,`true` 为 AND）。

### 模式语法（差异点）

- 5 段 = 标准 Vixie（minute 起）;**6 段加秒、7 段再加年份**（1–9999）——注意 croner 的 6 段是「秒在前」,不是「年」。
- 扩展:`L`（末日 / 某 weekday 的最后一次）、`W`（最近工作日）、`#`（第 n 个 weekday）、`+`（day-of-month AND day-of-week 的显式 AND）;`?` 兼容别名;`@yearly/@monthly/@weekly/@daily/@midnight/@hourly` 昵称（`@reboot` 明确抛错）。JAN-DEC / SUN-SAT 名字大小写不敏感。Quartz weekday 编号需 `alternativeWeekdays: true`。

## 3. 与框架 `NextFn` 对齐（实测）

框架侧（`packages/core/src/schedules/types.ts`）:`ScheduleSaveInput.next: (from: Date) => Date | null`,语义「first occurrence **strictly after** `from`,or `null`」。

| 用例 | croner 实测（UTC,`0 0 * * *`） | 结论 |
| --- | --- | --- |
| `nextRun(2026-01-01T00:00:00Z)`（恰为发生时刻） | `2026-01-02T00:00:00Z` | 严格 after ✓ |
| `nextRun(2025-12-31T23:59:59.999Z)` | `2026-01-01T00:00:00Z` | ✓ |
| 返回值毫秒 | `0` | 毫秒归零（d.ts:「Strips milliseconds」）✓ |
| 秒级模式 `*/5 * * * * *`,from `…00:00:00.500Z` | `…00:00:05.000Z` | 毫秒剥离不破坏严格性 ✓ |
| 一次性时刻已过 | `null` | 穷尽 → `null` ✓ |
| 7 段年份界外（`… * 2020`） | `null`（界内 2027 → `2027-01-01T00:00:00Z`） | ✓ |
| `Asia/Shanghai` `0 9 * * *` | `2026-01-01T01:00:00Z` | IANA 时区按绝对时刻计算 ✓ |
| 不带 fn 构造 | `scheduledJobs.length === 0` | 惰性构造 ✓ |

`from` 可传 `Date`（框架形状）或 ISO 字符串（签名允许）;无参时以「现在」为基准。

## 4. DST 语义（Europe/Stockholm,2026）

README 原文:「Proper DST handling: Jobs scheduled during DST gaps are skipped; jobs in DST overlaps run once at first occurrence.」

**春季跳变日 2026-03-29（02:00 CET → 03:00 CEST;UTC 01:00Z 处跳变）**——从 `2026-03-28T12:00:00Z` 起:

| 模式 | `nextRun` 返回 | 本地渲染 |
| --- | --- | --- |
| `0 1 * * *` | 2026-03-29T00:00:00Z | 01:00 CET |
| `0 2 * * *` | 2026-03-29T01:00:00Z | **03:00 CEST**（跳变瞬间） |
| `15 2 * * *` | 2026-03-29T01:15:00Z | 03:15 CEST |
| `30 2 * * *` | 2026-03-29T01:30:00Z | **03:30 CEST** |
| `0 3 * * *` | 2026-03-29T01:00:00Z | 03:00 CEST（与 `0 2` 同一时刻） |
| `30 3 * * *` | 2026-03-29T01:30:00Z | 03:30 CEST（与 `30 2` 同一时刻） |

读数:**缺口内的本地时刻没有「被跳过」**,而是按跳变前的偏移算成时刻——02:xx 模式落到本地 03:xx,并与同分钟的 03:xx 模式**撞同一时刻**。README 的「skipped」措辞与 10.0.1 实测不符（实测口径用本地渲染交叉验证:01:00Z = 03:00 CEST）。

**秋季重叠日 2026-10-25（03:00 CEST → 02:00 CET;UTC 00:00Z 处跳变）**:

| 模式 | `nextRun` 返回 | 本地渲染 |
| --- | --- | --- |
| `30 2 * * *` | 2026-10-25T00:30:00Z | 02:30 **CEST**（第一次出现） |
| `0 3 * * *` | 2026-10-25T02:00:00Z | 03:00 CET |
| `30 2 * * *` 的 `nextRuns(2)` | `[2026-10-25T00:30Z, 2026-10-26T01:30Z]` | 只跑一次;次日 02:30 CET ✓ |

读数:重叠日与 README 一致（只跑第一次出现）,第二天的下一次回到正常偏移。

## 5. 记录形状对齐的偏差（票面与类型的出入）

- 票面写「`ScheduleRecord.host`（表达原文）」——**类型里没有 `host` 字段**。`ScheduleRecord` 共 `id / nextFireAt / target / timezone? / enabled / metadata?`;`timezone` 的 JSDoc 写明它是「IANA 名,核心从不解释,交给宿主:构建 `next` 函数（如 croner 包装）的材料,或展示用」。
- 文件头注释钉死:**`next` 函数不属于记录**（函数不序列化）,由 `createSchedules().save()` 在进程内按 id 与持久记录配对。
- 含义（事实层面）:表达式本身**不落记录**。包装的可行形态是「宿主自己保存 id ↔ 表达式（如自身配置）」,加载时 `new Cron(expr, { timezone: record.timezone })`,再以 `save({ id, next: (from) => cron.nextRun(from) })` 注册;`getPattern()` 能读回原串,但不能替代持久化。
- 对齐点:`ScheduleRecord.timezone` 是 IANA 名、原样携带 → 可直接作为 croner `timezone` 选项;`utcOffset` 与框架的 IANA 口径无关,且不处理 DST。

## 6. 错误面（实测）

| 输入 | 抛出 | 备注 |
| --- | --- | --- |
| `not a cron` | `TypeError` | 「exactly five, six, or seven space separated parts are required」 |
| `61 * * * *` | `RangeError` | 「Invalid value for minute: 61」 |
| `0 0 32 * *` | `RangeError` | 日越界（消息里按内部 0-based 显示 `day: 31`） |
| 7 段里把年写在第 6 段 | `RangeError` | 「Invalid value for dayOfWeek: 2020」——6 段第 6 位是 weekday |
| `@reboot` | `TypeError` | 「not supported in this environment」 |
| `{ timezone: 'Planet/Nowhere' }` | 构造**不抛**;`nextRun` 时 `TypeError` | 「CronDate: Failed to convert date to timezone …」（校验是惰性的） |

## 7. 体积与同类对照

- 安装树（实测,沿 #6 方法）:`npm install --dry-run croner` → **added 1 package**;`npm ls --all` 仅 `croner@10.0.1`;registry unpackedSize 154,686 B。
- 实测量（dist 文件,本机）:`croner.js` 27,551 B / gzip 8,059 B;`croner.cjs` 28,057 B / gzip 8,272 B;`croner.umd.js` 27,770 B / gzip 8,186 B。
- 同类一句对照（仅记录,不比较选型）:`node-cron@4.6.0` 现无 `dependencies` 字段（实测）;`cron-parser` 依赖 `luxon@^3.7.2`（实测）。croner README 的对照表（2023-10-10 口径）把 croner 记作 0 依赖、node-cron 1 依赖。

## 8. 结论指向（事实小结,不做决策）

1. 「`next` helper」的包装在 API 面几乎零成本:`(from) => cron.nextRun(from)` 直接满足 `NextFn` 的签名与严格性;构造惰性,不引入定时器或运行时负担;唯一依赖 croner 本身,安装树 1 包。
2. 决策票需要处置的两点事实:**DST 缺口语义**（实测为「偏移映射 + 与 +1h 模式撞时刻」,非 README 的「跳过」）,以及**表达式不落记录**带来的宿主侧 id ↔ 表达式保存责任（票面 `host` 字段不存在）。
3. 兼容性:engines `>=18`;Node 22.23.2（与仓库基线 22.12 同线）与 Node 26.2.0 用例全一致。

## 附:来源

- npm registry（逐字段）:<https://registry.npmjs.org/croner>（2026-09-30 快照;`time.modified` 2026-09-28T22:24Z）
- npm 下载量 API:<https://api.npmjs.org/downloads/point/last-week/croner>（2026-09-22~28）
- GitHub 仓库 / releases / commits API:<https://api.github.com/repos/hexagon/croner>
- croner README（master）:<https://raw.githubusercontent.com/Hexagon/croner/master/README.md>（DST 措辞、选项表、模式语法、对照表）
- croner 文档站「examples」:<https://croner.56k.guru/usage/examples/>
- 类型定义:d.ts（<https://raw.githubusercontent.com/Hexagon/croner/master/dist/croner.d.ts>）与本地 `node_modules/croner/dist/croner.d.ts`
- 本仓库:`packages/core/src/schedules/types.ts`（`ScheduleRecord` / `ScheduleSaveInput.next`）
- 本地实测（2026-09-30,Node v26.2.0 + v22.23.2 / npm 11.13.0,Darwin）:`/tmp/croner-probe`（dry-run 安装树、dist 字节、npm audit、DST 与错误面探针）
