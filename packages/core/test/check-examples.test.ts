import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, runScript } from './helpers/cli.js';

/**
 * 离线 example 冒烟运行器的 CLI 契约(M-5,ADR-0015 M5 修订):
 * 四个离线入口逐条跑,全绿即 0;任何一案失败(含超时)= 1;运行器自身的配置硬错误
 * (案表不可读 / JSON 非法 / 空案表 / 条目形状非法)= 2。
 *
 * 本套件只走「注入案表」这**唯一**缝(`--cases <文件>`),断言外部行为(退出码 / stdout / stderr),
 * 不伸手进内部函数;案命令用可预测的短命令,不依赖仓库构建与网络。逐案进度与汇总走 stdout
 * (与子进程输出同流,顺序可读),硬错误走 stderr。
 */
afterEach(cleanupFixtures);

/** 注入一份案表文件,返回其绝对路径;raw 覆盖时按原文写入(测 JSON 非法)。 */
function injectedTable(cases: unknown, raw?: string): string {
  const dir = fixturePackage({ 'cases.json': raw ?? `${JSON.stringify(cases, null, 2)}\n` });
  return join(dir, 'cases.json');
}

/** 一条可预测的 node 命令:退出码由脚本决定,不依赖仓库构建。 */
function nodeCase(name: string, script: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, cmd: process.execPath, args: ['-e', script], ...extra };
}

describe('check-examples:离线 example 冒烟运行器', () => {
  it('全绿案表 → 0,逐案留 ✓ 痕并带耗时', () => {
    const table = injectedTable([nodeCase('ok-case', 'process.exit(0)'), nodeCase('second-case', 'process.exit(0)')]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/✓ ok-case \(\d+\.\d+s\)/);
    expect(result.stdout).toMatch(/✓ second-case \(\d+\.\d+s\)/);
  });

  it('一例失败 → 1,点名该案并给出本地复现命令', () => {
    const table = injectedTable([nodeCase('bad-case', 'process.exit(1)'), nodeCase('ok-case', 'process.exit(0)')]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('✗ bad-case');
    const reproLine = result.stdout.split('\n').find((line) => line.includes('复现'));
    expect(reproLine).toBeDefined();
    expect(reproLine).toContain(process.execPath);
    expect(reproLine).toContain('process.exit(1)');
  });

  it('案表文件不存在 → 2(运行器配置硬错误,不是"有案子失败")', () => {
    const missing = join(fixturePackage({}), 'cases.json');

    const result = runScript('check-examples', ['--cases', missing]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cases.json');
  });

  it('案表 JSON 非法 → 2', () => {
    const table = injectedTable(null, '{ not json');

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cases.json');
  });

  it('空案表 → 2:没有案子可跑不是"全绿"', () => {
    const table = injectedTable([]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('空');
  });

  it('案表条目形状非法 → 2:缺命令的条目不算一案失败', () => {
    const table = injectedTable([{ name: 'no-command' }]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no-command');
  });

  it('一成一败 → 1,成功案照常报 ✓(不 fail-fast)', () => {
    const table = injectedTable([nodeCase('bad-case', 'process.exit(1)'), nodeCase('ok-case', 'process.exit(0)')]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('✗ bad-case');
    expect(result.stdout).toContain('✓ ok-case');
  });

  it('逐案 env 传给子进程', () => {
    const table = injectedTable([
      nodeCase('env-case', 'process.exit(process.env.SMOKE_ECHO === "yes" ? 0 : 1)', {
        env: { SMOKE_ECHO: 'yes' },
      }),
    ]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓ env-case');
  });

  it('单案超时按该案失败计 → 1,并报超时', () => {
    const table = injectedTable([nodeCase('slow-case', 'setTimeout(() => {}, 60_000)', { timeoutMs: 300 })]);

    const result = runScript('check-examples', ['--cases', table]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('✗ slow-case');
    expect(result.stdout).toContain('超时');
  });
});
