/**
 * `refresh()` and `close()` semantics against the raw legacy mock: the snapshot swap (identity
 * changes, old references stay valid, a failed refresh keeps the old snapshot), and the session
 * teardown path (`terminateSession` → DELETE on close, once, idempotently).
 */
import { describe, expect, it } from 'vitest';
import { createMcpClient } from '@oribos/mcp-client';
import { serveLegacy, toolContext, toolOf } from './helpers.js';

describe('refresh', () => {
  it('swaps the snapshot: new tools appear, identity changes, old references stay valid', async () => {
    const served = await serveLegacy({
      tools: (listIndex) =>
        listIndex === 0
          ? [{ name: 'alpha', description: 'First', inputSchema: { type: 'object', properties: {} } }]
          : [
              { name: 'alpha', description: 'First', inputSchema: { type: 'object', properties: {} } },
              { name: 'beta', description: 'Second', inputSchema: { type: 'object', properties: {} } },
            ],
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const before = client.tools;
      expect(Object.keys(before)).toEqual(['alpha']);

      await client.refresh();

      expect(client.tools).not.toBe(before);
      expect(Object.keys(client.tools).sort()).toEqual(['alpha', 'beta']);
      expect(Object.keys(before)).toEqual(['alpha']);
      await client.close();
    } finally {
      await served.close();
    }
  });

  it('keeps the old snapshot and rejects when the re-list fails', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'alpha', description: 'First', inputSchema: { type: 'object', properties: {} } }],
      listErrorAfter: 0,
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });
      const before = client.tools;

      await expect(client.refresh()).rejects.toThrow(/mock list failure/);

      expect(client.tools).toBe(before);
      await expect(toolOf(client, 'alpha').execute(undefined, toolContext())).resolves.toBe('echo:alpha');
      await client.close();
    } finally {
      await served.close();
    }
  });
});

describe('close', () => {
  it('terminates the session once (DELETE), stays idempotent, keeps the snapshot readable', async () => {
    const served = await serveLegacy({
      tools: [{ name: 'alpha', description: 'First', inputSchema: { type: 'object', properties: {} } }],
      session: 'sess-7',
    });
    try {
      const client = await createMcpClient({ transport: { type: 'http', url: served.url } });

      await client.close();
      await client.close();

      const deletes = served.calls.filter((call) => call.method === 'DELETE');
      expect(deletes).toHaveLength(1);
      // No closed-observation surface: the snapshot stays readable after close.
      expect(Object.keys(client.tools)).toEqual(['alpha']);
    } finally {
      await served.close();
    }
  });
});
