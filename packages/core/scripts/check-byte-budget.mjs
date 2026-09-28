// 字节预算黄灯(ADR-0001,M1-02 #23):比对 @balsa/core 构建产物的字节数,超预算给出黄灯。
// 口径 = esbuild minify 后每个子路径导出入口的 bundle 字节(与构建链解耦,见 ADR-0014/0015);
// 基线落 byte-budget.json,`--update` 用实测值重写。
// 退出码契约(ADR-0015):0 = 在预算内;1 = 需处理(黄灯,CI 用 `|| test $? -eq 1` 容忍);
// 2 = 配置/测量硬错误(口径不符、入口无产物、测量失败)——CI 照常变红。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const METRIC = 'esbuild-minified-bytes';
const BUDGET_FILE = 'byte-budget.json';
const UPDATE_HINT = 'pnpm byte-budget:update';
const EXIT_YELLOW = 1;
const EXIT_HARD_ERROR = 2;

/** 硬错误(不是"数字超了"):配置或测量问题,CI 不容忍。 */
function hardError(message) {
  console.error(message);
  process.exit(EXIT_HARD_ERROR);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    hardError(`读取 ${file} 失败——${error instanceof Error ? error.message : error}`);
  }
}

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const packageDir = resolve(
  argv.find((arg) => !arg.startsWith('--')) ?? fileURLToPath(new URL('..', import.meta.url)),
);
const manifest = readJson(join(packageDir, 'package.json'));

const formatBytes = (bytes) =>
  `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;
const formatDelta = (delta) => `${delta > 0 ? '+' : ''}${formatBytes(delta)}`;

/** esbuild minify 单个导出入口(连其相对导入一起 bundle),返回 minified 与 gzip 字节数。 */
async function measure(file) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const [output] = outputFiles ?? [];
  if (output === undefined) {
    throw new Error(`esbuild 没有为 ${file} 产出结果`);
  }
  return { minified: output.contents.length, gzip: gzipSync(output.contents).length };
}

const entries = Object.entries(manifest.exports ?? {}).map(([subpath, target]) => {
  const file = typeof target === 'string' ? target : target?.default;
  if (typeof file !== 'string') {
    hardError(`${manifest.name}:exports["${subpath}"] 没有 default 产物入口,无法测量`);
  }
  return { subpath, file: join(packageDir, file) };
});

const budgetPath = join(packageDir, BUDGET_FILE);
const baseline = existsSync(budgetPath) ? readJson(budgetPath) : undefined;
if (baseline !== undefined && baseline.metric !== METRIC) {
  hardError(
    `${manifest.name}:基线 ${BUDGET_FILE} 的口径是 ${baseline.metric},本脚本口径是 ${METRIC};跑 ${UPDATE_HINT} 重建基线`,
  );
}

const rows = [];
for (const entry of entries) {
  let measured;
  try {
    measured = await measure(entry.file);
  } catch (error) {
    hardError(
      `${manifest.name}:测量 ${entry.subpath} 失败——${error instanceof Error ? error.message : error};先确认 pnpm build 已产出 dist`,
    );
  }
  const budget = baseline?.entries?.[entry.subpath];
  rows.push({
    ...entry,
    measured,
    budget,
    delta: budget === undefined ? undefined : measured.minified - budget,
  });
}

// 基线重写:以当前实测值为新预算,供代码演进时有意抬高(黄灯提示作者做这个动作)。
if (update) {
  const next = {
    metric: METRIC,
    entries: Object.fromEntries(rows.map((row) => [row.subpath, row.measured.minified])),
  };
  writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${manifest.name} 字节预算基线已更新:${BUDGET_FILE}`);
  for (const row of rows) {
    if (row.budget !== row.measured.minified) {
      console.log(
        `  ${row.subpath}  ${row.budget === undefined ? '—' : formatBytes(row.budget)} → ${formatBytes(row.measured.minified)}`,
      );
    }
  }
  process.exit(0);
}

const problems = [];
if (baseline === undefined) {
  problems.push(`基线文件 ${BUDGET_FILE} 不存在;跑 ${UPDATE_HINT} 建立基线`);
} else {
  for (const row of rows) {
    if (row.delta === undefined) {
      problems.push(`${row.subpath} 尚无预算基线(当前 ${formatBytes(row.measured.minified)})`);
    } else if (row.delta > 0) {
      problems.push(
        `${row.subpath} 超预算 ${formatDelta(row.delta)}(基线 ${formatBytes(row.budget)} → 当前 ${formatBytes(row.measured.minified)})`,
      );
    }
  }
  const exported = new Set(rows.map((row) => row.subpath));
  for (const subpath of Object.keys(baseline.entries ?? {})) {
    if (!exported.has(subpath)) {
      problems.push(`基线中的 ${subpath} 已不再导出;清理它或跑 ${UPDATE_HINT}`);
    }
  }
}

/** 等宽对齐的文本表:入口与数字都是 ASCII,中文只留在状态列,列宽按字符数计算即可。 */
function renderTable(lines) {
  const widths = lines[0].map((_, column) =>
    Math.max(...lines.map((line) => String(line[column]).length)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, column) => String(cell).padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const statusOf = (row) =>
  row.budget === undefined ? '🟡 未建基线' : row.delta > 0 ? '🟡 超预算' : 'ok';

/** 一行的 6 列;文本表与 job summary 的 markdown 表共用,避免两处各自重算。 */
function rowCells(row) {
  return [
    row.subpath,
    row.budget === undefined ? '—' : formatBytes(row.budget),
    formatBytes(row.measured.minified),
    row.delta === undefined ? '—' : formatDelta(row.delta),
    formatBytes(row.measured.gzip),
    statusOf(row),
  ];
}

/** CI 的记录面:每个问题一条黄灯注释(PR 上可见),整张表追加进 job summary。 */
function publishToCi() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const problem of problems) {
      console.log(`::warning title=${manifest.name} 字节预算::${problem}`);
    }
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined) {
    return;
  }
  const lines = [
    `## ${manifest.name} 字节预算`,
    '',
    `口径 \`${METRIC}\`:esbuild minify 后每个子路径导出入口的 bundle 字节。ADR-0001:仅内部回归参考,不卡合并。`,
    '',
    '| entry | budget | current | delta | gzip | status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| ${rowCells(row)
          .map((cell, column) => (column === 0 ? `\`${cell}\`` : cell))
          .join(' | ')} |`,
    ),
  ];
  if (problems.length > 0) {
    lines.push('', `🟡 ${problems.length} 项需处理:`, ...problems.map((problem) => `- ${problem}`));
    lines.push('', `调整基线:\`${UPDATE_HINT}\``);
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

console.log(`${manifest.name} 字节预算(${METRIC})`);
console.log(
  renderTable([
    ['entry', 'budget', 'current', 'delta', 'gzip', 'status'],
    ...rows.map(rowCells),
  ]),
);
if (problems.length > 0) {
  console.log(`🟡 ${problems.length} 项需处理:`);
  for (const problem of problems) {
    console.log(`  - ${problem}`);
  }
  console.log(`调整基线:${UPDATE_HINT}(ADR-0001:黄灯仅作内部回归参考,不卡合并)`);
  process.exitCode = EXIT_YELLOW;
} else {
  console.log(`ok  ${rows.length} 个入口全部在预算内`);
}
publishToCi();
