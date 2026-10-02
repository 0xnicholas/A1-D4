import type { ObservabilityExporter, TracingEvent } from '../events.js';

/** Options of the console exporter. */
export interface ConsoleExporterOptions {
  /** Where the formatted lines go; defaults to `console`. */
  logger?: Pick<Console, 'log'>;
}

/**
 * The console exporter (the exporter inventory): pretty-prints every
 * event for development debugging — one header line per event (kind, type, name, ids, duration,
 * error flag) plus indented detail lines for input / output / attributes / metadata / error.
 */
export function consoleExporter(options: ConsoleExporterOptions = {}): ObservabilityExporter {
  const logger = options.logger ?? console;
  return {
    export(event: TracingEvent): void {
      for (const line of formatEvent(event)) logger.log(line);
    },
  };
}

/** The lines one event prints as. */
function formatEvent(event: TracingEvent): string[] {
  const span = event.span;
  const header = [
    `[balsa] ${event.kind}`,
    `${span.type} "${span.name}"`,
    `id=${span.id}`,
    `trace=${span.traceId}`,
  ];
  if (span.parentSpanId !== undefined) header.push(`parent=${span.parentSpanId}`);
  if (span.isEvent === true) header.push('event');
  if (span.endTime !== undefined) {
    header.push(`duration=${span.endTime.getTime() - span.startTime.getTime()}ms`);
  }

  const lines = [header.join(' ')];
  const details: Array<readonly [string, unknown]> = [
    ['input', span.input],
    ['output', span.output],
    ['attributes', span.attributes],
    ['metadata', span.metadata],
  ];
  for (const [label, value] of details) {
    if (value !== undefined) lines.push(`  ${label}: ${formatValue(value)}`);
  }
  if (span.error !== undefined) lines.push(`  error: ${span.error.message}`);
  return lines;
}

/** Pretty JSON; values JSON cannot express (functions, …) fall back to their string form. */
function formatValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return String(value);
  return json.replaceAll('\n', '\n    ');
}
