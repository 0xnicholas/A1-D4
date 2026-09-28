import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  fixturePackage,
  packageManifest as manifest,
  runScript,
} from './helpers/cli.js';

/**
 * 零运行时依赖硬检查(M1-02 #23,ADR-0001)的 CLI 契约:
 * 清单字段(`dependencies` / `optionalDependencies` / `peerDependencies`)非空即红。
 * 后续用例覆盖产物裸导入扫描——检查的真正对象是"用户装机时要付的依赖"。
 */
afterEach(cleanupFixtures);

describe('check-runtime-deps:零运行时依赖硬检查', () => {
  it('清单无运行时依赖声明时通过', () => {
    const dir = fixturePackage({
      'package.json': manifest({ devDependencies: { esbuild: '^0.28.2' } }),
      'dist/index.js': 'export const value = 1;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('零运行时依赖');
  });

  it('dependencies 非空即失败并列出声明的依赖', () => {
    const dir = fixturePackage({
      'package.json': manifest({ dependencies: { zod: '^4.0.0' } }),
      'dist/index.js': 'export const value = 1;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dependencies');
    expect(result.stderr).toContain('zod');
  });

  it.each(['optionalDependencies', 'peerDependencies'])(
    '%s 非空同样视为运行时依赖(npm 会装进用户依赖树)',
    (field) => {
      const dir = fixturePackage({
        'package.json': manifest({ [field]: { zod: '^4.0.0' } }),
        'dist/index.js': 'export const value = 1;\n',
      });

      const result = runScript('check-runtime-deps', [dir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(field);
      expect(result.stderr).toContain('zod');
    },
  );

  it('产物只引用 node 内置与相对模块时通过', () => {
    const dir = fixturePackage({
      'package.json': manifest(),
      'dist/index.js': [
        'import fs from "fs";',
        'import { readFile } from "node:fs/promises";',
        'import "./local.js";',
        'export const value = fs.constants.F_OK ?? readFile;',
        '',
      ].join('\n'),
      'dist/local.js': 'export const local = 1;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(0);
  });

  it('产物出现裸包导入即失败(挡住 src 误引 devDependency)', () => {
    const dir = fixturePackage({
      'package.json': manifest(),
      'dist/index.js': 'import { z } from "zod";\nexport const value = z.string();\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('zod');
    expect(result.stderr).toContain('dist/index.js');
  });

  it('注释与字符串里的 from "pkg" 不算导入(语法级扫描,非文本匹配)', () => {
    const dir = fixturePackage({
      'package.json': manifest(),
      'dist/index.js': [
        '// from "comment-pkg"',
        '/* 见 import "block-pkg" */',
        'const text = \'from "string-pkg"\';',
        'export const value = text;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(0);
  });

  it('产物目录缺失时失败并提示先构建', () => {
    const dir = fixturePackage({ 'package.json': manifest() });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist');
  });
});
