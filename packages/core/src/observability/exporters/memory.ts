import type { ObservabilityExporter, TracingEvent } from '../events.js';
import type { ExportedSpan } from '../span.js';

/** Options of the memory exporter. */
export interface MemoryExporterOptions {
  /** How many events the ring keeps; older ones are evicted. Default 1000. */
  capacity?: number;
}

/**
 * The memory exporter: keeps the tracing events in a bounded ring buffer, for tests and in-process
 * assertions (the exporter inventory). It is the specified assertion
 * surface for the observability kernel — tests assert event order, span trees and lifetimes here.
 */
export interface MemoryExporter extends ObservabilityExporter {
  /** The retained events, oldest first. */
  readonly events: readonly TracingEvent[];
  /**
   * The latest snapshot of every retained span, in first-seen order. A span that appears in several
   * events (started → updated → ended) is one entry carrying its newest state.
   */
  spans(): readonly ExportedSpan[];
  /** Drops everything recorded so far. */
  clear(): void;
}

/**
 * Creates the memory exporter (the exporter inventory): a ring buffer
 * with `capacity` slots (default 1000). Once full, each new event evicts the oldest.
 */
export function memoryExporter(options: MemoryExporterOptions = {}): MemoryExporter {
  const capacity = options.capacity ?? 1000;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`memory exporter capacity must be a positive integer, got ${String(capacity)}.`);
  }

  // A real ring: a fixed array plus the index of the oldest slot and the current size.
  let buffer: Array<TracingEvent | undefined> = new Array<TracingEvent | undefined>(capacity);
  let start = 0;
  let size = 0;

  function push(event: TracingEvent): void {
    if (size < capacity) {
      buffer[(start + size) % capacity] = event;
      size += 1;
      return;
    }
    buffer[start] = event;
    start = (start + 1) % capacity;
  }

  function toArray(): TracingEvent[] {
    const events: TracingEvent[] = [];
    for (let index = 0; index < size; index += 1) {
      const event = buffer[(start + index) % capacity];
      // Holes cannot exist by construction; the check keeps the read total under noUncheckedIndexedAccess.
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  return {
    get events(): readonly TracingEvent[] {
      return toArray();
    },
    export(event: TracingEvent): void {
      push(event);
    },
    spans(): readonly ExportedSpan[] {
      // First-seen order (insertion order of the Map), newest snapshot per span id.
      const byId = new Map<string, ExportedSpan>();
      for (const event of toArray()) byId.set(event.span.id, event.span);
      return [...byId.values()];
    },
    clear(): void {
      buffer = new Array<TracingEvent | undefined>(capacity);
      start = 0;
      size = 0;
    },
  };
}
