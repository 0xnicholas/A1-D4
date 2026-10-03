import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '@oribos/core/model';
import type { StoredMessage } from '@oribos/core/memory';
import { toAISdkMessages } from '@oribos/ai-sdk';

function stored(message: ModelMessage, id: string): StoredMessage {
  return { ...message, id, threadId: 't-1', resourceId: 'r-1', createdAt: new Date(0) };
}

function user(text: string, id: string): StoredMessage {
  return stored({ role: 'user', content: [{ type: 'text', text }] }, id);
}

function assistantText(text: string, id: string): StoredMessage {
  return stored({ role: 'assistant', content: [{ type: 'text', text }] }, id);
}

describe('toAISdkMessages', () => {
  it('maps a user message to one UI message with its text as parts', () => {
    expect(toAISdkMessages([user('Hello', 'm1'), assistantText('Hi there', 'm2')])).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] },
    ]);
  });

  it('carries file parts as Data URLs', () => {
    const bytes = Uint8Array.from([104, 105]); // "hi"
    const message = stored(
      {
        role: 'user',
        content: [
          { type: 'file', data: { type: 'data', data: bytes }, mediaType: 'text/plain', filename: 'note.txt' },
          { type: 'text', text: 'see attached' },
        ],
      },
      'm1',
    );
    expect(toAISdkMessages([message])).toEqual([
      {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'file', url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'note.txt' },
          { type: 'text', text: 'see attached' },
        ],
      },
    ]);
  });

  it('folds a user message plus its assistant/tool sequence into one assistant UI message', () => {
    const input = [
      user('Refund order A-4471 please', 'm1'),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking it up.' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookupOrder', input: { orderId: 'A-4471' } },
          ],
        },
        'm2',
      ),
      stored(
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'lookupOrder',
              output: { type: 'json', value: { total: 129 } },
            },
          ],
        },
        'm3',
      ),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Refunding $129.' },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'issueRefund', input: { amount: 129 } },
          ],
        },
        'm4',
      ),
      stored(
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 'issueRefund',
              output: { type: 'json', value: { refunded: true } },
            },
          ],
        },
        'm5',
      ),
      assistantText('Done — $129 refunded.', 'm6'),
    ];

    expect(toAISdkMessages(input)).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Refund order A-4471 please' }] },
      {
        id: 'm2', // the folded sequence's first message id
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Looking it up.' },
          {
            type: 'dynamic-tool',
            toolName: 'lookupOrder',
            toolCallId: 'c1',
            state: 'output-available',
            input: { orderId: 'A-4471' },
            output: { total: 129 },
          },
          { type: 'step-start' },
          { type: 'text', text: 'Refunding $129.' },
          {
            type: 'dynamic-tool',
            toolName: 'issueRefund',
            toolCallId: 'c2',
            state: 'output-available',
            input: { amount: 129 },
            output: { refunded: true },
          },
          { type: 'step-start' },
          { type: 'text', text: 'Done — $129 refunded.' },
        ],
      },
    ]);
  });

  it('maps result kinds: error-text, error-json, execution-denied, and unmatched results are skipped', () => {
    const input = [
      user('run it', 'm1'),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: null },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'b', input: null },
            { type: 'tool-call', toolCallId: 'c3', toolName: 'c', input: null },
          ],
        },
        'm2',
      ),
      stored(
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'a', output: { type: 'error-text', value: 'kaput' } },
            { type: 'tool-result', toolCallId: 'c2', toolName: 'b', output: { type: 'error-json', value: { code: 9 } } },
            { type: 'tool-result', toolCallId: 'c3', toolName: 'c', output: { type: 'execution-denied', reason: 'policy' } },
            { type: 'tool-result', toolCallId: 'cX', toolName: 'ghost', output: { type: 'text', value: 'no match' } },
          ],
        },
        'm3',
      ),
    ];

    expect(toAISdkMessages(input).slice(1)).toEqual([
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolName: 'a', toolCallId: 'c1', state: 'output-error', input: null, errorText: 'kaput' },
          { type: 'dynamic-tool', toolName: 'b', toolCallId: 'c2', state: 'output-error', input: null, errorText: '{"code":9}' },
          {
            type: 'dynamic-tool',
            toolName: 'c',
            toolCallId: 'c3',
            state: 'output-denied',
            input: null,
            approval: { id: 'c3', approved: false, reason: 'policy' },
          },
        ],
      },
    ]);
  });

  it('folds provider-executed results inlined in assistant messages with the same rules', () => {
    const input = [
      user('weather?', 'm1'),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: 'Oslo' } },
            { type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { type: 'json', value: { celsius: 18 } } },
          ],
        },
        'm2',
      ),
    ];

    expect(toAISdkMessages(input).slice(1)).toEqual([
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'weather',
            toolCallId: 'c1',
            state: 'output-available',
            input: { city: 'Oslo' },
            output: { celsius: 18 },
          },
        ],
      },
    ]);
  });

  it('skips unknown assistant part types and assistant/tool runs that no user message precedes', () => {
    const input = [
      assistantText('orphan from a truncated recall window', 'm0'),
      user('hello', 'm1'),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking…' },
            { type: 'custom', kind: 'x.y' },
            { type: 'text', text: 'answer' },
          ],
        },
        'm2',
      ),
    ];

    expect(toAISdkMessages(input)).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ]);
  });

  it('maps a tool-result with text output to a string output value', () => {
    const input = [
      user('go', 'm1'),
      stored(
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: null }],
        },
        'm2',
      ),
      stored(
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'echo', output: { type: 'text', value: 'pong' } }],
        },
        'm3',
      ),
    ];

    expect(toAISdkMessages(input).slice(1)).toEqual([
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolName: 'echo', toolCallId: 'c1', state: 'output-available', input: null, output: 'pong' },
        ],
      },
    ]);
  });
});
