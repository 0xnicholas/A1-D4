/**
 * `@balsats/mcp-client` — the MCP client capability package: bridge a remote MCP server's tools
 * into the framework's `Record<string, Tool>` container, ready to spread straight into an agent.
 *
 * One connection, one object with three members: `tools` (a getter over the current snapshot),
 * `refresh()` (re-list and swap the snapshot), and `close()` (terminate the session and tear the
 * connection down, idempotently). No auto-reconnect — a dropped connection surfaces as SDK
 * errors on the calls in flight and after; recovery is a new client. No `listChanged`
 * subscription either — a long-lived agent reads the latest snapshot through
 * `tools: () => client.tools` (a dynamic argument resolves it per request).
 *
 * The bridge is deliberately thin. Schemas go over as a JSON Schema pass-through Standard
 * Schema wrapper (validation is the remote's business; failures come back through the execute
 * path); results project as `structuredContent` verbatim or joined text; `isError` results
 * throw so the agent loop turns them into `Tool 'x' failed: …` error results. Everything else —
 * era negotiation (default raised to `'auto'`: probe `server/discover`, fall back to the 2025
 * handshake), the 60s per-request timeout, `inputRequired.autoFulfill: false` — is the SDK's
 * own semantics, configured once here and never re-wrapped.
 */

import { createRequire } from 'node:module';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ContentBlock,
  Transport,
  VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Tool, ToolContext } from '@balsats/core/tools';
import type { StandardSchema } from '@balsats/core/tools';

/** The identity this package advertises to servers — its own name and version, not overridable. */
const CLIENT_NAME = '@balsats/mcp-client';
const { version: CLIENT_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

/** How to reach the server: a stdio subprocess the SDK owns, or a Streamable HTTP endpoint. */
export type McpClientTransport =
  | {
      readonly type: 'stdio';
      /** The executable to run (the SDK owns the subprocess and its shutdown: stdin → SIGTERM → SIGKILL). */
      readonly command: string;
      readonly args?: readonly string[];
      /**
       * The child's whole environment. Given, it replaces everything; omitted, the SDK applies
       * its own safe-default whitelist (not the full `process.env`).
       */
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'http';
      /** The Streamable HTTP endpoint. */
      readonly url: string | URL;
      /** Request headers applied to every request (bearer tokens and the like). */
      readonly headers?: Readonly<Record<string, string>>;
    };

/**
 * Which protocol generation to speak. `'auto'` (the default — raised here, the SDK's own default
 * is `'legacy'`) probes with `server/discover` first and falls back to the 2025 handshake;
 * `'legacy'` skips the probe; `{ pin: '2026-07-28' }` demands the modern era and fails loudly.
 */
export type McpClientProtocol = 'auto' | 'legacy' | { readonly pin: '2026-07-28' };

/** Creation-time options. */
export interface McpClientConfig {
  readonly transport: McpClientTransport;
  /** Protocol generation posture; omitted = `'auto'`.
   */
  readonly protocol?: McpClientProtocol;
  /**
   * Per-request timeout in milliseconds, passed through to the connect handshake and every
   * request the client makes. The SDK has no client-level default setting — without this the
   * SDK's own 60s applies (`DEFAULT_REQUEST_TIMEOUT_MSEC`). No per-call override.
   */
  readonly timeoutMs?: number;
}

/** A connected MCP client: the tool snapshot, a refresh, and a close. */
export interface McpClient {
  /**
   * The current snapshot as a `Record<string, Tool>` — spread it into an agent's tool container.
   * The object identity is stable until the next `refresh()`; old references never break.
   */
  readonly tools: Record<string, Tool>;
  /** Re-lists the remote tools and swaps the snapshot; on failure keeps the old one and rejects. */
  refresh(): Promise<void>;
  /**
   * Tears the connection down, idempotently: HTTP sends `terminateSession` first (a failure
   * there is silent), then the client closes — in-flight requests reject with
   * `CONNECTION_CLOSED`, a stdio subprocess shuts down in the SDK's order.
   */
  close(): Promise<void>;
}

/**
 * Connects to an MCP server and bridges its tools into the framework's `Tool` container.
 *
 * The connection happens up front: a failed handshake (era negotiation, 401/403, probe timeout)
 * rejects here, never later. On success `tools` already holds the first snapshot.
 */
export async function createMcpClient(config: McpClientConfig): Promise<McpClient> {
  const timeout = config.timeoutMs;
  const requestOptions = timeout === undefined ? undefined : { timeout };

  let terminate: (() => Promise<void>) | undefined;
  let transport: Transport;
  if (config.transport.type === 'stdio') {
    transport = new StdioClientTransport({
      command: config.transport.command,
      ...(config.transport.args === undefined ? {} : { args: [...config.transport.args] }),
      ...(config.transport.env === undefined ? {} : { env: { ...config.transport.env } }),
    });
  } else {
    const http = new StreamableHTTPClientTransport(new URL(config.transport.url), {
      ...(config.transport.headers === undefined
        ? {}
        : { requestInit: { headers: { ...config.transport.headers } } }),
    });
    transport = http;
    terminate = () => http.terminateSession();
  }

  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    {
      // The default is raised to 'auto' here: probe with server/discover, fall back to legacy.
      versionNegotiation: { mode: protocolMode(config.protocol) },
      // No elicitation/sampling handlers exist to fulfil with — an `input_required` result must
      // surface as a deterministic error, not a silent auto-flow.
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(transport, requestOptions);

  const call = (name: string, input: unknown, ctx: ToolContext): Promise<unknown> =>
    client
      .callTool(
        { name, ...(input === undefined ? {} : { arguments: input as Record<string, unknown> }) },
        { signal: ctx.signal, ...(timeout === undefined ? {} : { timeout }) },
      )
      .then((result) => projectResult(name, result));

  let snapshot = buildSnapshot((await listTools(client, requestOptions)).tools, call);
  let closed = false;

  return {
    get tools() {
      return snapshot;
    },
    async refresh() {
      // cacheMode 'refresh' forces a real fetch past the SDK's response cache; the snapshot is
      // only swapped on success, so a failure leaves the old one fully in place.
      const listed = await client.listTools(undefined, {
        cacheMode: 'refresh',
        ...(timeout === undefined ? {} : { timeout }),
      });
      snapshot = buildSnapshot(listed.tools, call);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (terminate !== undefined) {
        try {
          await terminate();
        } catch {
          // Silent by spec: the server may not support session teardown, or is already gone.
        }
      }
      await client.close();
    },
  };
}

/** Maps the package's protocol posture onto the SDK's negotiation mode one-to-one. */
function protocolMode(protocol: McpClientProtocol | undefined): VersionNegotiationMode {
  return protocol ?? 'auto';
}

/** One list call shared by connect and refresh; the plain form at connect (empty cache → real fetch). */
function listTools(client: Client, requestOptions: { timeout: number } | undefined) {
  return client.listTools(undefined, requestOptions);
}

/**
 * Builds a frozen snapshot: one bridged `Tool` per remote entry. The remote name is the key and
 * the name used on the wire; remote tool names are neither validated nor mangled here (the MCP
 * charset is wider than most providers' — renaming, if wanted, is `prefixTools`' caller's call).
 */
function buildSnapshot(
  remoteTools: Array<{ name: string; description?: string | undefined; inputSchema: unknown }>,
  call: (name: string, input: unknown, ctx: ToolContext) => Promise<unknown>,
): Record<string, Tool> {
  const snapshot: Record<string, Tool> = {};
  for (const remote of remoteTools) {
    const { name } = remote;
    snapshot[name] = Object.freeze({
      description: remote.description ?? '',
      inputSchema: jsonSchemaPassthrough(remote.inputSchema as Record<string, unknown>),
      execute: (input: unknown, ctx: ToolContext) => call(name, input, ctx),
    });
  }
  return Object.freeze(snapshot);
}

/**
 * The result projection: `structuredContent !== undefined` returns that
 * value verbatim (any JSON flows — `ToolResultChunk.output` is `unknown`); otherwise the text
 * blocks join on newlines with non-text blocks degrading to placeholder text — the tool-result
 * channel carries no multimodal parts, an honest v1 boundary; an empty result is `''`. An
 * `isError` result throws, so the framework turns it into a `Tool 'x' failed: …` error result
 * fed back to the model — the same road the three server-side failure lines take.
 */
function projectResult(name: string, result: CallToolResult): unknown {
  const text = contentText(result.content);
  if (result.isError === true) throw new Error(text === '' ? `Tool '${name}' failed` : text);
  if (result.structuredContent !== undefined) return result.structuredContent;
  return text;
}

/** Text blocks verbatim, other blocks as placeholders, joined on newlines; empty content is ''. */
function contentText(content: ReadonlyArray<ContentBlock> | undefined): string {
  if (content === undefined || content.length === 0) return '';
  return content
    .map((block) => (block.type === 'text' ? block.text : `[unsupported content block: ${block.type}]`))
    .join('\n');
}

/**
 * The JSON Schema pass-through wrapper — an internal factory, not
 * exported. `validate` always succeeds synchronously (validation is the remote's business; a
 * failure comes back through the execute error path), `jsonSchema.input` returns the remote
 * document verbatim — same reference, target ignored: remote schemas are commonly 2020-12 while
 * the core asks providers for draft-07, and this bridge rewrites nothing. `jsonSchema.output`
 * throws: a bridged tool carries no output schema, and a fake would only validate vacuously.
 * The wrapper and its `~standard` bag are frozen.
 */
function jsonSchemaPassthrough(remote: Record<string, unknown>): StandardSchema<unknown, unknown> {
  const wrapper: StandardSchema<unknown, unknown> = {
    '~standard': Object.freeze({
      version: 1,
      vendor: 'balsats',
      types: Object.freeze({ input: undefined, output: undefined }),
      validate: Object.freeze((value: unknown) => ({ value })),
      jsonSchema: Object.freeze({
        input: Object.freeze(() => remote),
        output: Object.freeze(() => {
          throw new Error('A bridged MCP tool has no output schema: the remote schema stays on the server.');
        }),
      }),
    }),
  };
  return Object.freeze(wrapper);
}

/**
 * Renames bridged tools with a fixed prefix: returns a new frozen `Record<string, Tool>` keyed
 * `prefix + separator + name` (separator defaults to `'_'`). The prefix never reaches the wire —
 * the tool objects are untouched, and the remote name in each execute closure is unchanged. A
 * fixed prefix is an isomorphic mapping, so no collision detection runs; whether a prefixed name
 * is legal for a given provider is the caller's concern. Not part of the client config surface.
 */
export function prefixTools(
  tools: Record<string, Tool>,
  prefix: string,
  separator = '_',
): Record<string, Tool> {
  const prefixed: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) prefixed[prefix + separator + name] = tool;
  return Object.freeze(prefixed);
}
