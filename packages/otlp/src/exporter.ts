/**
 * The exporter factory (`docs/architecture/observability.md`「包面」): one `createOtlpExporter`
 * wrapping the official OTLP exporter (protocol-selected: protobuf by default, JSON via option or
 * this package's own `OTEL_EXPORTER_OTLP_PROTOCOL` face) behind the official `BatchSpanProcessor`.
 * Configuration priority is explicit option > env > official defaults — unset items pass through
 * to the official base, which reads the `OTEL_EXPORTER_OTLP_*` family itself.
 *
 * The failure face is the official batch semantics: `export()` only enqueues and never throws,
 * a full queue drops silently, export failures are silent, diagnostics ride OTel diag. No retry,
 * logging, or `onError` of our own — those belong to the official base.
 */
import { diag } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ObservabilityExporter } from '@balsats/core/observability';
import { toReadableSpan } from './to-readable.js';

/** Batch tuning, passed straight to the official `BatchSpanProcessor`. */
export interface OtlpExporterBatchOptions {
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMillis?: number;
  readonly maxQueueSize?: number;
  readonly exportTimeoutMillis?: number;
}

/** `createOtlpExporter` options (`docs/architecture/observability.md`「包面」). */
export interface OtlpExporterOptions {
  /** Transport protocol; defaults to `protobuf` (option > `OTEL_EXPORTER_OTLP_PROTOCOL` > default). */
  readonly protocol?: 'protobuf' | 'json';
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMillis?: number;
  readonly compression?: 'none' | 'gzip';
  readonly serviceName?: string;
  readonly resourceAttributes?: Record<
    string,
    string | number | boolean | ReadonlyArray<string | number | boolean>
  >;
  readonly batch?: OtlpExporterBatchOptions;
}

/** The official exporter's constructor config, derived without importing its transitive types. */
type ExporterConfig = NonNullable<ConstructorParameters<typeof OTLPTraceExporterProto>[0]>;

const PROTOCOL_ENV = 'OTEL_EXPORTER_OTLP_PROTOCOL';

/**
 * Protocol selection — this package's own env face: the official exporter packages do not read
 * `OTEL_EXPORTER_OTLP_PROTOCOL` (protocol = which package you load). Unsupported values warn on
 * OTel diag and fall back to `protobuf` rather than breaking telemetry.
 */
function resolveProtocol(explicit: OtlpExporterOptions['protocol']): 'protobuf' | 'json' {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env[PROTOCOL_ENV];
  if (fromEnv === 'json') return 'json';
  if (fromEnv !== undefined && fromEnv !== '' && fromEnv !== 'protobuf') {
    diag.warn(
      `@balsats/otlp: OTEL_EXPORTER_OTLP_PROTOCOL="${fromEnv}" is not supported (protobuf | json); falling back to protobuf`,
    );
  }
  return 'protobuf';
}

/**
 * The span resource every synthesized span carries: `service.name` defaults to `balsa`, env
 * (`OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`) overrides the default, explicit options
 * override env — `resourceAttributes` wholly over `serviceName`. No `telemetry.sdk.*`: this
 * package does not run the OTel SDK and does not claim it.
 */
function buildResource(options: OtlpExporterOptions): Resource {
  const envResource = detectResources({ detectors: [envDetector] });
  const explicit: Attributes = {};
  if (options.serviceName !== undefined) explicit['service.name'] = options.serviceName;
  if (options.resourceAttributes !== undefined) {
    Object.assign(explicit, options.resourceAttributes);
  }
  return resourceFromAttributes({ 'service.name': 'balsa' })
    .merge(envResource)
    .merge(resourceFromAttributes(explicit));
}

/**
 * Creates the OTLP exporter: an `ObservabilityExporter` feeding the official exporter stack.
 * `flush()` is the batch processor's `forceFlush()`, `shutdown()` its `shutdown()` — the tracer
 * forwards both.
 */
export function createOtlpExporter(options: OtlpExporterOptions = {}): ObservabilityExporter {
  const protocol = resolveProtocol(options.protocol);
  const config: ExporterConfig = {
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis }),
    ...(options.compression === undefined
      ? {}
      : {
          compression: options.compression as unknown as NonNullable<ExporterConfig['compression']>,
        }),
  };
  const exporter =
    protocol === 'json' ? new OTLPTraceExporterHttp(config) : new OTLPTraceExporterProto(config);
  const resource = buildResource(options);
  const processor = new BatchSpanProcessor({
    exporter,
    ...(options.batch?.maxExportBatchSize === undefined
      ? {}
      : { maxExportBatchSize: options.batch.maxExportBatchSize }),
    ...(options.batch?.scheduledDelayMillis === undefined
      ? {}
      : { scheduledDelayMillis: options.batch.scheduledDelayMillis }),
    ...(options.batch?.maxQueueSize === undefined ? {} : { maxQueueSize: options.batch.maxQueueSize }),
    ...(options.batch?.exportTimeoutMillis === undefined
      ? {}
      : { exportTimeoutMillis: options.batch.exportTimeoutMillis }),
  });

  return {
    export(event): void {
      // OTLP spans are immutable — only the ended snapshot ships; started/updated drop here.
      if (event.kind !== 'span_ended') return;
      try {
        processor.onEnd(toReadableSpan(event.span, resource));
      } catch (error) {
        // A span that cannot be synthesized is dropped silently — telemetry never breaks the traced code.
        diag.warn(`@balsats/otlp: dropping unsynthesizable span: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    flush(): Promise<void> {
      return processor.forceFlush();
    },
    shutdown(): Promise<void> {
      return processor.shutdown();
    },
  };
}
