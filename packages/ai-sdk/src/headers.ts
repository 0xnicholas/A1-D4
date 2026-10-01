/**
 * The official UI message stream response headers (`x-vercel-ai-ui-message-stream: v1` and its
 * four companions), as required of any custom backend producing this stream. The equality of this
 * constant with the real `ai` package's `UI_MESSAGE_STREAM_HEADERS` is asserted in CI
 * (`test/cross-check.test.ts`); the client itself does not validate the header — gateways might.
 */

/** The five response headers every UI message stream response carries. */
export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;
