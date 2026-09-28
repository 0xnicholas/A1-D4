// 构建产物校验(需先 `pnpm build`):逐个导入 package.json exports 表里的子路径,
// 证明「产物以子路径导出各子系统入口」在 dist 上真实成立。
// 同时按 CJS `require()` 走一遍 —— exports 的 `default` 条件保证 require(esm) 可用(Node ≥22.12)。
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const packageRoot = new URL('..', import.meta.url);
const { name, exports: exportMap } = JSON.parse(
  readFileSync(new URL('package.json', packageRoot), 'utf8'),
);
const requireCjs = createRequire(import.meta.url);

const entries = Object.entries(exportMap ?? {});
if (entries.length === 0) {
  console.error(`${name}: exports 表为空,无可校验的子路径`);
  process.exit(1);
}

const failures = [];

for (const [subpath, entry] of entries) {
  const specifier = subpath === '.' ? name : `${name}/${subpath.slice('./'.length)}`;

  for (const target of Object.values(entry)) {
    if (!existsSync(new URL(target, packageRoot))) {
      failures.push(`${specifier}: 缺产物 ${target}`);
    }
  }

  try {
    await import(specifier);
    requireCjs(specifier);
    console.log(`ok  ${specifier}`);
  } catch (error) {
    failures.push(`${specifier}: 导入失败 — ${error instanceof Error ? error.message : error}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
