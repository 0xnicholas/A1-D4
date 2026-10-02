import type { Model } from './contract.js';

/**
 * The AI SDK provider specification version this build of `@balsats/core` supports.
 *
 * A single version is supported and locked: models of other generations are rejected by
 * `assertModel` — never adapted (ADR-0004).
 */
export const MODEL_SPECIFICATION_VERSION: Model['specificationVersion'] = 'v4';

/** Thrown when a value does not implement the model contract. */
export class ModelContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelContractError';
  }
}

/**
 * Thrown when a model implements a different specification version than the core supports.
 *
 * The message points at the actionable side of the mismatch: either the provider package predates
 * this framework build (upgrade the provider package or downgrade the framework), or this
 * framework build predates the provider package (upgrade the framework or downgrade the provider).
 */
export class ModelSpecificationVersionError extends ModelContractError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelSpecificationVersionError';
  }
}

/**
 * Asserts that a value satisfies the model contract and returns it unchanged.
 *
 * Runs at model resolution time — before any execution — so a wrong provider package surfaces as
 * an explicit error instead of failing mid-run. Accepts anything (users pass provider objects
 * whose static type is only known to the provider package) and narrows it to `Model`.
 */
export function assertModel(model: unknown): Model {
  if (typeof model !== 'object' || model === null) {
    throw new ModelContractError(
      `Expected a language model instance, got ${describeValue(model)}. ` +
        'Pass the language model produced by an AI SDK provider package (e.g. @ai-sdk/openai).',
    );
  }

  const candidate = model as {
    specificationVersion?: unknown;
    doGenerate?: unknown;
    doStream?: unknown;
  };

  if (typeof candidate.specificationVersion !== 'string') {
    throw new ModelContractError(
      `Expected a model that implements specification version '${MODEL_SPECIFICATION_VERSION}', ` +
        `got ${describeValue(candidate.specificationVersion)}. Pass the language model produced by an ` +
        'AI SDK provider package (e.g. @ai-sdk/openai).',
    );
  }

  if (candidate.specificationVersion !== MODEL_SPECIFICATION_VERSION) {
    throw new ModelSpecificationVersionError(
      specificationVersionMessage(candidate.specificationVersion),
    );
  }

  if (typeof candidate.doGenerate !== 'function' || typeof candidate.doStream !== 'function') {
    throw new ModelContractError(
      `Value declares specification version '${MODEL_SPECIFICATION_VERSION}' but does not implement ` +
        `doGenerate / doStream, so it is not a language model. Pass the language model produced by ` +
        'an AI SDK provider package — not an embedding, image, speech, or other model type.',
    );
  }

  return candidate as Model;
}

function specificationVersionMessage(actual: string): string {
  const expected = MODEL_SPECIFICATION_VERSION;
  const actualGeneration = parseGeneration(actual);
  const expectedGeneration = parseGeneration(expected);
  const unsupported =
    `Unsupported model specification version '${actual}': this build of @balsats/core supports '${expected}'.`;

  if (
    actualGeneration === undefined ||
    expectedGeneration === undefined ||
    actualGeneration === expectedGeneration
  ) {
    return (
      `${unsupported} Upgrade the provider package if it predates this build, or upgrade ` +
      '@balsats/core if this build predates the provider package.'
    );
  }

  if (actualGeneration < expectedGeneration) {
    return (
      `${unsupported} The provider package predates this framework build — upgrade the provider ` +
      `package, or downgrade @balsats/core to a major that supports specification version '${actual}'.`
    );
  }

  return (
    `${unsupported} This framework build predates the provider package — upgrade @balsats/core, or ` +
    `downgrade the provider package to one that implements specification version '${expected}'.`
  );
}

/** Extracts the generation number of a `'v<number>'` specification version. */
function parseGeneration(version: string): number | undefined {
  const match = /^v(\d+)$/.exec(version);
  return match ? Number(match[1]) : undefined;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'function') return 'a function';
  return String(value);
}
