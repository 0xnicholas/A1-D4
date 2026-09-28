/**
 * `@balsa/core/tools` — tools.
 *
 * The four-field `createTool` plain object, the Record container, and the three-line error
 * normalization that feeds failures back to the model.
 * Spec: `docs/architecture/tools.md`.
 */

/**
 * A tool — the four-field plain object from `docs/architecture/tools.md`: `description`,
 * optional `inputSchema` / `outputSchema`, and `execute`.
 *
 * The Agent's tool container is `Record<string, Tool>`; the name of a tool is its key, tools
 * carry no id/name of their own. Schema-driven typing (Standard Schema dual interface → inferred
 * input/output) and the `createTool` factory land with M1-06 (#27); the six-piece `ToolContext`
 * for `execute`'s second parameter lands with the tool loop (M1-07, #28). This ticket only needs
 * the structural shape the five-field Agent surface accepts, so the fields stay permissively
 * typed until then.
 */
export interface Tool {
  /** What the tool does, shown to the model. */
  readonly description: string;
  /** Input schema (Standard Schema dual interface) — omitted for tools without arguments. */
  readonly inputSchema?: unknown;
  /** Output schema — when present, the tool result is validated against it. */
  readonly outputSchema?: unknown;
  /**
   * Runs the tool. The `never` placeholders keep every concrete `execute` (any parameters, any
   * return) assignable into the container without an `any` hole; `unknown` would reject typed
   * tools (parameter contravariance). The real signature — schema-derived input plus the
   * six-piece `ToolContext` — lands with M1-06/M1-07 (#27/#28).
   */
  readonly execute: (input: never, ctx: never) => unknown;
}
