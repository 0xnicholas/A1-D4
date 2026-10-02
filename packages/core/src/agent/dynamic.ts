import type { DynamicArgument, RequestContext } from './types.js';

/**
 * Resolves one dynamic argument against a request context (the definition surface):
 * a static value comes back unchanged, a resolver receives the context and may answer
 * asynchronously.
 *
 * A run resolves `instructions` / `model` / `tools` through this same primitive, so resolution
 * behaves identically wherever it happens. It is also the seam for readers that live outside a run:
 * as-tool composition reads an agent's dynamic `description` with it, because a Tool's `description`
 * is a plain string fixed when the tool is built (composition patterns).
 *
 * A `T` that is itself a function cannot be passed as a static value — the union reads function
 * values as resolvers. No config field has a function as its static value.
 *
 * @example
 * const description = (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name;
 */
export function resolveDynamicArgument<T>(
  argument: DynamicArgument<T>,
  ctx: RequestContext,
): Promise<T>;
export function resolveDynamicArgument<T>(
  argument: DynamicArgument<T> | undefined,
  ctx: RequestContext,
): Promise<T | undefined>;
export async function resolveDynamicArgument<T>(
  argument: DynamicArgument<T> | undefined,
  ctx: RequestContext,
): Promise<T | undefined> {
  if (typeof argument !== 'function') return argument;
  // The union reads every function value as a resolver (see above).
  return (argument as (ctx: RequestContext) => T | Promise<T>)(ctx);
}
