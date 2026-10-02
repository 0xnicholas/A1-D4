/**
 * `@balsats/core/signals` — signals subsystem (Harness 基础层).
 *
 * `createSignals({ agent, memory?, tracer? })`: the thread-directed interaction primitive —
 * sendMessage / queueMessage / sendSignal / subscribeToThread — with the fixed three-sentence
 * semantics: 活跃 = 注入当前 run,空闲 = 唤醒新 run,queueMessage = 排队保序. In-process registry
 * and pubsub only (single-process semantics); injected/woken content lands in message history as
 * ordinary messages through the memory subsystem.
 * Spec: `docs/architecture/harness.md`「Signals」.
 */
export { createSignals } from './signals.js';
export type { SignalPayload, Signals, SignalsConfig } from './signals.js';
