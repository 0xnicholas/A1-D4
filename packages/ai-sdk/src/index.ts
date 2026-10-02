/**
 * `@balsats/ai-sdk` — AI SDK interop capability package.
 *
 * The agent's chunk stream as an AI SDK UI message stream: `toAISdkStream` converts body frames,
 * `createChatRoute` is the web-standard `useChat()` route, `toAISdkMessages` reads thread history
 * back as UI messages. One target generation (`ai@7` vocabulary + the `v1` wire header), zero
 * runtime dependencies, `@balsats/core` as a peer. Spec: `docs/architecture/model.md`
 * 「AI SDK 互操作能力包(M5 设计冻结)」.
 */
export type {
  AISdkFileUIPart,
  AISdkFinishReason,
  AISdkAssistantUIMessage,
  AISdkMessageMetadata,
  AISdkStepStartUIPart,
  AISdkStreamChunk,
  AISdkSuspendedMetadata,
  AISdkTextUIPart,
  AISdkToolUIPart,
  AISdkUIMessage,
  AISdkUserUIMessage,
} from './chunks.js';
export { UI_MESSAGE_STREAM_HEADERS } from './headers.js';
export { toAISdkStream } from './to-ai-sdk-stream.js';
export type { ToAISdkStreamOptions } from './to-ai-sdk-stream.js';
export { toAISdkMessages } from './to-ai-sdk-messages.js';
export { createChatRoute } from './chat-route.js';
export type { ChatRouteAgent, ChatRouteConfig, ChatRouteIdentity } from './chat-route.js';
