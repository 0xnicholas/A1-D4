import type { ModelMessage } from '../model/contract.js';
import type { StandardSchema } from '../standard-schema.js';
import type { Tool } from '../tools/index.js';
import type { Memory } from './memory.js';

/**
 * Working memory (spec: `docs/architecture/memory.md`「工作记忆(可选,resource 作用域)」): one small
 * block of structured data per resource — a user profile, preferences, current goals — that persists
 * across conversations and is updated by the model through a tool call.
 *
 * This module is working memory's semantic home: the merge rules (`mergeWorkingMemory`), the
 * framework-attached `updateWorkingMemory` tool, and the run-facing composition
 * (`loadRunWorkingMemory`). The value itself lives in the resource record and is read/written by
 * `Memory` through the store port's conditional pair (`getResource` / `saveResource`).
 *
 * Internal seam of the memory subsystem: the entry (`memory/index.ts`) exports `Memory` and the
 * store port; the Agent reaches the run-facing composition here directly, the same way it reaches
 * `tools/to-model-tools.ts`.
 */

/** The update tool's name — its key in the agent's tool container. */
const UPDATE_WORKING_MEMORY_TOOL_NAME = 'updateWorkingMemory';

/**
 * The working-memory wiring of one run — the agent integration seam: the system message the run
 * injects and the tool container entries it gains. Absent = the run does no working-memory I/O
 * (no per-call memory identity, or the memory instance does not enable working memory).
 */
export interface RunWorkingMemory {
  /**
   * The system message injected right after the instructions (never merged into them), carrying the
   * resource's current working memory as JSON. Absent while nothing is remembered yet — an empty
   * working memory is not injected as an empty message.
   */
  readonly message?: ModelMessage | undefined;
  /** What the run's tool container gains, keyed by tool name. */
  readonly tools: Record<string, Tool>;
}

/**
 * Loads the working-memory wiring of a run: the resource's current value (as the message to
 * inject) plus the update tool. `undefined` when the memory instance has working memory disabled.
 * Loaded once per run, before the input processors — the injected message is part of the prompt the
 * processor sees and the model receives.
 */
export async function loadRunWorkingMemory(
  memory: Memory,
  resource: string,
): Promise<RunWorkingMemory | undefined> {
  const config = memory.workingMemory;
  if (config === undefined) return undefined;
  const value = await memory.getWorkingMemory(resource);
  return {
    tools: {
      [UPDATE_WORKING_MEMORY_TOOL_NAME]: updateWorkingMemoryTool(memory, resource, config.schema),
    },
    ...(value === undefined ? {} : { message: workingMemoryMessage(value) }),
  };
}

/**
 * The merge semantics of working memory (spec「工作记忆」): patch objects merge deeply into the
 * current value, a `null` field deletes the field, arrays are replaced whole, and every other value
 * is overwritten. A field the patch does not mention — or carries as `undefined` — keeps its value.
 *
 * The merged object is always newly built, so mutating it never mutates the current value. A patch
 * that is not an object (an array, a primitive, `null`) replaces the value wholesale and is then
 * subject to the schema, like any other merge result — such a patch is taken as the value itself,
 * not copied: keeping stored state isolated from callers is the port's contract (adapters deep-copy
 * on write, see `in-memory-store.ts`).
 */
export function mergeWorkingMemory(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...(isPlainObject(current) ? current : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = mergeWorkingMemory(merged[key], value);
  }
  return merged;
}

/**
 * The framework-attached update tool (spec「更新只走 tool-call」): the model's only write path to
 * working memory. Its arguments are the patch itself (`updateWorkingMemory({ tone: 'terse' })`);
 * its result is the merged, schema-validated value — the model reads back what its patch produced.
 *
 * The configured schema is the tool's input schema, handed to the model *verbatim* (see
 * `updateWorkingMemorySchema`), while validation happens on the merged value inside
 * `Memory.updateWorkingMemory` — a patch is partial by design, so only the merge result can be
 * judged. A failure there throws and becomes the usual error tool result fed back to the model.
 */
function updateWorkingMemoryTool(memory: Memory, resource: string, schema: StandardSchema): Tool {
  return {
    description:
      'Update the working memory: a small JSON record that persists across conversations. Send only ' +
      'the fields to change — objects merge deeply, a field set to null is deleted, arrays are ' +
      'replaced whole.',
    inputSchema: updateWorkingMemorySchema(schema),
    execute: (input) => memory.updateWorkingMemory({ resource, patch: input }),
  };
}

/**
 * The update tool's input schema: the configured schema itself, handed to the model verbatim —
 * schema generation is delegated to the converter, so the JSON Schema the model receives is the
 * converter's own output, untouched (ADR-0003: no adapter, no rewriting; the same passthrough
 * `toModelTools` does for user tools). Only `validate` is replaced by a passthrough.
 *
 * The passthrough is what merge semantics need: the tool's arguments are a *patch*, partial by
 * design, which the configured schema — the shape of the *complete* value — cannot judge. The
 * merged value is validated inside the tool's `execute` instead, where a failure becomes the usual
 * error tool result fed back to the model (the MCP-bridge pattern of
 * `docs/architecture/tools.md`「桥接工具的 schema」).
 */
function updateWorkingMemorySchema(schema: StandardSchema): StandardSchema {
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      ...(standard.types === undefined ? {} : { types: standard.types }),
      validate: (value) => ({ value }),
      jsonSchema: {
        input: (options) => standard.jsonSchema.input(options),
        output: (options) => standard.jsonSchema.output(options),
      },
    },
  };
}

/**
 * The working memory as the model receives it (spec「注入」): a system message of its own, appended
 * after the instructions — the instructions themselves are never rewritten. JSON is the shape the
 * schema describes; the pointer line is what makes the update tool discoverable.
 */
function workingMemoryMessage(value: unknown): ModelMessage {
  return {
    role: 'system',
    content: [
      'Working memory (JSON):',
      JSON.stringify(value) ?? String(value),
      `Update it with the ${UPDATE_WORKING_MEMORY_TOOL_NAME} tool: send only the fields that change.`,
    ].join('\n'),
  };
}

/**
 * A JSON-object value — what deep merge and `null`-deletion apply to. Deliberately prototype-strict:
 * anything else (arrays, primitives, class instances such as `Date`) is a value to replace, not a
 * bag to merge into.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
