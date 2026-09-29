/**
 * `@balsa/core` — composition root.
 *
 * The thin `createApp` assembly point that hands cross-cutting dependencies (tracer, …) to the
 * subsystems attached to it. Subsystems stay fully usable on their own without it (ADR-0002).
 * Specs: `docs/architecture/`.
 */
export { createApp } from './app.js';
export type { App, AppConfig } from './app.js';
