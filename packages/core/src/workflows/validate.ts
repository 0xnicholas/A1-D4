import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import { formatIssues, validateSchema } from '../standard-schema-runtime.js';
import type { Step } from './step.js';

/**
 * The engine's IO validation (`docs/architecture/workflows.md`「IO 校验」): the fixed boundaries
 * every run passes — the start input (`inputData` against the workflow's `inputSchema`) and every
 * step's input (the upstream value against that step's `inputSchema`; the resumeData boundary
 * lands with #51). There is no validation switch: always on.
 *
 * The schema's validated value replaces the raw data everywhere it is used, so schema defaults and
 * transforms take effect; a rejected boundary fails with `WorkflowValidationError`, carrying the
 * schema's issues and — for a step boundary — the step id.
 */
export class WorkflowValidationError extends Error {
  /** The step whose input schema rejected the value; `undefined` at the start boundary. */
  readonly stepId: string | undefined;
  /** The issues the boundary's schema reported. */
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(
    message: string,
    details: {
      /** The step whose input schema rejected the value; `undefined` at the start boundary. */
      readonly stepId?: string | undefined;
      /** The issues the boundary's schema reported. */
      readonly issues: readonly StandardSchemaV1.Issue[];
    },
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.stepId = details.stepId;
    this.issues = details.issues;
  }
}

/**
 * Validates a run's start input and returns the schema's value. Rejecting here means the run never
 * starts: no step executes and the run fails with the validation error.
 */
export async function validateRunInput(
  workflowId: string,
  schema: StandardSchema,
  inputData: unknown,
): Promise<unknown> {
  return validate(
    schema,
    inputData,
    `workflow "${workflowId}": the run input does not match the inputSchema`,
  );
}

/**
 * Validates one step's input (the upstream output) and returns the schema's value — what the
 * step's `execute` receives. Rejecting here fails that step, and with it the run.
 */
export async function validateStepInput(
  workflowId: string,
  step: Step,
  inputData: unknown,
): Promise<unknown> {
  return validate(
    step.inputSchema,
    inputData,
    `workflow "${workflowId}": the input of step "${step.id}" does not match its inputSchema`,
    step.id,
  );
}

/** Runs one boundary validation; the schema's issues become the boundary's error verbatim. */
async function validate(
  schema: StandardSchema,
  value: unknown,
  message: string,
  stepId?: string | undefined,
): Promise<unknown> {
  const result = await validateSchema(schema, value);
  if ('issues' in result) {
    throw new WorkflowValidationError(`${message}: ${formatIssues(result.issues)}.`, {
      stepId,
      issues: result.issues,
    });
  }
  return result.value;
}
