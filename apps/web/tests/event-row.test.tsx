import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventRow, messageCountOf } from '../src/domains/chat/EventRow';
import type { RunEvent } from '../src/gateway/types';

function llmEvent(data: Record<string, unknown>): RunEvent {
  return { type: 'llm.request', run_id: 'run-1', ts: 1_000, data };
}

describe('EventRow llm.request message count (0.18)', () => {
  test('uses message_count when the server already summarized the request', () => {
    const markup = renderToStaticMarkup(<EventRow event={llmEvent({ message_count: 7 })} />);
    expect(markup).toContain('7 msgs');
  });

  test('falls back to messages.length when the full payload is present', () => {
    const markup = renderToStaticMarkup(
      <EventRow event={llmEvent({ messages: [{ role: 'user' }, {}, {}] })} />,
    );
    expect(markup).toContain('3 msgs');
  });

  test('never renders "0 msgs" when neither field exists', () => {
    const markup = renderToStaticMarkup(<EventRow event={llmEvent({ tools: [{}, {}] })} />);
    expect(markup).toContain('2 tools');
    expect(markup).not.toContain('msgs');
    expect(markup).not.toContain('0 msgs');
  });

  test('prefers message_count over messages', () => {
    expect(messageCountOf({ message_count: 7, messages: [{}, {}] })).toBe(7);
    expect(messageCountOf({ messages: [{}, {}, {}] })).toBe(3);
    expect(messageCountOf({})).toBeNull();
  });
});
