// 共享助手(ADR-0015 M5 修订:脚本实现移根 scripts/,check-runtime-deps 与
// check-deps-budget 共用清单解析与产物导入扫描)。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isBuiltin } from 'node:module';
import { relative } from 'node:path';
import * as esbuild from 'esbuild';

/** 运行时依赖面:npm 会把这三个字段的包装进用户依赖树(peer 自 npm 7 起自动安装)。 */
export const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** 零运行时依赖的包(ADR-0001 硬线):合法集恒为空集,三字段非空即红(ADR-0015 M5)。 */
export const ZERO_RUNTIME_PACKAGES = ['@oribos/core'];

/** 硬闸门退出码契约的硬错误档(ADR-0015):0 = 干净 / 1 = 有缺口 / 2 = 配置·产物硬错误。 */
export const EXIT_HARD_ERROR = 2;

/** 硬错误(不是「有缺口」):配置或产物问题,检查没能跑成——报 stderr 并以退出码 2 结束。 */
export function hardError(message) {
  console.error(message);
  process.exit(EXIT_HARD_ERROR);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readManifest(packageDir) {
  return readJson(join(packageDir, 'package.json'));
}

/** manifest 不可读 / JSON 非法 = 配置硬错误:干净报错(路径 + 原因),不把栈抛给调用方。 */
export function readManifestOrHardError(packageDir) {
  try {
    return readManifest(packageDir);
  } catch (error) {
    hardError(
      `读取 ${join(packageDir, 'package.json')} 失败——${error instanceof Error ? error.message : error}`,
    );
  }
}

/** manifest 运行时字段里声明的包名(去重;`@oribos/core` peer 由调用方决定豁免)。 */
export function declaredRuntimeDependencyNames(manifest) {
  const names = new Set();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      names.add(name);
    }
  }
  return names;
}

/**
 * 合法导入判定(ADR-0015 M5「仅声明依赖」):合法集 = Node 内置 ∪ 相对/绝对路径 ∪
 * manifest 运行时字段声明的包名(名字精确匹配、含子路径 `pkg/sub`);devDependencies
 * 不在合法集。零运行时依赖的包(@oribos/core)合法集恒为空集——原「零运行时依赖」语义。
 */
export function allowedSpecifierPredicate(declaredNames) {
  return (specifier) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) return true;
    if (isBuiltin(specifier)) return true;
    for (const name of declaredNames) {
      if (specifier === name || specifier.startsWith(`${name}/`)) return true;
    }
    return false;
  };
}

/** 递归列出产物里的 ESM 模块;sourcemap 与类型声明不参与运行,不扫。 */
export function listDistModules(distDir) {
  return readdirSync(distDir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(distDir, entry.name);
    if (entry.isDirectory()) return listDistModules(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/**
 * 语法级提取导入说明符:把导入全部外部化后,esbuild 的 metafile 就是解析结果——
 * 注释与字符串里的 `from "pkg"` 不会误报,正则匹配做不到这一点。
 */
export async function listImports(file, workingDir) {
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

/**
 * 扫描整个 dist,收集每个外部包说明符(非内置、非相对/绝对路径)及其出现位置,
 * 并顺带清点产物模块总数(消息口径沿原脚本:dist 内全部 .js 文件)。
 * check-runtime-deps 用于判白名单,check-deps-budget 用于「声明但产物零引用」黄灯。
 */
export async function scanDist(packageDir) {
  const distDir = join(packageDir, 'dist');
  const modules = listDistModules(distDir);
  const externalImports = new Map();
  for (const file of modules) {
    for (const specifier of await listImports(file, packageDir)) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) continue;
      const files = externalImports.get(specifier) ?? [];
      files.push(relative(packageDir, file));
      externalImports.set(specifier, files);
    }
  }
  return { moduleCount: modules.length, externalImports };
}
