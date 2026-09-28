/**
 * `@balsa/core` — composition root.
 *
 * The thin `createApp` assembly point that hands cross-cutting dependencies (tracer, …) to the
 * subsystems attached to it. Subsystems stay fully usable on their own without it (ADR-0002).
 * Specs: `docs/architecture/`.
 *
 * M1 scaffold entry — exports nothing yet; the composition root lands in M1.
 */
export {};
