/**
 * The stdio face: the package spawns the real subprocess (`StdioClientTransport`, the SDK owns
 * it end to end), the era probe runs on a short-lived sibling, `env` replaces the child's whole
 * environment, and `close()` tears the subprocess down in the SDK's order. The pidfile written
 * by the fixture is the observation point for the child's lifetime.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpClient } from '@balsats/mcp-client';
import { sleep, toolContext, toolOf } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

async function waitFor(file: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    await sleep(25);
  }
  throw new Error(`fixture never wrote ${file}`);
}

async function waitExited(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(25);
  }
  throw new Error(`child ${pid} never exited`);
}

describe('stdio transport', () => {
  it('spawns, bridges, and tears down the subprocess; env is the whole environment', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balsa-mcp-client-stdio-'));
    const pidfile = join(dir, 'pid');
    try {
      const client = await createMcpClient({
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['--experimental-strip-types', fixture, pidfile],
          env: { BALSA_STDIO_MARKER: 'passed-through' },
        },
      });
      const pid = Number(await waitFor(pidfile));

      expect(Object.keys(client.tools).sort()).toEqual(['echo', 'marker']);
      await expect(toolOf(client, 'echo').execute({ value: 'roundtrip' }, toolContext())).resolves.toBe('roundtrip');
      await expect(toolOf(client, 'marker').execute(undefined, toolContext())).resolves.toBe('passed-through');

      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
      await waitExited(pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
