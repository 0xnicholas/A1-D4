import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CI 红线脚本的测试夹层:脚本实现居仓库根 scripts/(ADR-0015 M5 修订),
 * 本夹层组装临时包目录,以子进程真实调用 CLI,断言退出码与输出——
 * 脚本的接缝是命令行本身,不伸手进内部函数。测试文件落在 core/test 骑根 vitest 收集面,
 * 测的是共享脚本本身;后续多包重复时再议抽高(见地图雾点)。
 */
const SCRIPTS_DIR = fileURLToPath(new URL('../../../../scripts/', import.meta.url));

export type RedlineScript =
  | 'check-dist'
  | 'check-runtime-deps'
  | 'check-byte-budget'
  | 'check-deps-budget'
  | 'check-export-surface';

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const fixtures: string[] = [];

/** 最小包清单(name/version 固定),fields 覆盖或追加字段。 */
export function packageManifest(fields: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ name: 'fixture', version: '0.0.0', ...fields }, null, 2)}\n`;
}

/** 建一个临时包目录,按相对路径写入文件,返回目录绝对路径(测试结束由 cleanupFixtures 清理)。 */
export function fixturePackage(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'balsats-redline-'));
  fixtures.push(dir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(dir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return dir;
}


export function runScript(
  script: RedlineScript,
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): CliResult {
  const result = spawnSync(process.execPath, [join(SCRIPTS_DIR, `${script}.mjs`), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function cleanupFixtures(): void {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
