/**
 * Protocol selection and the official env passthrough
 * (`docs/architecture/observability.md`「包面」): `protocol` is this package's own env face
 * (`OTEL_EXPORTER_OTLP_PROTOCOL` — the official exporter packages do not read it), explicit
 * options outrank env, and everything else the official base still resolves from the
 * `OTEL_EXPORTER_OTLP_*` family. Wire-level against the local capture endpoint.
 */
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOtlpExporter } from '@oribos/otlp';
import { decodeSpans, exportAndFlush, saveOtelEnv, startCapture, testSpan, type CapturedRequest, type NonEmpty } from './helpers.js';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = saveOtelEnv();
});
afterEach(() => {
  restoreEnv();
});

const ship = async (
  capture: Awaited<ReturnType<typeof startCapture>>,
  exporter = createOtlpExporter({ url: capture.url }),
): Promise<NonEmpty<CapturedRequest>> => {
  const before = capture.requests.length;
  await exportAndFlush(exporter, { kind: 'span_ended', span: testSpan() });
  const requests = await capture.waitForRequests(before + 1);
  const fresh = requests.slice(before);
  return [fresh[0]!, ...fresh.slice(1)];
};

describe('protocol selection', () => {
  it('defaults to protobuf and reads OTEL_EXPORTER_OTLP_PROTOCOL for the JSON package', async () => {
    const capture = await startCapture();
    try {
      const [protoRequest] = await ship(capture);
      expect(protoRequest.headers['content-type']).toContain('application/x-protobuf');

      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'json';
      const [jsonRequest] = await ship(capture);
      expect(jsonRequest.headers['content-type']).toContain('application/json');
      // The protobuf wire bytes still decode as a real request — the capture saw one span each.
      expect(decodeSpans(jsonRequest.body)).toHaveLength(1);
    } finally {
      await capture.close();
    }
  });

  it('lets the explicit option outrank the env face', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'json';
      const [request] = await ship(
        capture,
        createOtlpExporter({ protocol: 'protobuf', url: capture.url }),
      );
      expect(request.headers['content-type']).toContain('application/x-protobuf');
    } finally {
      await capture.close();
    }
  });

  it('falls back to protobuf for unsupported env values instead of breaking telemetry', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
      const [request] = await ship(capture);
      expect(request.headers['content-type']).toContain('application/x-protobuf');
    } finally {
      await capture.close();
    }
  });
});

describe('official env passthrough (regression)', () => {
  it('resolves the endpoint from OTEL_EXPORTER_OTLP_ENDPOINT and appends the signal path', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.endpoint;
      const [request] = await ship(capture, createOtlpExporter({ protocol: 'json' }));
      expect(request.path).toBe('/v1/traces');
    } finally {
      await capture.close();
    }
  });

  it('takes OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as-is, specialized over common', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.endpoint;
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${capture.endpoint}/custom/traces`;
      const [request] = await ship(capture, createOtlpExporter({ protocol: 'json' }));
      expect(request.path).toBe('/custom/traces');
    } finally {
      await capture.close();
    }
  });

  it('sends OTEL_EXPORTER_OTLP_HEADERS and merges the TRACES_* specialization on top', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.endpoint;
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=secret,x-shared=common';
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-shared=specialized';
      const [request] = await ship(capture, createOtlpExporter({ protocol: 'json' }));
      expect(request.headers['x-api-key']).toBe('secret');
      expect(request.headers['x-shared']).toBe('specialized');
    } finally {
      await capture.close();
    }
  });

  it('honors OTEL_EXPORTER_OTLP_COMPRESSION=gzip end to end', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.endpoint;
      process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
      const [request] = await ship(capture, createOtlpExporter({ protocol: 'json' }));
      expect(request.headers['content-encoding']).toBe('gzip');
      const decoded = decodeSpans(gunzipSync(request.body).toString('utf8'));
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.name).toBe('test-span');
    } finally {
      await capture.close();
    }
  });

  it('carries an explicit option over the env face', async () => {
    const capture = await startCapture();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = capture.endpoint;
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=from-env';
      const [request] = await ship(
        capture,
        createOtlpExporter({ protocol: 'json', headers: { 'x-api-key': 'from-option' } }),
      );
      expect(request.headers['x-api-key']).toBe('from-option');
    } finally {
      await capture.close();
    }
  });

  it('keeps export() silent and passes the official flush rejection through', async () => {
    const capture = await startCapture();
    try {
      // No server on this port: export() only enqueues (never throws); an explicit flush() gets
      // the official batch processor's own rejection — the framework tracer forwards it as-is.
      const deadExporter = createOtlpExporter({
        protocol: 'json',
        url: 'http://127.0.0.1:1/v1/traces',
        timeoutMillis: 10,
      });
      expect(() =>
        deadExporter.export({ kind: 'span_ended', span: testSpan({ name: 'lost' }) }),
      ).not.toThrow();
      await expect(deadExporter.flush!()).rejects.toThrow();

      // A failed export never breaks the process: the healthy exporter still works.
      const healthy = createOtlpExporter({ protocol: 'json', url: capture.url });
      const [request] = await ship(capture, healthy);
      expect(decodeSpans(request.body)).toHaveLength(1);
    } finally {
      await capture.close();
    }
  });

  it('passes the batch tuning through to the official processor', async () => {
    const capture = await startCapture();
    try {
      const exporter = createOtlpExporter({
        protocol: 'json',
        url: capture.url,
        batch: { maxExportBatchSize: 1, scheduledDelayMillis: 60_000 },
      });
      // maxExportBatchSize 1: the first ended span ships without any explicit flush.
      await exporter.export({ kind: 'span_ended', span: testSpan({ name: 'auto' }) });
      const request = (await capture.waitForRequests(1))[0]!;
      expect(decodeSpans(request.body).map((span) => span.name)).toEqual(['auto']);
    } finally {
      await capture.close();
    }
  });
});
