// 零运行时依赖硬检查(ADR-0001 硬线,M1-02 #23):@balsa/core 的运行时依赖必须为零。
// 两条线都查:清单字段(用户装机会被拉入的依赖)+ 产物导入(源码误引 devDependency 的绕过路径)。
// 用 `node scripts/check-runtime-deps.mjs [packageDir]` 运行,任一违背即退出 1。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/** 运行时依赖面:npm 会把这三个字段的包装进用户依赖树(peer 自 npm 7 起自动安装)。 */
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const packageDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

const violations = [];

for (const field of RUNTIME_DEPENDENCY_FIELDS) {
  for (const name of Object.keys(manifest[field] ?? {})) {
    violations.push(`package.json 的 ${field} 声明了运行时依赖 ${name}`);
  }
}

const distDir = join(packageDir, 'dist');
if (!existsSync(distDir)) {
  console.error(
    `${manifest.name}:产物目录 dist/ 不存在,无法做导入扫描——先运行 pnpm build 再跑本检查`,
  );
  process.exit(1);
}

/** 递归列出产物里的 ESM 模块;sourcemap 与类型声明不参与运行,不扫。 */
function listModules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listModules(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/**
 * 语法级提取导入说明符:把导入全部外部化后,esbuild 的 metafile 就是解析结果——
 * 注释与字符串里的 `from "pkg"` 不会误报,正则匹配做不到这一点。
 */
async function listImports(file, workingDir) {
  const { metafile } = await esbuild.build({
    absWorkingDir: workingDir,
    entryPoints: [file],
    bundle: true,
    external: ['*'],
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  // 按 entry 相对 absWorkingDir 的路径显式取 metafile 输入。当前全部导入都被外部化,
  // 所以只有一个 input——那是实现细节,不是契约;取不到就报错,不猜。
  const key = relative(workingDir, file);
  const input = metafile?.inputs?.[key];
  if (input === undefined) {
    throw new Error(`esbuild metafile 缺少 ${key} 的解析结果`);
  }
  return input.imports.map((declared) => declared.path);
}

/** 相对路径与 Node 内置是合法导入;其余说明符都要安装包才能解析。 */
function isAllowedSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier);
}

const modules = listModules(distDir);
for (const file of modules) {
  for (const specifier of await listImports(file, packageDir)) {
    if (!isAllowedSpecifier(specifier)) {
      violations.push(`${relative(packageDir, file)} 导入了外部包 ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`${manifest.name}:运行时依赖必须为零(ADR-0001),发现 ${violations.length} 处违背:`);
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `${manifest.name}:零运行时依赖 ok(清单 0 个依赖;产物 ${modules.length} 个模块,0 处外部导入)`,
  );
}
