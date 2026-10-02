import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  fixturePackage,
  packageManifest as manifest,
  runScript,
} from './helpers/cli.js';

/**
 * 依赖红线硬检查的 CLI 契约(ADR-0015,M5 修订推广):
 * 零运行时依赖包(@balsats/core,ADR-0001)——三字段非空即红、合法集恒为空;
 * 其余包「仅声明依赖」——产物导入只允许 Node 内置 ∪ 相对路径 ∪ manifest 运行字段
 * 声明的包名(含子路径);devDependencies 不在合法集。
 */
afterEach(cleanupFixtures);

describe('check-runtime-deps:零运行时依赖包(@balsats/core)', () => {
  const coreManifest = (fields: Readonly<Record<string, unknown>> = {}) =>
    manifest({ name: '@balsats/core', ...fields });

  it('清单无运行时依赖声明时通过', () => {
    const dir = fixturePackage({
      'package.json': coreManifest({ devDependencies: { esbuild: '^0.28.2' } }),
      'dist/index.js': 'export const value = 1;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('零运行时依赖');
  });

  it('dependencies 非空即失败并列出声明的依赖', () => {
    const dir = fixturePackage({
      'package.json': coreManifest({ dependencies: { zod: '^4.0.0' } }),
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
        'package.json': coreManifest({ [field]: { zod: '^4.0.0' } }),
        'dist/index.js': 'export const value = 1;\n',
      });

      const result = runScript('check-runtime-deps', [dir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(field);
      expect(result.stderr).toContain('zod');
    },
  );

  it('合法集为空:产物任何裸包导入即失败', () => {
    const dir = fixturePackage({
      'package.json': coreManifest(),
      'dist/index.js': 'import { z } from "zod";\nexport const value = z.string();\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未声明依赖');
    expect(result.stderr).toContain('zod');
  });

  it('产物目录缺失时失败并提示先构建', () => {
    const dir = fixturePackage({ 'package.json': coreManifest() });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist');
  });
});

describe('check-runtime-deps:仅声明依赖(能力包,ADR-0015 M5)', () => {
  it('声明依赖被产物导入(含子路径)时通过', () => {
    const dir = fixturePackage({
      'package.json': manifest({
        dependencies: { zod: '^4.0.0' },
        peerDependencies: { '@balsats/core': 'workspace:^' },
      }),
      'dist/index.js': [
        'import { z } from "zod";',
        'import { z as z2 } from "zod/v4";',
        'import { randomUUID } from "node:crypto";',
        'import "./local.js";',
        'export const value = [z.string, z2.string, randomUUID];',
        '',
      ].join('\n'),
      'dist/local.js': 'export const local = 1;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('仅声明依赖');
  });

  it('产物导入未声明的包即失败', () => {
    const dir = fixturePackage({
      'package.json': manifest({ dependencies: { zod: '^4.0.0' } }),
      'dist/index.js': 'import { Hono } from "hono";\nexport const value = Hono;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未声明依赖');
    expect(result.stderr).toContain('hono');
    expect(result.stderr).toContain('dist/index.js');
  });

  it('devDependencies 不在合法集(挡住 src 误引 devDependency)', () => {
    const dir = fixturePackage({
      'package.json': manifest({ devDependencies: { zod: '^4.0.0' } }),
      'dist/index.js': 'import { z } from "zod";\nexport const value = z.string();\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('zod');
  });

  it('声明名精确匹配:近形包名不进白名单', () => {
    const dir = fixturePackage({
      'package.json': manifest({ dependencies: { zod: '^4.0.0' } }),
      'dist/index.js': 'import { value } from "zod-x";\nexport const v = value;\n',
    });

    const result = runScript('check-runtime-deps', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('zod-x');
  });

  it('注释与字符串里的 from "pkg" 不算导入(语法级扫描,非文本匹配)', () => {
    const dir = fixturePackage({
      'package.json': manifest({ dependencies: { zod: '^4.0.0' } }),
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
});
