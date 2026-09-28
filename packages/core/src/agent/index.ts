/**
 * `@balsa/core/agent` — agent core.
 *
 * Five-field surface, dynamic arguments and RequestContext, dual-consumption output object,
 * built-in loop, processors, and as-tool composition.
 * Spec: `docs/architecture/agent.md`.
 */
export { Agent } from './agent.js';
export type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
  ModelSettings,
} from './types.js';
