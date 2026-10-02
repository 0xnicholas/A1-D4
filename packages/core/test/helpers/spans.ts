import { vi } from 'vitest';
import type { ExportedSpan, MemoryExporter, TracingEvent } from '@balsats/core/observability';

/**
 * 测试共享的 span 读取工具与零开销探针:事件序列、span 快照与「未创建 span 对象」的断言在多个
 * 测试文件里用同一形状(memory exporter 是规范钦定的断言抓手,见 issue #21 测试决策),从同一份
 * 实现取用,不各自复制(规则见 `helpers/assertions.ts`)。
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

/**
 * 零开销探针:跑 `run` 并报告期间是否生成过 span / trace id。span id(16-hex)与 trace id
 * (32-hex)都由 `crypto.getRandomValues` 生成(runId 走 randomUUID,不受影响),所以「是否创建了
 * span 对象」的可观察边界就是它:不挂 tracer 时一次都不应被碰到,挂上后必定被碰到(正对照)。
 * 探针在返回前卸载(restore 会清掉录制的调用),故这里只报告事实,断言留给调用方。
 */
export async function withSpanIdProbe<T>(
  run: () => Promise<T>,
): Promise<{ result: T; spanIdsCreated: boolean }> {
  const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');
  try {
    const result = await run();
    return { result, spanIdsCreated: getRandomValues.mock.calls.length > 0 };
  } finally {
    getRandomValues.mockRestore();
  }
}
