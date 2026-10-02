/**
 * `@balsats/mcp-server` — the MCP server capability package: expose a `Record<string, Tool>` to MCP
 * clients over HTTP and stdio.
 *
 * One creation-time object with three members: `fetch` (the web-standard HTTP handler),
 * `serveStdio()` (the stdio entry), and `close()`. Both protocol generations are served by
 * default — the 2026-07-28 per-request model and the 2025 legacy handshake, stateless — and a
 * `'reject'` posture serves modern only. Legacy sessionful is deliberately out of v1 (wire it
 * yourself with the official `McpServer.connect(transport)`).
 *
 * The bridge is zero-adaptation by design: the SDK calls the tool schemas directly
 * (`~standard.validate` / `~standard.jsonSchema`), normalizes the three failure lines (input
 * validation / execute throw / output validation) into `isError` results, and owns the wire.
 * This package only synthesizes the six-piece `ToolContext`, projects results
 * (`structuredContent` + text), and validates tool names at construction.
 */

import { createMcpHandler, McpServer as SdkMcpServer } from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  CreateMcpHandlerOptions,
  McpHandlerRequestOptions,
  ServerContext,
  Transport,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ServeStdioOptions, StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { RequestContext } from '@balsats/core/agent';
import type { Tool, ToolContext } from '@balsats/core/tools';

/** What the server exposes: the identity it advertises, and the tool container to serve. */
export interface McpServerOptions {
  /** Server name, advertised in `serverInfo` and `server/discover`. */
  readonly name: string;
  /** Server version, advertised in `serverInfo` and `server/discover`. */
  readonly version: string;
  /** The tools to expose: keys are the MCP tool names (validated at construction). */
  readonly tools: Record<string, Tool>;
}

/** Creation-time options. `http.legacy` picks the 2025-era posture; omitted = 'stateless'. */
export interface McpServerConfig {
  /** HTTP entry options: how a 2025-era (legacy) request is served. */
  readonly http?: {
    /** `'stateless'` (default) serves legacy per request; `'reject'` serves modern only. */
    readonly legacy?: 'stateless' | 'reject';
  };
}

/** Options for `serveStdio`; v1 accepts only these two, everything else follows SDK defaults. */
export interface McpServerStdioOptions {
  /** `'serve'` (default, SDK behavior) or `'reject'` (modern-only opening). */
  readonly legacy?: 'serve' | 'reject';
  /** Bring your own transport (tests, Unix-socket/TCP stdio); default = process stdio. */
  readonly transport?: Transport;
}

/** The handle of one started stdio connection; `close()` tears it down. */
export interface McpServerStdioHandle {
  close(): Promise<void>;
}

/** The `fetch` options passed through to the SDK handler. */
export type McpServerRequestOptions = McpHandlerRequestOptions;

/** The server handle: HTTP entry, stdio entry, and a close that tears down every opened entry. */
export interface McpServer {
  /**
   * The web-standard HTTP handler: `export default { fetch }`, or mount it on any framework.
   * `options` is passed through to the SDK (`parsedBody` for pre-parsed frameworks; `authInfo`
   * is pass-through and not consumed in v1). Throws once `close()` has run.
   */
  readonly fetch: (request: Request, options?: McpServerRequestOptions) => Promise<Response>;
  /** Starts a stdio connection from the same factory. */
  serveStdio(options?: McpServerStdioOptions): McpServerStdioHandle;
  /** Closes every opened entry and aborts in-flight exchanges. */
  close(): Promise<void>;
}

/**
 * Creates an MCP server for a tool container.
 *
 * Tool names are validated up front — `[A-Za-z0-9_.-]{1,128}`, the MCP spec's SHOULD charset —
 * and an illegal key throws here, before any request is served: a key legal in the agent domain
 * is not necessarily legal over MCP. The SDK itself does no charset validation, so the check
 * lives here.
 *
 * Each request/connection gets a fresh SDK server with the whole container registered (the SDK
 * factory model); the factory is cheap and side-effect free, and the container is snapshotted at
 * construction so later mutation of the caller's object changes nothing on the wire.
 */
export function createMcpServer(options: McpServerOptions, config: McpServerConfig = {}): McpServer {
  const entries = Object.entries(options.tools);
  for (const [name] of entries) assertMcpToolName(name);

  const factory = () => buildSdkServer(options.name, options.version, entries);

  const httpOptions: CreateMcpHandlerOptions = {};
  if (config.http?.legacy !== undefined) httpOptions.legacy = config.http.legacy;
  const handler = createMcpHandler(factory, httpOptions);

  const stdioHandles = new Set<StdioServerHandle>();
  return {
    fetch: handler.fetch,
    serveStdio(stdioOptions = {}) {
      const sdkOptions: ServeStdioOptions = {};
      if (stdioOptions.legacy !== undefined) sdkOptions.legacy = stdioOptions.legacy;
      if (stdioOptions.transport !== undefined) sdkOptions.transport = stdioOptions.transport;
      const handle = serveStdio(factory, sdkOptions);
      stdioHandles.add(handle);
      return {
        async close() {
          stdioHandles.delete(handle);
          await handle.close();
        },
      };
    },
    async close() {
      const handles = [...stdioHandles];
      stdioHandles.clear();
      for (const handle of handles) await handle.close();
      await handler.close();
    },
  };
}

/**
 * The MCP spec's tool-name SHOULD: 1–128 characters from `[A-Za-z0-9_.-]` (the dot is the
 * difference from the agent domain's own rule). Alignment recorded in ADR-0008.
 */
const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function assertMcpToolName(name: string): void {
  if (MCP_TOOL_NAME.test(name)) return;
  throw new Error(
    `Tool name "${name}" is not valid over MCP: expected 1-128 characters from [A-Za-z0-9_.-].`,
  );
}

/**
 * Builds one SDK server for one serving unit (an HTTP request, a stdio connection). Static
 * tools never change, so `listChanged` is advertised as false — the SDK default would claim
 * true, and the `notify` / `bus` members that would emit those notifications are not exposed.
 */
function buildSdkServer(name: string, version: string, entries: ReadonlyArray<[string, Tool]>): SdkMcpServer {
  const server = new SdkMcpServer({ name, version }, { capabilities: { tools: { listChanged: false } } });
  for (const [toolName, tool] of entries) registerBridgedTool(server, toolName, tool);
  return server;
}

/**
 * Registers one tool with the SDK. The schemas go over untouched (Standard Schema dual
 * interface): the SDK validates input and output through `~standard.validate()`, and derives the
 * `tools/list` JSON Schema through `~standard.jsonSchema` — no adapter, no rewriting. The
 * handler shape follows the SDK's own rule: with `inputSchema` the callback receives the
 * validated arguments, without it only the context (the tool is argument-less).
 */
function registerBridgedTool(server: SdkMcpServer, name: string, tool: Tool): void {
  const base = {
    description: tool.description,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  };
  if (tool.inputSchema === undefined) {
    // The SDK's own shape rule: without `inputSchema` the callback receives only the context.
    server.registerTool(name, base, (ctx) => invokeTool(tool, undefined, ctx));
  } else {
    server.registerTool(name, { ...base, inputSchema: tool.inputSchema }, (args, ctx) =>
      invokeTool(tool, args, ctx),
    );
  }
}

/** Runs one tool call and projects its result onto the wire result. */
async function invokeTool(tool: Tool, input: unknown, ctx: ServerContext): Promise<CallToolResult> {
  const output = await tool.execute(input, toolContext(ctx));
  const content = [{ type: 'text' as const, text: render(output) }];
  return tool.outputSchema === undefined ? { content } : { content, structuredContent: output };
}

/**
 * The six pieces MCP can supply: `signal` is the request's, and
 * `toolCallId` is the JSON-RPC request id stringified (an identity across the connection, not a
 * stable one). `runId` / `traceId` / `spanId` have no MCP counterpart and stay empty, the same
 * encoding as no-attached-tracer runs; `requestContext` is the frozen empty bag with the
 * framework-written fields only — MCP facts (`authInfo`, era) are not stuffed in.
 */
function toolContext(ctx: ServerContext): ToolContext {
  const signal = ctx.mcpReq.signal;
  const requestContext: RequestContext = Object.freeze({ signal, runId: '' });
  return {
    signal,
    runId: '',
    toolCallId: String(ctx.mcpReq.id),
    requestContext,
    traceId: '',
    spanId: '',
  };
}

/**
 * The text rendered alongside `structuredContent`: a string passes
 * through verbatim, everything else is JSON; a stringify miss (`undefined`, functions, symbols)
 * degrades to `String(value)` so the text block is never absent.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}
