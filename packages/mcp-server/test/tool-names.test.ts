import { describe, expect, it } from 'vitest';
import { createMcpServer } from '@oribos/mcp-server';
import type { Tool } from '@oribos/core/tools';

const ping: Tool = { description: 'ping', execute: () => 'pong' };

/**
 * Tool names are the one thing the agent domain cannot police: a key legal in a `Record<string,
 * Tool>` is not necessarily legal over MCP. `createMcpServer()` validates the spec's SHOULD
 * charset (`[A-Za-z0-9_.-]{1,128}`) at construction — before any request is served.
 */
describe('createMcpServer tool name validation', () => {
  it.each(['has space', '', '中文', 'slash/name', 'at@name', 'x'.repeat(129)])(
    'rejects the illegal name %j at construction',
    (name) => {
      expect(() => createMcpServer({ name: 'srv', version: '0.0.0', tools: { [name]: ping } })).toThrow(
        /not valid over MCP/,
      );
    },
  );

  it('names the offending tool in the error message', () => {
    expect(() => createMcpServer({ name: 'srv', version: '0.0.0', tools: { 'has space': ping } })).toThrow(
      /"has space"/,
    );
  });

  it('accepts the spec charset (dot, dash, underscore, digits) and 128 characters', () => {
    expect(() =>
      createMcpServer({ name: 'srv', version: '0.0.0', tools: { 'a.b-c_d9': ping, ['x'.repeat(128)]: ping } }),
    ).not.toThrow();
  });
});
