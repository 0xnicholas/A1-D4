import type { ExportedSpan, MemoryExporter, TracingEvent } from '@balsa/core/observability';

/**
 * 测试共享的 span 读取工具:事件序列与 span 快照的断言在多个测试文件里用同一形状(memory
 * exporter 是规范钦定的断言抓手,见 issue #21 测试决策),从同一份实现取用,不各自复制(规则见
 * `helpers/assertions.ts`)。
 */

/** 16-hex span id(OTel 兼容)。 */
export const SPAN_ID = /^[0-9a-f]{16}$/;

/** 32-hex trace id(OTel 兼容)。 */
export const TRACE_ID = /^[0-9a-f]{32}$/;

/** 事件的 kind 序列,断言三事件时序时用。 */
export function kinds(events: readonly TracingEvent[]): string[] {
  return events.map((event) => event.kind);
}

/** memory exporter 中某个 span 类型的事件序列(断言范围内该类型只有一个 span 时)。 */
export function eventsOfType(memory: MemoryExporter, type: string): TracingEvent[] {
  return memory.events.filter((event) => event.span.type === type);
}

/** memory exporter 中某类型的唯一 span 最新快照;一个都没有时直接失败,不交还 undefined。 */
export function spanOfType(memory: MemoryExporter, type: string): ExportedSpan {
  const span = memory.spans().find((candidate) => candidate.type === type);
  if (span === undefined) throw new Error(`no span of type '${type}' was exported`);
  return span;
}
