/**
 * `@balsa/core/agent` — agent core.
 *
 * Five-field surface, dynamic arguments and RequestContext, dual-consumption output object,
 * built-in loop, processors, structured output, and as-tool composition.
 * Spec: `docs/architecture/agent.md`.
 */
export { Agent } from './agent.js';
export { resolveDynamicArgument } from './dynamic.js';
export { StructuredOutputError } from './structured-output.js';
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
  StructuredOutputConfig,
} from './types.js';
