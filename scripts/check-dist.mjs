// 构建产物校验(需先 `pnpm build`):逐个导入 package.json exports 表里的子路径,
// 证明「产物以子路径导出各子系统入口」在 dist 上真实成立。
// 同时按 CJS `require()` 走一遍 —— exports 的 `default` 条件保证 require(esm) 可用(Node ≥22.12)。
// 落位(ADR-0015 M5 修订):共享实现居根 scripts/,各包以 `node ../../scripts/check-dist.mjs`
// 薄脚本指回(或显式传包目录);退出码契约不变。
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readManifest } from './lib.mjs';

const packageDir = resolve(process.argv[2] ?? process.cwd());
const { name, exports: exportMap } = readManifest(packageDir);
// 解析锚在包目录内:包自身名字经 exports 自引用解析,不依赖脚本所在位置。
const requireCjs = createRequire(join(packageDir, 'package.json'));

const entries = Object.entries(exportMap ?? {});
if (entries.length === 0) {
  console.error(`${name}: exports 表为空,无可校验的子路径`);
  process.exit(1);
}

const failures = [];

for (const [subpath, entry] of entries) {
  const specifier = subpath === '.' ? name : `${name}/${subpath.slice('./'.length)}`;

  for (const target of Object.values(entry)) {
    if (!existsSync(join(packageDir, target))) {
      failures.push(`${specifier}: 缺产物 ${target}`);
    }
  }

  try {
    const resolved = requireCjs.resolve(specifier);
    await import(pathToFileURL(resolved).href);
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
