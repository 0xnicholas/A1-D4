/**
 * `@oribos/core/signals` — signals subsystem (the harness base layer).
 *
 * `createSignals({ agent, memory?, tracer? })`: the thread-directed interaction primitive —
 * sendMessage / queueMessage / sendSignal / subscribeToThread — with the fixed three rules:
 * active = injected into the current run, idle = a new run wakes, `queueMessage` = queued in
 * arrival order. In-process registry and pubsub only (single-process semantics); injected/woken
 * content lands in message history as ordinary messages through the memory subsystem.
 */
export { createSignals } from './signals.js';
export type { SignalPayload, Signals, SignalsConfig } from './signals.js';
