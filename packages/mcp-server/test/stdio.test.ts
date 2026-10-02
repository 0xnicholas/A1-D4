import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '@balsats/mcp-server';
import type { McpServer } from '@balsats/mcp-server';
import { createTool } from '@balsats/core/tools';
import type { JsonRpcMessage } from './helpers.js';
import { initializeRequest, rpc, sendWire, toolsOf } from './helpers.js';

interface StdioHarness {
  readonly client: InMemoryTransport;
  readonly messages: JsonRpcMessage[];
  readonly handle: { close(): Promise<void> };
}

/**
 * The stdio face through its in-process seam: the official in-memory transport pair stands in
 * for the process stdio pipes, so the same factory and the same wire behavior are testable
 * without spawning a child process.
 */
async function openStdio(server: McpServer, legacy?: 'serve' | 'reject'): Promise<StdioHarness> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const messages: JsonRpcMessage[] = [];
  client.onmessage = (message) => {
    messages.push(message as unknown as JsonRpcMessage);
  };
  await client.start();
  const handle = server.serveStdio(legacy === undefined ? { transport: serverSide } : { legacy, transport: serverSide });
  return { client, messages, handle };
}

describe('serveStdio', () => {
  it('serves a stdio connection through the transport seam', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ name: 'stdio-srv', version: '0.0.0', tools: { ping } });
    const { client, messages } = await openStdio(server);

    await sendWire(client, initializeRequest());
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.result).toMatchObject({ serverInfo: { name: 'stdio-srv', version: '0.0.0' } });

    await sendWire(client, rpc('tools/list', {}, 2));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(toolsOf({ status: 200, message: messages[1] ?? {} }).map((tool) => tool.name)).toEqual(['ping']);

    await sendWire(client, rpc('tools/call', { name: 'ping', arguments: {} }, 3));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]?.result).toMatchObject({ content: [{ type: 'text', text: 'pong' }] });

    await server.close();
  });

  it('rejects a legacy opening when the stdio posture is reject', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ name: 'stdio-srv', version: '0.0.0', tools: { ping } });
    const { client, messages, handle } = await openStdio(server, 'reject');

    await sendWire(client, initializeRequest());
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.error?.code).toBe(-32022);
    expect(messages[0]?.error?.data?.supported).toContain('2026-07-28');

    await handle.close();
    await server.close();
  });

  it('closes opened stdio connections on server.close()', async () => {
    const ping = createTool({ description: 'Ping', execute: () => 'pong' });
    const server = createMcpServer({ name: 'stdio-srv', version: '0.0.0', tools: { ping } });
    const { client } = await openStdio(server);

    await server.close();

    await expect(sendWire(client, rpc('tools/list', {}, 4))).rejects.toThrow(/not connected/i);
  });
});
