/**
 * `@balsa/core/agent` — agent core.
 *
 * Five-field surface, dynamic arguments and RequestContext, dual-consumption output object,
 * built-in loop, processors, and as-tool composition.
 * Spec: `docs/architecture/agent.md`.
 */
export { Agent } from './agent.js';
export { resolveDynamicArgument } from './dynamic.js';
export type {
  ProcessErrorArgs,
  ProcessErrorResult,
  ProcessInputArgs,
  ProcessInputResult,
  ProcessOutputStepArgs,
  ProcessOutputStepResult,
  Processor,
} from './processors.js';
export type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
  AgentStep,
  AgentStreamResult,
  DynamicArgument,
  ModelInput,
  ModelSettings,
  RequestContext,
} from './types.js';
