/**
 * Balsats MCP paired example — one script, both capability packages.
 *
 * The server side (`@balsats/mcp-server`) serves a small tool container over MCP; the client side
 * (`@balsats/mcp-client`) connects and bridges the remote tools back into a `Record<string, Tool>`
 * — the same shape an agent's tool container takes. The whole round-trip self-asserts with
 * `node:assert` (exit 0 on success; any failure exits 1).
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @balsats/example-mcp-tools start
 *
 * Both transports are exercised:
 *
 *   MCP_TRANSPORT=http   (default) — the server answers HTTP on 127.0.0.1, MCP_PORT optional
 *   MCP_TRANSPORT=stdio            — the script re-execs itself as a stdio server child; the
 *                                    client spawns it (command + args) and owns its lifetime
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createTool } from '@balsats/core/tools';
import { createMcpClient, prefixTools } from '@balsats/mcp-client';
import type { McpClient } from '@balsats/mcp-client';
import { createMcpServer } from '@balsats/mcp-server';
import type { Tool } from '@balsats/core/tools';
import { z } from 'zod';

// --- the shared tool container -------------------------------------------------------------
//
// Three tools is enough to show every projection: a text result, a structured result (output
// schema), and a failure (the negative path — the client must turn it into a throw, and this
// script must observe that or exit 1).

const echo = createTool({
  description: 'Echo back the input.',
  inputSchema: z.object({ value: z.string() }),
  execute: ({ value }) => value,
});

const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ city: z.string(), celsius: z.number() }),
  // A deterministic stand-in so the example runs without any external service.
  execute: ({ city }) => ({ city, celsius: 18 }),
});

const failing = createTool({
  description: 'Always fails — the negative path.',
  execute: () => {
    throw new Error('this tool always fails');
  },
});

const container = { echo, weather, failing };

const server = createMcpServer({ name: 'balsats-example-tools', version: '1.0.0', tools: container });

// --- role split: stdio child mode ----------------------------------------------------------

if (process.env.BALSATS_MCP_EXAMPLE_ROLE === 'stdio-server') {
  server.serveStdio(); // stdin/stdout is the JSON-RPC channel; logs below go to stderr
  console.error('[mcp-tools] stdio server child up');
} else {
  await main();
}

// --- the client-side script ----------------------------------------------------------------

async function main(): Promise<void> {
  const transport =
    process.env.MCP_TRANSPORT === 'stdio'
      ? {
          // Re-exec this very script as the stdio server child; the client package (via the SDK)
          // owns the subprocess from here on.
          type: 'stdio' as const,
          command: process.execPath,
          args: ['--experimental-strip-types', fileURLToPath(import.meta.url)],
          env: { BALSATS_MCP_EXAMPLE_ROLE: 'stdio-server' },
        }
      : { type: 'http' as const, url: await serveHttp() };

  console.error(`[mcp-tools] connecting over ${transport.type} …`);
  const client = await createMcpClient({ transport });
  const tool = (name: string): Tool => mustTool(client, name);

  // The snapshot: one bridged Tool per remote entry, keyed by the remote name.
  assert.deepEqual(Object.keys(client.tools).sort(), ['echo', 'failing', 'weather'], 'snapshot keys');

  // Text projection: no output schema → the text blocks, joined.
  const echoed = await tool('echo').execute({ value: 'roundtrip' }, context());
  assert.equal(echoed, 'roundtrip', 'echo round-trip');

  // Structured projection: output schema → structuredContent comes back verbatim.
  const forecast = await tool('weather').execute({ city: 'Oslo' }, context());
  assert.deepEqual(forecast, { city: 'Oslo', celsius: 18 }, 'structured round-trip');

  // Negative path: a remote isError result must throw (the framework would feed it back to the
  // model as `Tool 'failing' failed: …`; here the throw itself is the assertion).
  await assert.rejects(
    async () => {
      await tool('failing').execute(undefined, context());
    },
    /this tool always fails/,
  );

  // Renaming with a fixed prefix: new container, same tools — the prefix never reaches the wire.
  const prefixed = prefixTools(client.tools, 'remote');
  assert.deepEqual(Object.keys(prefixed).sort(), ['remote_echo', 'remote_failing', 'remote_weather']);
  const remoteWeather = prefixed['remote_weather'];
  assert.ok(remoteWeather !== undefined, 'prefixed key present');
  const viaPrefix = await remoteWeather.execute({ city: 'Bergen' }, context());
  assert.deepEqual(viaPrefix, { city: 'Bergen', celsius: 18 }, 'prefixed call still hits the remote name');

  // A refresh re-lists and swaps the snapshot; old references stay readable.
  await client.refresh();
  assert.deepEqual(Object.keys(client.tools).sort(), ['echo', 'failing', 'weather'], 'snapshot after refresh');

  // Close is idempotent; after it the connection is gone (recovery = a new client).
  await client.close();
  await client.close();
  await assert.rejects(
    async () => {
      await tool('echo').execute({ value: 'x' }, context());
    },
    /Not connected/,
  );

  console.error(
    `[mcp-tools] ok — ${transport.type} round-trip: 3 tools bridged, text + structured + negative + prefix + refresh + close\n` +
      '[mcp-tools] spread them into an agent with  tools: () => client.tools',
  );
  process.exit(0);
}

/** Snapshot accessor: fails loudly on a missing name instead of testing `undefined`. */
function mustTool(client: McpClient, name: string): Tool {
  const found = client.tools[name];
  if (found === undefined) throw new Error(`tool ${name} missing from the snapshot`);
  return found;
}

/** The six-piece context every tool execute receives; only `signal` crosses the client bridge. */
function context() {
  const signal = new AbortController().signal;
  return {
    signal,
    runId: 'mcp-tools-example',
    toolCallId: 'example',
    requestContext: Object.freeze({ signal, runId: 'mcp-tools-example' }),
    traceId: '',
    spanId: '',
  };
}

/** Serves the HTTP face of the same server object on 127.0.0.1 (MCP_PORT, or an ephemeral port). */
async function serveHttp(): Promise<URL> {
  const httpServer = createServer();
  httpServer.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === 'host' || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const response = await server.fetch(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'content-encoding' && name !== 'transfer-encoding') outHeaders[name] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (response.body === null) {
        res.end();
        return;
      }
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const port = Number(process.env.MCP_PORT ?? 0);
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  const bound = (httpServer.address() as { port: number }).port;
  process.on('exit', () => httpServer.close());
  return new URL(`http://localhost:${bound}/mcp`);
}

function readBody(req: import('node:http').IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
  return new Promise((resolve, reject) => {
    req.on('end', () => {
      const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}
