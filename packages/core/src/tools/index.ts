/**
 * `@balsats/core/tools` — tools.
 *
 * The four-field `createTool` plain object (schema-derived input/output types, frozen), the
 * `Record<string, Tool>` container whose keys are the tool names, the six-piece `ToolContext`
 * every `execute` receives, and the Standard Schema dual interface the four fields speak
 * (ADR-0003). The Agent turns the container into the provider tool list and normalizes tool
 * failures (input validation / throw / output validation) into error results fed back to the
 * model.
 */
export { createTool } from './tool.js';
export type { SchemaInput, SchemaOutput, Tool, ToolConfig, ToolContext } from './tool.js';
export type {
  StandardJSONSchemaV1,
  StandardSchema,
  StandardSchemaV1,
  StandardTypedV1,
} from '../standard-schema.js';
