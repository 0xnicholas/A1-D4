import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';

/**
 * The tool definition surface (`docs/architecture/tools.md`): four fields — `description`,
 * optional `inputSchema` / `outputSchema`, and `execute` — nothing beyond it (ADR-0008).
 *
 * Tools carry no id/name: the name of a tool is its key in the Agent's `Record<string, Tool>`
 * container. Schemas are Standard Schema dual interfaces (ADR-0003); `execute`'s input and output
 * types are inferred from them, so a hand-written type annotation normally is not needed for tools
 * built with `createTool`.
 *
 * This is the container-erased view of a tool: input/output are `unknown` unless a caller
 * annotates them (`Tool<{ city: string }>`), and `execute` is declared as a method so that
 * concretely typed tools (schema-derived or annotated) stay assignable into `Record<string, Tool>`
 * without an `any` hole.
 *
 * The real `execute` context — the six-piece `ToolContext` (`signal` / `runId` / `toolCallId` /
 * `requestContext` / `traceId` / `spanId`) — lands with the tool loop (M1-07, #28). Until then
 * the second parameter is a `never` placeholder: tools that do not use it are exactly as they
 * will be.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** What the tool does, shown to the model. */
  readonly description: string;
  /** Input schema (Standard Schema dual interface) — omitted for tools without arguments. */
  readonly inputSchema?: StandardSchema | undefined;
  /** Output schema — when present, the tool result is validated against it. */
  readonly outputSchema?: StandardSchema | undefined;
  /** Runs the tool. */
  execute(input: TInput, ctx: never): TOutput | Promise<TOutput>;
}

/**
 * The four-field config accepted by `createTool`, with the schema type parameters exposed so that
 * `execute`'s input/output types are derived from the schemas. Annotating with bare `ToolConfig`
 * accepts any dual-interface schema and widens the schemas' inferred types to `unknown`.
 */
export interface ToolConfig<
  TInputSchema extends StandardSchema | undefined = StandardSchema | undefined,
  TOutputSchema extends StandardSchema | undefined = StandardSchema | undefined,
> {
  /** What the tool does, shown to the model. */
  readonly description: string;
  /** Input schema — omitted for tools without arguments (`input` is then `undefined`). */
  readonly inputSchema?: TInputSchema;
  /** Output schema — when present, the tool result is validated against it. */
  readonly outputSchema?: TOutputSchema;
  /** Runs the tool with the schema-validated input. */
  execute(
    input: SchemaInput<TInputSchema>,
    ctx: never,
  ): SchemaOutput<TOutputSchema> | Promise<SchemaOutput<TOutputSchema>>;
}

/** The `execute` input type a schema implies; `undefined` when the tool declares no schema. */
type SchemaInput<TSchema> = TSchema extends StandardSchema
  ? StandardSchemaV1.InferInput<TSchema>
  : undefined;

/** The `execute` output type a schema implies; `unknown` when the tool declares no schema. */
type SchemaOutput<TSchema> = TSchema extends StandardSchema
  ? StandardSchemaV1.InferOutput<TSchema>
  : unknown;

/**
 * Defines a tool — a factory for typing only, returning a frozen plain object. Hand-written
 * literals are equally valid (`docs/architecture/tools.md`), but only the factory infers
 * `execute`'s input/output from the schemas: with it, an object literal in `inputSchema`
 * determines the type of `input`.
 *
 * A tool without `inputSchema` gets `input: undefined`; a tool without `outputSchema` may return
 * anything.
 */
export function createTool<
  TInputSchema extends StandardSchema | undefined = undefined,
  TOutputSchema extends StandardSchema | undefined = undefined,
>(
  config: ToolConfig<TInputSchema, TOutputSchema>,
): Tool<SchemaInput<TInputSchema>, SchemaOutput<TOutputSchema>> {
  // Omitted schemas stay absent: an omitted `inputSchema` is what marks a tool as argument-less,
  // and the provider tool list turns that into an empty object schema.
  return Object.freeze({
    description: config.description,
    ...(config.inputSchema === undefined ? {} : { inputSchema: config.inputSchema }),
    ...(config.outputSchema === undefined ? {} : { outputSchema: config.outputSchema }),
    execute: config.execute,
  });
}
