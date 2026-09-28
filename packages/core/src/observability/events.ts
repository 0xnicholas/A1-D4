import type { ExportedSpan } from './span.js';

/**
 * The three lifecycle events of the tracing bus (`docs/architecture/observability.md`「事件与导出」).
 * Each carries the span's exported form at the moment of the event.
 */
export type TracingEvent =
  | { readonly kind: 'span_started'; readonly span: ExportedSpan }
  | { readonly kind: 'span_updated'; readonly span: ExportedSpan }
  | { readonly kind: 'span_ended'; readonly span: ExportedSpan };

/**
 * The observability exporter — the minimal surface a tracing destination implements: one event in,
 * optionally flush/shutdown. No `name`, no `init` (constructing the exporter is initializing it).
 *
 * `flush` / `shutdown` live on the exporter because batching transports need them; the tracer
 * forwards both. `export` may be async; a rejected export never breaks the traced code.
 */
export interface ObservabilityExporter {
  /** Sends one tracing event out. */
  export(event: TracingEvent): void | Promise<void>;
  /** Optional: awaits whatever the exporter has buffered. */
  flush?(): Promise<void>;
  /** Optional: flushes and releases the exporter's resources. */
  shutdown?(): Promise<void>;
}

/**
 * The synchronous per-event shaping seam (`docs/architecture/observability.md`): every event passes
 * through the processors in order before it reaches the exporters. A processor rewrites the event
 * in place (or returns a replacement) and returns it, or returns `undefined` to drop the event —
 * a processor that rewrites in place must therefore return the event, not fall through.
 */
export type SpanProcessor = (event: TracingEvent) => TracingEvent | undefined;
