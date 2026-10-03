import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `@oribos/core` 的导出表契约:根入口 + 每个子系统一个子路径。
 * 子系统清单与 `docs/architecture/README.md` 手工同步;子路径 ↔ 目录的映射形状来自 ADR-0002 / ADR-0014。
 */
const SUBSYSTEMS = ['model', 'agent', 'tools', 'observability', 'workflows', 'memory', 'signals', 'durable-agent', 'schedules'] as const;

interface ExportEntry {
  readonly types: string;
  readonly default: string;
}

function readExportMap(): Record<string, ExportEntry> {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, ExportEntry> };
  return packageJson.exports ?? {};
}

const exportMap = readExportMap();

describe('@oribos/core 导出表', () => {
  it.each(SUBSYSTEMS)('子路径 ./%s 指向该子系统的 dist 入口', (subsystem) => {
    expect(exportMap[`./${subsystem}`]).toEqual({
      types: `./dist/${subsystem}/index.d.ts`,
      default: `./dist/${subsystem}/index.js`,
    });
  });

  it('根入口指向组合根的 dist 产物', () => {
    expect(exportMap['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
  });

  it('导出表不声明子系统之外的入口', () => {
    const declared = Object.keys(exportMap).sort();
    const expected = ['.', ...SUBSYSTEMS.map((subsystem) => `./${subsystem}`)].sort();
    expect(declared).toEqual(expected);
  });

  it.each(SUBSYSTEMS)('子路径 ./%s 有对应的源码入口', (subsystem) => {
    expect(existsSync(new URL(`../src/${subsystem}/index.ts`, import.meta.url))).toBe(true);
  });

  it('根入口有对应的源码入口', () => {
    expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
  });
});
