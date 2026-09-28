/**
 * `@balsa/core/tools` — tools.
 *
 * The four-field `createTool` plain object (schema-derived input/output types, frozen), the
 * `Record<string, Tool>` container whose keys are the tool names, and the Standard Schema dual
 * interface the four fields speak (ADR-0003). The Agent turns the container into the provider tool
 * list; the three-line error normalization that feeds failures back to the model lands with the
 * tool loop (M1-07, #28).
 *
 * Spec: `docs/architecture/tools.md`.
 */
export { createTool } from './tool.js';
export type { Tool, ToolConfig } from './tool.js';
export type {
  StandardJSONSchemaV1,
  StandardSchema,
  StandardSchemaV1,
  StandardTypedV1,
} from '../standard-schema.js';
