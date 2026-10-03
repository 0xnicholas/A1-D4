/**
 * stdio fixture server: spawned by `test/stdio.test.ts` through the package's stdio transport
 * (`command + args`), so the test exercises the real subprocess path the SDK owns. Writes its
 * pid to the file named by argv[2] on start — the test waits for it, then polls the pid to
 * observe the SDK's shutdown order (stdin close → SIGTERM → SIGKILL) after `client.close()`.
 *
 * Registers two tools: `echo` (a text result round-trip) and `marker` (reports the
 * ORIBOS_STDIO_MARKER env value — proof that a passed `env` is the child's whole environment).
 */
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const pidfile = process.argv[2];
if (pidfile !== undefined) writeFileSync(pidfile, `${process.pid}\n`);

serveStdio(() => {
  const server = new McpServer({ name: 'fixture-stdio', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo back the input', inputSchema: z.object({ value: z.string() }) },
    async ({ value }: { value: string }) => ({ content: [{ type: 'text' as const, text: value }] }),
  );
  server.registerTool('marker', { description: 'Reports the marker env var' }, async () => ({
    content: [{ type: 'text' as const, text: process.env.ORIBOS_STDIO_MARKER ?? '<unset>' }],
  }));
  return server;
});
