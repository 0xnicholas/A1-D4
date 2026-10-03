/**
 * The step-boundary seam's helpers (`AgentStepBoundary`, `types.ts`). Internal seam, not part of
 * the entry's public surface. Consumers: the harness wrappers composing a caller's `stepBoundary`
 * (`durable-agent`, `signals`).
 */

/**
 * The passthrough of an absent-able boundary hook, as the spread fragment for one phase: absent
 * stays absent — no no-op function is installed, the loop's zero-overhead guarantee keys off
 * presence — and present is forwarded. The one narrowing fact lives here: the closure captures
 * the hook itself, so the call site needs no re-check, no assertion and no re-derived event type.
 */
export function passThrough<K extends string, E, R>(
  key: K,
  hook: ((event: E) => R) | undefined,
): { readonly [P in K]?: (event: E) => R } {
  return hook === undefined
    ? {}
    : ({ [key]: (event: E) => hook(event) } as { readonly [P in K]?: (event: E) => R });
}
