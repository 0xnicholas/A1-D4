import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 产物面硬闸门的 CLI 契约(ADR-0014「纯 ESM + 子路径导出表」,ADR-0015 M5「脚本落位」):
 * 按 `exports` 表逐子路径验真——每个条件声明的产物必须在盘上,子路径要能被 `require.resolve()`
 * 解析、`import()` 加载、`require()` 走通(ESM 与 require(esm) 两条路)。
 *
 * 夹具由测试自身构造(临时包目录 + 自带可加载的 ESM 产物 + 显式 `type: "module"`),不依赖仓库
 * 自身构建;断言只碰外部行为(退出码 / stdout 的 `ok` 进度行 / stderr 的缺口行),脚本内部重构
 * 不造成假红。本套件按现状钉住:缺口报在 stderr(与 check-export-surface 报 stdout 相反);
 * 现有脚本没有「配置/产物硬错误 → 2」通路——缺产物与空 exports 表一律 1
 * (现状钉住而非应然:#113 裁决后若改口径,需同步改本套件)。
 */
afterEach(cleanupFixtures);

const ROOT_ENTRY = { types: './dist/index.d.ts', default: './dist/index.js' };
const TOOLS_ENTRY = { types: './dist/tools/index.d.ts', default: './dist/tools/index.js' };

const ROOT_ONLY = { '.': ROOT_ENTRY };

const TWO_SUBPATHS = { '.': ROOT_ENTRY, './tools': TOOLS_ENTRY };

/** 坏子路径在前、好子路径在后:fail-fast 实现会在坏处停住,后一个好子路径就不会被验到。 */
const BAD_THEN_GOOD = { './tools': TOOLS_ENTRY, '.': ROOT_ENTRY };

const ROOT_JS = "export const root = 'root';\n";
const ROOT_DTS = 'export declare const root: string;\n';
const TOOLS_JS = "export const tools = 'tools';\n";
const TOOLS_DTS = 'export declare const tools: string;\n';

const ROOT_ARTIFACTS = { 'dist/index.js': ROOT_JS, 'dist/index.d.ts': ROOT_DTS };
const TOOLS_ARTIFACTS = { 'dist/tools/index.js': TOOLS_JS, 'dist/tools/index.d.ts': TOOLS_DTS };

/** 夹具包:`type: "module"` 显式声明、exports 表与产物路径对应,不依赖 Node 的语法探测。 */
function packageFixture(
  exportsMap: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = {},
): string {
  return fixturePackage({
    'package.json': packageManifest({ type: 'module', exports: exportsMap }),
    ...files,
  });
}

/** stdout 里的 `ok` 进度行,取其中的子路径标识(其余行是缺口与汇总输出)。 */
function okSubpaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('ok  '))
    .map((line) => line.slice('ok  '.length));
}

describe('check-dist:exports 表逐子路径验真', () => {
  it('多子路径产物齐备时通过,逐子路径报 ok', () => {
    const dir = packageFixture(TWO_SUBPATHS, { ...ROOT_ARTIFACTS, ...TOOLS_ARTIFACTS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(0);
    expect(okSubpaths(result.stdout)).toEqual(['fixture', 'fixture/tools']);
    expect(result.stderr).toBe('');
  });

  it('声明产物缺失时变红:报出子路径与缺失目标', () => {
    const dir = packageFixture(ROOT_ONLY, { 'dist/index.d.ts': ROOT_DTS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture: 缺产物 ./dist/index.js');
  });

  it('产物存在但加载抛错时变红:报「导入失败」与原因', () => {
    const dir = packageFixture(ROOT_ONLY, {
      'dist/index.js': "throw new Error('夹具产物加载失败');\n",
      'dist/index.d.ts': ROOT_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture: 导入失败');
    expect(result.stderr).toContain('夹具产物加载失败');
  });

  it('exports 表为空时变红:明示无可校验的子路径', () => {
    const dir = packageFixture({});

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exports 表为空');
    expect(result.stderr).toContain('无可校验的子路径');
    expect(result.stdout).toBe('');
  });

  it('多条件里仅 types 缺产物也变红:逐条件校验,不只查 default', () => {
    // default 侧产物齐备且可加载——只查 default 的实现会把这一夹具读成干净。
    const dir = packageFixture(ROOT_ONLY, { 'dist/index.js': ROOT_JS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture: 缺产物 ./dist/index.d.ts');
  });

  it('一好一坏时变红:坏的报缺口、好的照常报 ok(累积报错,不因一坏中断)', () => {
    const dir = packageFixture(BAD_THEN_GOOD, {
      ...ROOT_ARTIFACTS,
      'dist/tools/index.d.ts': TOOLS_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(okSubpaths(result.stdout)).toEqual(['fixture']);
    expect(result.stderr).toContain('fixture/tools: 缺产物 ./dist/tools/index.js');
  });
});
