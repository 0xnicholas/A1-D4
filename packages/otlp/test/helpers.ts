/**
 * Wire helpers for the OTLP package tests: a local capture endpoint (node:http on loopback, no
 * network beyond 127.0.0.1) plus an OTLP/JSON decoder — the assertions read the exact
 * ExportTraceServiceRequest the official exporter put on the wire, not our own serialization.
 *
 * Spans are hand-built `ExportedSpan` fixtures: the seam under test is the exporter's
 * `export(event)` face, not the core tracer (that dispatch is core's own, already covered there).
 */
import { createOtlpExporter } from '@oribos/otlp';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExportedSpan } from '@oribos/core/observability';

/** One request the capture endpoint received. */
export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

export interface CaptureEndpoint {
  /** The base endpoint (`http://127.0.0.1:<port>`), for `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint: string;
  /** The full trace endpoint (`…/v1/traces`), for the exporter's `url` option. */
  readonly url: string;
  /** The port, for building arbitrary paths. */
  readonly port: number;
  readonly requests: CapturedRequest[];
  /** Resolves once `count` requests have arrived (throws on timeout). */
  waitForRequests(count: number, timeoutMillis?: number): Promise<CapturedRequest[]>;  close(): Promise<void>;
}

/** Starts the capture endpoint: 200 + `{}` (the official exporter's success shape). */
export async function startCapture(): Promise<CaptureEndpoint> {
  const requests: CapturedRequest[] = [];
  const waiters: { count: number; resolve: (r: CapturedRequest[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '/',
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      });
      for (const waiter of waiters.splice(0)) {
        if (requests.length >= waiter.count) {
          clearTimeout(waiter.timer);
          waiter.resolve(requests.slice());
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    endpoint,
    url: `${endpoint}/v1/traces`,
    port,
    requests,
    waitForRequests(count, timeoutMillis = 5_000) {
      if (requests.length >= count) return Promise.resolve(requests.slice());
      return new Promise((resolve, reject) => {
        const waiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(new Error(`capture endpoint saw ${requests.length}/${count} requests within ${timeoutMillis} ms`));
          }, timeoutMillis),
        };
        waiters.push(waiter);
      });
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** The `OTEL_*` environment variables the exporter faces (official base + this package's own). */
const OTEL_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
] as const;

/** Clears every `OTEL_*` variable the exporter faces — construction reads env, tests vary it. */
export function clearOtelEnv(): void {
  for (const name of OTEL_ENV_VARS) delete process.env[name];
}

/** Saves the current `OTEL_*` face; call the returned restore in `afterEach`. */
export function saveOtelEnv(): () => void {
  const saved = Object.fromEntries(
    OTEL_ENV_VARS.map((name) => [name, process.env[name]] as const),
  ) as Record<(typeof OTEL_ENV_VARS)[number], string | undefined>;
  clearOtelEnv();
  return () => {
    clearOtelEnv();
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  };
}

/** A hand-built span fixture with valid OTel-compatible hex ids and known timestamps. */
export function testSpan(
  overrides: { [K in keyof ExportedSpan]?: ExportedSpan[K] | undefined } = {},
): ExportedSpan {
  // The cast admits an explicit `undefined` override (removing `endTime` for an isEvent fixture)
  // that the mapped type allows but the spread's inference reads as a missing required field.
  return {
    id: 'aaaa00000000bbbb',
    traceId: 'cccc000000000000000000000000dddd',
    name: 'test-span',
    type: 'signal',
    startTime: new Date('2026-10-01T00:00:00.250Z'),
    endTime: new Date('2026-10-01T00:00:01.750Z'),
    ...overrides,
  } as ExportedSpan;
}

/** One decoded OTLP/JSON span, attributes flattened to a plain record. */
export interface DecodedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: number;
  readonly flags: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly status: { code?: number; message?: string } | undefined;
  readonly attributes: Record<string, unknown>;
  readonly droppedAttributesCount: number;
  readonly resource: Record<string, unknown>;
  readonly scope: { name: string; version?: string };
}

/** Decodes one attribute value envelope (`{stringValue: …}` / `{intValue: '…'}` / arrays / maps). */
function decodeAttributeValue(envelope: Record<string, unknown>): unknown {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  if ('stringValue' in envelope) return envelope.stringValue;
  if ('boolValue' in envelope) return envelope.boolValue;
  if ('intValue' in envelope) return Number(envelope.intValue);
  if ('doubleValue' in envelope) return envelope.doubleValue;
  if ('bytesValue' in envelope) return envelope.bytesValue;
  if ('arrayValue' in envelope) {
    const values = (envelope.arrayValue as { values?: unknown[] } | undefined)?.values ?? [];
    return values.map((value) => decodeAttributeValue(value as Record<string, unknown>));
  }
  if ('kvlistValue' in envelope) {
    const pairs = (envelope.kvlistValue as { values?: { key: string; value: unknown }[] } | undefined)?.values ?? [];
    return Object.fromEntries(pairs.map((pair) => [pair.key, decodeAttributeValue(pair.value as Record<string, unknown>)]));
  }
  return undefined;
}

function decodeAttributes(keyValues: { key: string; value: Record<string, unknown> }[] | undefined): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const { key, value } of keyValues ?? []) {
    record[key] = decodeAttributeValue(value);
  }
  return record;
}

/** Decodes an OTLP/JSON ExportTraceServiceRequest body into flat per-span records. */
export function decodeSpans(body: string | Buffer): DecodedSpan[] {
  const document = JSON.parse(String(body)) as {
    resourceSpans?: {
      resource?: { attributes?: { key: string; value: Record<string, unknown> }[] };
      scopeSpans?: {
        scope?: { name?: string; version?: string };
        spans?: Record<string, unknown>[];
      }[];
    }[];
  };
  const decoded: DecodedSpan[] = [];
  for (const resourceSpans of document.resourceSpans ?? []) {
    const resource = decodeAttributes(resourceSpans.resource?.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        decoded.push({
          traceId: String(span.traceId),
          spanId: String(span.spanId),
          parentSpanId: span.parentSpanId === undefined || span.parentSpanId === '' ? undefined : String(span.parentSpanId),
          name: String(span.name),
          kind: Number(span.kind),
          flags: Number(span.flags ?? 0),
          startTimeUnixNano: String(span.startTimeUnixNano),
          endTimeUnixNano: String(span.endTimeUnixNano),
          status: span.status as DecodedSpan['status'],
          attributes: decodeAttributes(span.attributes as { key: string; value: Record<string, unknown> }[] | undefined),
          droppedAttributesCount: Number(span.droppedAttributesCount ?? 0),
          resource,
          scope: {
            name: String(scopeSpans.scope?.name ?? ''),
            ...(scopeSpans.scope?.version === undefined ? {} : { version: scopeSpans.scope.version }),
          },
        });
      }
    }
  }
  return decoded;
}

/** Exports spans through an exporter and flushes — the tests' standard send-and-await. */
export async function exportAndFlush(
  exporter: { export(event: unknown): unknown; flush?(): Promise<void> },
  ...events: unknown[]
): Promise<void> {
  for (const event of events) await exporter.export(event);
  await exporter.flush?.();
}

/** A decoded batch known to hold at least one span (the `shipSpans` contract). */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * Ships ended spans through a fresh JSON-protocol exporter pointed at a fresh capture endpoint and
 * returns the decoded wire spans — the mapping tests' one-liner.
 */
export async function shipSpans(...spans: ExportedSpan[]): Promise<NonEmpty<DecodedSpan>> {
  const capture = await startCapture();
  try {
    const exporter = createOtlpExporter({ protocol: 'json', url: capture.url });
    for (const span of spans) await exporter.export({ kind: 'span_ended', span });
    await exporter.flush!();
    const [request] = await capture.waitForRequests(1);
    const decoded = decodeSpans(request!.body);
    return [decoded[0]!, ...decoded.slice(1)];
  } finally {
    await capture.close();
  }
}
