import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { SeqEvent } from '../src/event-buffer';
import { summarizeBroadcastEvent } from '../src/event-summary';
import { createGatewayEventHub } from '../src/tenant-event-hub';

function dataOf(event: RunEvent | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

function makeHub() {
  const stream = new MemoryEventStream();
  const hub = createGatewayEventHub({ streams: [{ tenantId: 'acme', stream }] });
  const raw: RunEvent[] = [];
  const sequenced: SeqEvent[] = [];
  hub.subscribe((event) => raw.push(event));
  hub.subscribeSequenced((item) => sequenced.push(item));
  return { stream, hub, raw, sequenced };
}

describe('summarizeBroadcastEvent', () => {
  it('summarizes llm.request for sequenced subscribers and replay but not raw', () => {
    const { stream, hub, raw, sequenced } = makeHub();
    const longCjk = '汉'.repeat(260);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: longCjk },
    ];
    const tools = [{ type: 'function', function: { name: 'bash' } }];

    stream.publish({
      type: 'llm.request',
      run_id: 'run-1',
      data: { run_id: 'run-1', session_id: 'sess-1', messages, tools },
      ts: 1,
    });

    // raw fan-in 保留完整 messages。
    const rawData = dataOf(raw[0]);
    expect((rawData.messages as unknown[]).length).toBe(3);
    expect((rawData.messages as Array<{ content: string }>)[2]?.content).toBe(longCjk);

    // sequenced 广播只有摘要。
    const summary = dataOf(sequenced[0]?.event);
    expect('messages' in summary).toBe(false);
    expect(summary.message_count).toBe(3);
    expect(summary.session_id).toBe('sess-1');
    expect(summary.tools).toEqual(tools);
    const last = summary.last_message as { role: string; preview: string };
    expect(last.role).toBe('assistant');
    expect(last.preview).toBe('汉'.repeat(200));
    expect(last.preview.length).toBeLessThanOrEqual(200);

    // 回放同样不带 messages。
    const replayed = dataOf(hub.since(0)[0]?.event);
    expect('messages' in replayed).toBe(false);
    expect(replayed.message_count).toBe(3);
    hub.close();
  });

  it('does not mutate the published event', () => {
    const { stream, hub } = makeHub();
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ];
    const original: RunEvent = { type: 'llm.request', run_id: 'run-2', data: { messages }, ts: 2 };

    stream.publish(original);

    const data = original.data as Record<string, unknown>;
    expect((data.messages as unknown[]).length).toBe(2);
    expect((data.messages as Array<{ content: string }>)[1]?.content).toBe('second');
    expect(original.tenant_id).toBeUndefined();
    hub.close();
  });

  it('summarizes context.changed without leaking the full message', () => {
    const { stream, hub, raw, sequenced } = makeHub();
    const message = { role: 'user', content: 'context text' };

    stream.publish({
      type: 'context.changed',
      run_id: 'run-3',
      data: { run_id: 'run-3', session_id: 'sess-3', message, message_count: 4, token_count: 128 },
      ts: 3,
    });

    expect(dataOf(raw[0]).message).toEqual(message);
    const summary = dataOf(sequenced[0]?.event);
    expect('message' in summary).toBe(false);
    expect(summary.message_count).toBe(4);
    expect(summary.token_count).toBe(128);
    expect(summary.session_id).toBe('sess-3');
    expect(summary.last_message).toEqual({ role: 'user', preview: 'context text' });
    hub.close();
  });

  it('passes non-target events through unchanged', () => {
    const { stream, hub, sequenced } = makeHub();

    stream.publish({
      type: 'llm.response',
      run_id: 'run-4',
      data: { content: 'ok', finish_reason: 'stop' },
      ts: 4,
    });

    expect(dataOf(sequenced[0]?.event)).toEqual({ content: 'ok', finish_reason: 'stop' });
    hub.close();
  });

  it('never leaves a lone high surrogate at the preview cut', () => {
    const content = `${'a'.repeat(199)}\u{1F600}tail`;
    const event: RunEvent = {
      type: 'llm.request',
      run_id: 'run-5',
      data: { messages: [{ role: 'user', content }] },
      ts: 5,
    };

    const preview = (dataOf(summarizeBroadcastEvent(event)).last_message as { preview: string })
      .preview;

    expect(preview).toBe('a'.repeat(199));
    const last = preview.charCodeAt(preview.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('uses tool call names when content is not a string', () => {
    const event: RunEvent = {
      type: 'context.changed',
      run_id: 'run-6',
      data: {
        message: {
          role: 'assistant',
          content: 42,
          tool_calls: [{ function: { name: 'bash' } }, { function: { name: 'read' } }],
        },
      },
      ts: 6,
    };

    expect(dataOf(summarizeBroadcastEvent(event)).last_message).toEqual({
      role: 'assistant',
      preview: '[tool_calls: bash, read]',
    });
  });
});
