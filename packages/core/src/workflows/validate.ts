import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import { formatIssues, validateSchema } from '../standard-schema-runtime.js';
import type { Step } from './step.js';

/**
 * The engine's IO validation: the fixed boundaries
 * every run passes — the start input (`inputData` against the workflow's `inputSchema`), every
 * step's input (the upstream value against that step's `inputSchema`) and a resume's `resumeData`
 * (against the suspended step's `resumeSchema`). There is no validation switch: always on.
 *
 * The schema's validated value replaces the raw data everywhere it is used, so schema defaults and
 * transforms take effect; a rejected boundary fails with `WorkflowValidationError`, carrying the
 * schema's issues and — for a step boundary or a resume — the step id.
 */
export class WorkflowValidationError extends Error {
  /**
   * The step whose input schema rejected the value; `undefined` at the start boundary.
   */
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

/**
 * Validates a resume's `resumeData` against the suspended step's `resumeSchema` and returns the
 * schema's value — the third fixed IO boundary (IO validation), so its
 * defaults and transforms take effect exactly like the other two. The step's id rides the error.
 *
 * A step that declares no `resumeSchema` has no data to validate: a resume must not carry any (the
 * step's `resumeData` is typed `undefined` — silently dropping data it cannot read would hide a
 * caller bug). A step with one always validates, even when `resumeData` is absent, so a schema that
 * requires data rejects a bare resume.
 */
export async function validateResumeData(
  workflowId: string,
  step: Step,
  resumeData: unknown,
): Promise<unknown> {
  if (step.resumeSchema === undefined) {
    if (resumeData === undefined) return undefined;
    throw new Error(
      `workflow "${workflowId}": the step "${step.id}" declares no resumeSchema — resume() must not carry resumeData for it`,
    );
  }
  return validate(
    step.resumeSchema,
    resumeData,
    `workflow "${workflowId}": the resumeData of step "${step.id}" does not match its resumeSchema`,
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
