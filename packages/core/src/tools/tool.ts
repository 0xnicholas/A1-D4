import type { RequestContext } from '../agent/types.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';

/**
 * The context a tool's `execute` receives (`docs/architecture/tools.md`「执行上下文」): the
 * six pieces the framework guarantees inside an agent loop. The model-generated `input` and the
 * framework-provided `ctx` are two separate parameters on purpose — no in-bag mixing (unlike the
 * workflow `StepContext`).
 *
 * - `signal` / `runId`: cancellation and correlation, propagated from the run.
 * - `toolCallId`: the provider's real id — the idempotency key (a retried call carries the same id).
 * - `requestContext`: the user's per-call open bag, framework-written `signal` / `runId` included.
 * - `traceId` / `spanId`: for as-tool composition; empty strings when no tracer is attached
 *   (observability auto-instrumentation, M1-09).
 *
 * Manual direct calls (workflow wrappers, ad-hoc code) provide the same shape themselves; inside
 * the agent loop the framework guarantees all six.
 */
export interface ToolContext {
  /** Cancellation, propagated from the run down to the tool. */
  readonly signal: AbortSignal;
  /** Identity of the run this call belongs to. */
  readonly runId: string;
  /** The provider-generated tool call id — the idempotency key for side effects. */
  readonly toolCallId: string;
  /** The user's per-call request context (framework-written `signal` / `runId` included). */
  readonly requestContext: RequestContext;
  /** Trace id of the current run; empty string when no tracer is attached. */
  readonly traceId: string;
  /** Span id of the current tool-call span; empty string when no tracer is attached. */
  readonly spanId: string;
}

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
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** What the tool does, shown to the model. */
  readonly description: string;
  /** Input schema (Standard Schema dual interface) — omitted for tools without arguments. */
  readonly inputSchema?: StandardSchema | undefined;
  /** Output schema — when present, the tool result is validated against it. */
  readonly outputSchema?: StandardSchema | undefined;
  /** Runs the tool with the schema-validated input and the framework context. */
  execute(input: TInput, ctx: ToolContext): TOutput | Promise<TOutput>;
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
    ctx: ToolContext,
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
