/**
 * The model contract — a minimal structural subset of the AI SDK provider specification
 * (language model interface version `v4`), vendored as pure types.
 *
 * The core keeps zero runtime and zero type dependencies, so any language model instance from an
 * AI SDK provider package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, …)
 * satisfies this contract structurally — no adapter, no registry, no magic strings.
 *
 * A single specification version is supported and locked: models of other generations are rejected
 * at resolution time with an explicit error (see `assertModel`) — never adapted (ADR-0004).
 * Upstream drift is caught in CI by type tests against the real `@ai-sdk/provider` package
 * (`test/model-contract.test.ts`).
 */

/** Any JSON value. */
export type JsonValue = null | string | number | boolean | Readonly<JsonObject> | readonly JsonValue[];

/** Any JSON object. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A JSON value as used inside a JSON Schema (`JSONSchema7Type` in draft-07 tooling).
 *
 * Separate from `JsonValue`: schema values are plain JSON without `undefined` members and with
 * mutable arrays, which is what the provider spec's `JSONSchema7` tool schemas use.
 */
export type JsonSchemaValue =
  | null
  | string
  | number
  | boolean
  | { [key: string]: JsonSchemaValue }
  | JsonSchemaValue[];

/** JSON Schema primitive type names (draft-07). */
export type JsonSchemaTypeName =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * A JSON Schema definition: a schema object or the JSON Schema boolean shorthand.
 *
 * Structurally compatible with the `JSONSchema7` shape that the provider spec uses for tool
 * input schemas, without depending on `@types/json-schema`.
 */
export type JsonSchema = boolean | JsonSchemaObject;

/** A JSON Schema (draft-07) object. */
export type JsonSchemaObject = {
  $id?: string | undefined;
  $ref?: string | undefined;
  $schema?: string | undefined;
  $comment?: string | undefined;
  $defs?: Record<string, JsonSchema> | undefined;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[] | undefined;
  enum?: JsonSchemaValue[] | undefined;
  const?: JsonSchemaValue | undefined;
  multipleOf?: number | undefined;
  maximum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  minimum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  maxLength?: number | undefined;
  minLength?: number | undefined;
  pattern?: string | undefined;
  items?: JsonSchema | JsonSchema[] | undefined;
  additionalItems?: JsonSchema | undefined;
  maxItems?: number | undefined;
  minItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  contains?: JsonSchema | undefined;
  maxProperties?: number | undefined;
  minProperties?: number | undefined;
  required?: string[] | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  patternProperties?: Record<string, JsonSchema> | undefined;
  additionalProperties?: JsonSchema | undefined;
  dependencies?: Record<string, JsonSchema | string[]> | undefined;
  propertyNames?: JsonSchema | undefined;
  if?: JsonSchema | undefined;
  then?: JsonSchema | undefined;
  else?: JsonSchema | undefined;
  allOf?: JsonSchema[] | undefined;
  anyOf?: JsonSchema[] | undefined;
  oneOf?: JsonSchema[] | undefined;
  not?: JsonSchema | undefined;
  format?: string | undefined;
  contentMediaType?: string | undefined;
  contentEncoding?: string | undefined;
  definitions?: Record<string, JsonSchema> | undefined;
  title?: string | undefined;
  description?: string | undefined;
  default?: JsonSchemaValue | undefined;
  readOnly?: boolean | undefined;
  writeOnly?: boolean | undefined;
  examples?: JsonSchemaValue | undefined;
};

/** Provider-specific options sent to the provider, keyed by provider name. */
export type ModelProviderOptions = Record<string, JsonObject>;

/** Provider-specific metadata returned by the provider, keyed by provider name. */
export type ModelProviderMetadata = Record<string, JsonObject>;

/** A mapping of provider names to provider-specific file identifiers. */
export type ModelProviderReference = Record<string, string> & { type?: never };

/** File data as a tagged discriminated union. */
export type ModelFileData =
  | { type: 'data'; data: Uint8Array | string }
  | { type: 'url'; url: URL; originalUrl?: string }
  | { type: 'reference'; reference: ModelProviderReference }
  | { type: 'text'; text: string };

/** Warning reported by the model, e.g. that a setting is unsupported. */
export type ModelWarning =
  | { type: 'unsupported'; feature: string; details?: string }
  | { type: 'compatibility'; feature: string; details?: string }
  | { type: 'deprecated'; setting: string; message: string }
  | { type: 'other'; message: string };

/** Text content part of a prompt message. */
export type ModelTextPart = { type: 'text'; text: string; providerOptions?: ModelProviderOptions };

/** Reasoning content part of a prompt message. */
export type ModelReasoningPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: ModelProviderOptions;
};

/** File produced as part of reasoning, as a content part of a prompt message. */
export type ModelReasoningFilePart = {
  type: 'reasoning-file';
  data: Extract<ModelFileData, { type: 'data' | 'url' }>;
  mediaType: string;
  providerOptions?: ModelProviderOptions;
};

/** Provider-specific content part of a prompt message. */
export type ModelCustomPart = {
  type: 'custom';
  kind: `${string}.${string}`;
  providerOptions?: ModelProviderOptions;
};

/** File content part of a prompt message. */
export type ModelFilePart = {
  type: 'file';
  filename?: string;
  data: ModelFileData;
  mediaType: string;
  providerOptions?: ModelProviderOptions;
};

/** Tool call content part of a prompt message. */
export type ModelToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerExecuted?: boolean;
  providerOptions?: ModelProviderOptions;
};

/** Tool result content part of a prompt message. */
export type ModelToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ModelToolResultOutput;
  providerOptions?: ModelProviderOptions;
};

/** Decision of a user on a provider-executed tool call, as a content part of a prompt message. */
export type ModelToolApprovalResponsePart = {
  type: 'tool-approval-response';
  approvalId: string;
  approved: boolean;
  reason?: string;
  providerOptions?: ModelProviderOptions;
};

/** Result of a tool call, as it is sent back to the provider. */
export type ModelToolResultOutput =
  | { type: 'text'; value: string; providerOptions?: ModelProviderOptions }
  | { type: 'json'; value: JsonValue; providerOptions?: ModelProviderOptions }
  | { type: 'execution-denied'; reason?: string; providerOptions?: ModelProviderOptions }
  | { type: 'error-text'; value: string; providerOptions?: ModelProviderOptions }
  | { type: 'error-json'; value: JsonValue; providerOptions?: ModelProviderOptions }
  | {
      type: 'content';
      value: Array<
        | { type: 'text'; text: string; providerOptions?: ModelProviderOptions }
        | {
            type: 'file';
            data: ModelFileData;
            mediaType: string;
            filename?: string;
            providerOptions?: ModelProviderOptions;
          }
        | { type: 'custom'; providerOptions?: ModelProviderOptions }
      >;
    };

/** A prompt message. */
export type ModelMessage = (
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<ModelTextPart | ModelFilePart> }
  | {
      role: 'assistant';
      content: Array<
        | ModelTextPart
        | ModelFilePart
        | ModelCustomPart
        | ModelReasoningPart
        | ModelReasoningFilePart
        | ModelToolCallPart
        | ModelToolResultPart
      >;
    }
  | { role: 'tool'; content: Array<ModelToolResultPart | ModelToolApprovalResponsePart> }
) & { providerOptions?: ModelProviderOptions };

/** A prompt is a list of messages. */
export type ModelPrompt = ModelMessage[];

/** Text that the model has generated. */
export type ModelTextContent = { type: 'text'; text: string; providerMetadata?: ModelProviderMetadata };

/** Reasoning that the model has generated. */
export type ModelReasoningContent = {
  type: 'reasoning';
  text: string;
  providerMetadata?: ModelProviderMetadata;
};

/** Provider-specific content that the model has generated. */
export type ModelCustomContent = {
  type: 'custom';
  kind: `${string}.${string}`;
  providerMetadata?: ModelProviderMetadata;
};

/** File that the model has generated as part of reasoning. */
export type ModelReasoningFileContent = {
  type: 'reasoning-file';
  mediaType: string;
  data: Extract<ModelFileData, { type: 'data' | 'url' }>;
  providerMetadata?: ModelProviderMetadata;
};

/** File that the model has generated. */
export type ModelFileContent = {
  type: 'file';
  mediaType: string;
  data: Extract<ModelFileData, { type: 'data' | 'url' }>;
  providerMetadata?: ModelProviderMetadata;
};

/** Approval request emitted by a provider for a provider-executed tool call. */
export type ModelToolApprovalRequest = {
  type: 'tool-approval-request';
  approvalId: string;
  toolCallId: string;
  providerMetadata?: ModelProviderMetadata;
};

/** Source that has been used as input to generate the response. */
export type ModelSourceContent =
  | {
      type: 'source';
      sourceType: 'url';
      id: string;
      url: string;
      title?: string;
      providerMetadata?: ModelProviderMetadata;
    }
  | {
      type: 'source';
      sourceType: 'document';
      id: string;
      mediaType: string;
      title: string;
      filename?: string;
      providerMetadata?: ModelProviderMetadata;
    };

/** Tool call that the model has generated (input is stringified JSON). */
export type ModelToolCallContent = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
  dynamic?: boolean;
  providerMetadata?: ModelProviderMetadata;
};

/** Result of a tool call that has been executed by the provider. */
export type ModelToolResultContent = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: NonNullable<JsonValue>;
  isError?: boolean;
  preliminary?: boolean;
  dynamic?: boolean;
  providerMetadata?: ModelProviderMetadata;
};

/** Ordered content that the model has generated. */
export type ModelContent =
  | ModelTextContent
  | ModelReasoningContent
  | ModelCustomContent
  | ModelReasoningFileContent
  | ModelFileContent
  | ModelToolApprovalRequest
  | ModelSourceContent
  | ModelToolCallContent
  | ModelToolResultContent;

/** Why the model finished generating a response: a unified reason plus the provider's raw one. */
export type ModelFinishReason = {
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
  raw: string | undefined;
};

/** Usage information for a language model call. */
export type ModelUsage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
  raw?: JsonObject;
};

/** Response metadata for telemetry and debugging purposes. */
export type ModelResponseMetadata = {
  id?: string;
  timestamp?: Date;
  modelId?: string;
};

/** The result of a `doGenerate` call. */
export type ModelGenerateResult = {
  content: ModelContent[];
  finishReason: ModelFinishReason;
  usage: ModelUsage;
  providerMetadata?: ModelProviderMetadata;
  request?: { body?: unknown };
  response?: ModelResponseMetadata & { headers?: Record<string, string>; body?: unknown };
  warnings: ModelWarning[];
};

/** A tool with a function input schema that is executed by the caller. */
export type ModelFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  inputExamples?: Array<{ input: JsonObject }>;
  strict?: boolean;
  providerOptions?: ModelProviderOptions;
};

/** A provider-defined tool that is configured by the caller. */
export type ModelProviderTool = {
  type: 'provider';
  id: `${string}.${string}`;
  name: string;
  args: Record<string, unknown>;
};

/** How the model should select a tool, if it selects one at all. */
export type ModelToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'tool'; toolName: string };

/** The options of a language model call. */
export type ModelCallOptions = {
  prompt: ModelPrompt;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: JsonSchemaObject; name?: string; description?: string };
  seed?: number;
  tools?: Array<ModelFunctionTool | ModelProviderTool>;
  toolChoice?: ModelToolChoice;
  includeRawChunks?: boolean;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  reasoning?: 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  providerOptions?: ModelProviderOptions;
};

/** One part of the higher-level language model output stream. */
export type ModelStreamPart =
  | { type: 'text-start'; id: string; providerMetadata?: ModelProviderMetadata }
  | { type: 'text-delta'; id: string; delta: string; providerMetadata?: ModelProviderMetadata }
  | { type: 'text-end'; id: string; providerMetadata?: ModelProviderMetadata }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ModelProviderMetadata }
  | {
      type: 'reasoning-delta';
      id: string;
      delta: string;
      providerMetadata?: ModelProviderMetadata;
    }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ModelProviderMetadata }
  | {
      type: 'tool-input-start';
      id: string;
      toolName: string;
      providerMetadata?: ModelProviderMetadata;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    }
  | { type: 'tool-input-delta'; id: string; delta: string; providerMetadata?: ModelProviderMetadata }
  | { type: 'tool-input-end'; id: string; providerMetadata?: ModelProviderMetadata }
  | ModelToolApprovalRequest
  | ModelToolCallContent
  | ModelToolResultContent
  | ModelCustomContent
  | ModelFileContent
  | ModelReasoningFileContent
  | ModelSourceContent
  | { type: 'stream-start'; warnings: ModelWarning[] }
  | ({ type: 'response-metadata' } & ModelResponseMetadata)
  | {
      type: 'finish';
      usage: ModelUsage;
      finishReason: ModelFinishReason;
      providerMetadata?: ModelProviderMetadata;
    }
  | { type: 'raw'; rawValue: unknown }
  | { type: 'error'; error: unknown };

/** The result of a `doStream` call. */
export type ModelStreamResult = {
  stream: ReadableStream<ModelStreamPart>;
  request?: { body?: unknown };
  response?: { headers?: Record<string, string> };
};

/**
 * The model contract: the subset of the AI SDK provider specification that the core consumes.
 *
 * Users pass the language model instance produced by an AI SDK provider package directly; the
 * instance satisfies this contract structurally, without any adapter or registration.
 */
export type Model = {
  /** The language model interface version this model implements (locked: `'v4'`). */
  readonly specificationVersion: 'v4';
  /** Provider ID, e.g. `'openai'`. */
  readonly provider: string;
  /** Provider-specific model ID, e.g. `'gpt-4o'`. */
  readonly modelId: string;
  /** Generates a language model output (non-streaming). */
  doGenerate(options: ModelCallOptions): PromiseLike<ModelGenerateResult>;
  /** Generates a language model output (streaming). */
  doStream(options: ModelCallOptions): PromiseLike<ModelStreamResult>;
};
