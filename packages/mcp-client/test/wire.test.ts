/**
 * Wire-level behavior against the raw legacy mock: the era postures (`'auto'` falls back from a
 * dead probe, `'legacy'` never probes, a pin fails loudly), the package-fixed client identity,
 * header passthrough, connect-time timeout, and the result projections the HTTP fixtures can't
 * shape (multi-block content, placeholders, empty results, JSON-RPC error surfaces).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { createMcpClient } from '@oribos/mcp-client';
import { serveLegacy, toolContext, toolOf } from './helpers.js';

const TOOLS = [{ name: 'alpha', description: 'First', inputSchema: { type: 'object', properties: {} } }];

const caught = (call: unknown): Promise<unknown> =>
  Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error,
  );

describe('createMcpClient era postures and identity', () => {
  it("falls back from a dead discover probe by default ('auto') and advertises the package identity", async () => {
    const served = await serveLegacy({ tools: TOOLS });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });

      const discover = served.calls.find((call) => call.jsonRpc?.method === 'server/discover');
      expect(discover).toBeDefined();
      const initialize = served.calls.find((call) => call.jsonRpc?.method === 'initialize');
      expect(initialize).toBeDefined();
      expect(initialize?.jsonRpc?.params?.clientInfo).toEqual({
        name: '@oribos/mcp-client',
        version: packageVersion(),
      });
      expect(Object.keys(client.tools)).toEqual(['alpha']);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it("skips the probe entirely with protocol: 'legacy'", async () => {
    const served = await serveLegacy({ tools: TOOLS });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url }, protocol: 'legacy' });

      expect(served.calls.some((call) => call.jsonRpc?.method === 'server/discover')).toBe(false);
      expect(served.calls.some((call) => call.jsonRpc?.method === 'initialize')).toBe(true);
      expect(Object.keys(client.tools)).toEqual(['alpha']);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it("fails loudly against a legacy-only server with protocol: { pin: '2026-07-28' }", async () => {
    const served = await serveLegacy({ tools: TOOLS });
    try {
      const error = await caught(
        createMcpClient({ transport: { type: 'http', url: served.url }, protocol: { pin: '2026-07-28' } }),
      );
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
    } finally {
      await served.close();
    }
  });

  it('passes configured headers through to every request', async () => {
    const served = await serveLegacy({ tools: TOOLS });
    try {
      const client = await createMcpClient({
        transport: { type: 'http', url: served.url, headers: { authorization: 'Bearer test-token' } },
        protocol: 'legacy',
      });
      await client.close();

      const posts = served.calls.filter((call) => call.method === 'POST');
      expect(posts.length).toBeGreaterThan(0);
      for (const post of posts) expect(post.headers.authorization).toBe('Bearer test-token');
    } finally {
      await served.close();
    }
  });

  it('honors timeoutMs on the connect handshake', async () => {
    const served = await serveLegacy({ tools: TOOLS, initializeDelayMs: 400 });
    try {
      const error = await caught(
        createMcpClient({ transport: { type: 'http', url: served.url }, protocol: 'legacy', timeoutMs: 75 }),
      );
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
    } finally {
      await served.close();
    }
  });
});

describe('bridged tool result projections', () => {
  it('joins multiple text blocks with newlines', async () => {
    const served = await serveLegacy({
      tools: TOOLS,
      call: () => ({ content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }),
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).resolves.toBe('first\nsecond');
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('degrades non-text blocks to placeholder text', async () => {
    const served = await serveLegacy({
      tools: TOOLS,
      call: () => ({
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'aaaa', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///tmp/x', name: 'x' },
        ],
      }),
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).resolves.toBe(
        'look\n[unsupported content block: image]\n[unsupported content block: resource_link]',
      );
      await client.close();
    } finally {
      await served.close();
    }
  });

  it("returns '' for an empty result", async () => {
    const served = await serveLegacy({ tools: TOOLS, call: () => ({ content: [] }) });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).resolves.toBe('');
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('returns structuredContent verbatim, and passes a wire-invalid result through untouched', async () => {
    const served = await serveLegacy({
      tools: [...TOOLS, { name: 'broken', description: 'Sends junk', inputSchema: { type: 'object', properties: {} } }],
      call: (name) => {
        if (name === 'broken') {
          // `null` fails the SDK's own inbound validation for tools/call — exactly the kind of
          // wire-level failure this package must surface untouched (no layer, no rewrite).
          return { content: [{ type: 'text', text: 'n/a' }], structuredContent: null };
        }
        return { content: [{ type: 'text', text: 'data' }], structuredContent: { nested: [1, 2] } };
      },
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).resolves.toEqual({ nested: [1, 2] });
      const error = await caught(toolOf(client, 'broken').execute(undefined, toolContext()));
      expect(SdkError.isInstance(error)).toBe(true);
      expect((error as SdkError).code).toBe(SdkErrorCode.InvalidResult);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('throws the result text when the remote answers isError', async () => {
    const served = await serveLegacy({
      tools: TOOLS,
      call: () => ({ content: [{ type: 'text', text: 'the model sent bad arguments' }], isError: true }),
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).rejects.toThrow(/the model sent bad arguments/);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('propagates a JSON-RPC error for an unknown tool untouched', async () => {
    const served = await serveLegacy({
      tools: TOOLS,
      call: (name) => ({ jsonRpcError: { code: -32602, message: `Tool ${name} not found` } }),
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      await expect(client.tools.alpha?.execute(undefined, toolContext())).rejects.toThrow(/Tool alpha not found/);
      await client.close();
    } finally {
      await served.close();
    }
  });
});

function packageVersion(): string {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}
