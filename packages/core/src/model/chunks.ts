/**
 * The chunk protocol — the core's own streaming vocabulary.
 *
 * `stream()` output, processors, workflow step snapshots and observability all share this minimal
 * set of events. The core never surfaces the AI SDK stream format: model-native streams are
 * normalized into chunks by `normalizeStream`, and conversions to external formats live in
 * interoperability capability packages (ADR-0004).
 */

/**
 * Why a model step finished.
 *
 * `'tool-calls'` is also the terminal reason when the agent loop hits its step cap while the model
 * still asks for tools; `'suspended'` only occurs inside durable wrappers.
 */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'error' | 'suspended';

/** Token usage of a model step (or accumulated over a run). */
export type Usage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
};

/** A piece of text that the model has generated. */
export type TextDeltaChunk = {
  type: 'text-delta';
  textDelta: string;
};

/** A tool call that the model has requested, with its input parsed from stringified JSON. */
export type ToolCallChunk = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** The result of a tool call (framework-executed or provider-executed). */
export type ToolResultChunk = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
};

/** The end of a model step. */
export type FinishChunk = {
  type: 'finish';
  finishReason: FinishReason;
  usage: Usage;
};

/** One chunk of the core's streaming protocol. */
export type Chunk = TextDeltaChunk | ToolCallChunk | ToolResultChunk | FinishChunk;
