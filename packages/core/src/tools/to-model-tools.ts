import type { JsonSchemaObject, ModelFunctionTool } from '../model/contract.js';
import { toJsonSchema } from '../standard-schema-runtime.js';
import type { Tool } from './tool.js';

/**
 * Turns the Agent's tool container into the tool list the model receives: one provider function
 * tool per `Record` entry, its key being the tool name.
 *
 * `inputSchema` is asked for JSON Schema through the Standard JSON Schema interface — the
 * draft-07 target, matching the model contract's tool schema subset — and passed through
 * unchanged (ADR-0003: no adapter, no rewriting). A tool without `inputSchema` is argument-less
 * and gets the empty object schema instead; the framework never sends a tool without `parameters`.
 *
 * Internal seam: the Agent builds its call options with it, tests assert the result through the
 * fake model. Not part of the tools entry's public surface.
 */
export function toModelTools(tools: Record<string, Tool>): ModelFunctionTool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    name,
    description: tool.description,
    inputSchema: toInputSchema(tool),
  }));
}

/**
 * The JSON Schema for one tool. The converter's `Record<string, unknown>` result is cast to the
 * contract's `JsonSchemaObject` without a shape check: emitting valid draft-07 is the vendor's
 * contract, and the core neither rewrites nor re-validates schemas — passthrough is the design
 * (ADR-0003), not an oversight. An invalid schema reaches the provider as-is and fails there.
 */
function toInputSchema(tool: Tool): JsonSchemaObject {
  if (tool.inputSchema === undefined) {
    // An argument-less tool still declares the shape the model must produce.
    return { type: 'object', properties: {} };
  }
  return toJsonSchema(tool.inputSchema);
}
