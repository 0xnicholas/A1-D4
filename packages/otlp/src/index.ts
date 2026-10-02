/**
 * `@balsats/otlp` — the OTLP exporter capability package.
 *
 * Maps the kernel's tracing events to GenAI semconv-shaped OTLP spans over HTTP (protobuf or
 * JSON) using the official OpenTelemetry exporter stack. Decisions: ADR-0009.
 */
export { createOtlpExporter } from './exporter.js';
export type { OtlpExporterBatchOptions, OtlpExporterOptions } from './exporter.js';
