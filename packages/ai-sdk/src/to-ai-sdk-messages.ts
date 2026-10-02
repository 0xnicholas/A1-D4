/**
 * `toAISdkMessages` — thread history read back as UI messages
 * (spec: `docs/architecture/model.md`「历史回读:`toAISdkMessages`」).
 *
 * A user message maps to one UI message; the maximal assistant/tool run after it folds into a
 * single assistant UI message — `step-start` parts separate its assistant turns, tool parts carry
 * the dynamic-tool shape, and tool results fold into their matching part by `toolCallId`. The
 * lenient principle governs everything that does not pair up: unmatched results, unknown part
 * types and runs no user message precedes are skipped, never thrown. System messages and working
 * memory are not the route's business.
 */

import type { ModelFilePart, ModelToolResultPart } from '@balsats/core/model';
import type { StoredMessage } from '@balsats/core/memory';
import type {
  AISdkAssistantUIMessage,
  AISdkFileUIPart,
  AISdkStepStartUIPart,
  AISdkTextUIPart,
  AISdkToolUIPart,
  AISdkUIMessage,
  AISdkUserUIMessage,
} from './chunks.js';

/** The part types a folded assistant message (or a user message) consists of. */
type BodyPart = AISdkTextUIPart | AISdkFileUIPart | AISdkStepStartUIPart | AISdkToolUIPart;

/**
 * Converts ascending stored messages into UI messages. Ids are the stored messages' own: a
 * refreshed client therefore re-renders history under ids that differ from the live stream's
 * client-generated assistant id (known divergence, documented on the package).
 */
export function toAISdkMessages(messages: readonly StoredMessage[]): AISdkUIMessage[] {
  const result: AISdkUIMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (message.role === 'user') {
      result.push(userMessage(message));
      i += 1;
      if (i < messages.length && isFoldable(messages[i]!)) {
        const folded = foldRun(messages, i);
        result.push(folded.message);
        i = folded.next;
      }
    } else {
      // system messages, and assistant/tool runs no user message precedes (a truncated recall
      // window) — skipped, not rendered.
      i += 1;
    }
  }
  return result;
}

function isFoldable(
  message: StoredMessage,
): message is Extract<StoredMessage, { role: 'assistant' | 'tool' }> {
  return message.role === 'assistant' || message.role === 'tool';
}

function userMessage(message: Extract<StoredMessage, { role: 'user' }>): AISdkUserUIMessage {
  const parts: (AISdkUserUIMessage['parts'][number])[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'file') {
      const file = fileUIPart(part);
      if (file !== undefined) parts.push(file);
    }
  }
  return { id: message.id, role: 'user', parts };
}

/** A stored file part as a UI file part — Data URL for bytes and text, the URL itself for URLs. */
function fileUIPart(part: ModelFilePart): AISdkFileUIPart | undefined {
  let url: string | undefined;
  if (part.data.type === 'data') {
    url = `data:${part.mediaType};base64,${toBase64(part.data.data)}`;
  } else if (part.data.type === 'url') {
    url = part.data.originalUrl ?? part.data.url.toString();
  } else if (part.data.type === 'text') {
    url = `data:${part.mediaType};base64,${toBase64(part.data.text)}`;
  } else {
    return undefined; // provider references have no renderable counterpart
  }
  return {
    type: 'file',
    url,
    mediaType: part.mediaType,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
  };
}

function toBase64(data: Uint8Array | string): string {
  return Buffer.from(typeof data === 'string' ? data : data).toString('base64');
}

/** One fold in progress: the parts array plus where each tool part sits (for result folding). */
interface FoldState {
  readonly parts: BodyPart[];
  readonly toolParts: Map<string, number>; // toolCallId → index into parts
}

function foldRun(
  messages: readonly StoredMessage[],
  start: number,
): { message: AISdkAssistantUIMessage; next: number } {
  const state: FoldState = { parts: [], toolParts: new Map() };
  const id = messages[start]!.id; // the folded sequence's first message id
  let assistantCount = 0;
  let i = start;
  while (i < messages.length) {
    const next = messages[i]!;
    if (!isFoldable(next)) break;
    if (next.role === 'assistant') {
      assistantCount += 1;
      if (assistantCount >= 2) state.parts.push({ type: 'step-start' });
      for (const part of next.content) {
        if (part.type === 'text') {
          state.parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'file') {
          const file = fileUIPart(part);
          if (file !== undefined) state.parts.push(file);
        } else if (part.type === 'tool-call') {
          state.toolParts.set(part.toolCallId, state.parts.length);
          state.parts.push({
            type: 'dynamic-tool',
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: 'input-available',
            input: part.input,
          });
        } else if (part.type === 'tool-result') {
          applyResult(state, part); // provider-executed, inlined
        }
        // reasoning / custom / reasoning-file: no emitted-subset counterpart — skipped
      }
    } else {
      for (const part of next.content) {
        if (part.type === 'tool-result') applyResult(state, part);
        // tool-approval-response: not part of the emitted subset — skipped
      }
    }
    i += 1;
  }
  return { message: { id, role: 'assistant', parts: state.parts }, next: i };
}

/** Folds one tool result into its matching part; an unmatched result is skipped. */
function applyResult(state: FoldState, result: ModelToolResultPart): void {
  const index = state.toolParts.get(result.toolCallId);
  if (index === undefined) return;
  const tool = state.parts[index]!;
  if (tool.type !== 'dynamic-tool') return;
  const input = tool.input;
  const output = result.output;
  if (output.type === 'text') {
    state.parts[index] = { type: 'dynamic-tool', toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'output-available', input, output: output.value };
  } else if (output.type === 'json') {
    state.parts[index] = { type: 'dynamic-tool', toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'output-available', input, output: output.value };
  } else if (output.type === 'error-text') {
    state.parts[index] = { type: 'dynamic-tool', toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'output-error', input, errorText: output.value };
  } else if (output.type === 'error-json') {
    state.parts[index] = { type: 'dynamic-tool', toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'output-error', input, errorText: jsonStringify(output.value) };
  } else if (output.type === 'execution-denied') {
    state.parts[index] = {
      type: 'dynamic-tool',
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      state: 'output-denied',
      input,
      approval: {
        id: tool.toolCallId,
        approved: false,
        ...(output.reason !== undefined ? { reason: output.reason } : {}),
      },
    };
  } else {
    // content: the text blocks joined; file / custom blocks have no emitted counterpart
    const text = output.value
      .filter((block): block is Extract<(typeof output.value)[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    state.parts[index] = { type: 'dynamic-tool', toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'output-available', input, output: text };
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
