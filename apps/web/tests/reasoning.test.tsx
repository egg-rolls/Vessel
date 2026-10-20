import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunCard } from '../src/domains/chat/RunCard';
import { buildGroup, type StoredEvent } from '../src/state/events';

function stored(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  ts = 100 + seq,
): StoredEvent {
  return { event: { type, run_id: 'r1', data, ts }, seq };
}

function chunk(seq: number, type: string, delta?: string): StoredEvent {
  return stored(seq, 'llm.stream.chunk', {
    chunk: delta === undefined ? { type } : { type, delta },
  });
}

function render(group: ReturnType<typeof buildGroup>, running = true): string {
  return renderToStaticMarkup(
    <RunCard
      group={{ ...group, status: running ? 'running' : group.status }}
      cancelled={false}
      cancelling={false}
      onCancel={() => {}}
    />,
  );
}

describe('buildGroup reasoning stream', () => {
  test('keeps reasoning separate from assistant text, in order', () => {
    const group = buildGroup('r1', [
      stored(1, 'run.started', { input: 'q', session_id: 's1' }),
      chunk(2, 'reasoning_delta', 'thinking A'),
      chunk(3, 'reasoning_delta', ' + B'),
      chunk(4, 'text_delta', 'final '),
      chunk(5, 'text_delta', 'answer'),
      chunk(6, 'finish'),
      stored(7, 'run.completed', { output: 'final answer' }),
    ]);

    expect(group.items.map((item) => item.kind)).toEqual(['reasoning', 'text']);
    const reasoning = group.items[0];
    const text = group.items[1];
    expect(reasoning?.kind === 'reasoning' ? reasoning.text : '').toBe('thinking A + B');
    expect(text?.kind === 'text' ? text.text : '').toBe('final answer');
  });

  test('renders reasoning-only runs (deepseek-style) without inventing text', () => {
    const group = buildGroup('r1', [
      stored(1, 'run.started', { input: 'q', session_id: 's1' }),
      chunk(2, 'reasoning_delta', 'only thoughts'),
      chunk(3, 'finish'),
      stored(4, 'run.completed', { output: '' }),
    ]);

    expect(group.items).toHaveLength(1);
    expect(group.items[0]?.kind).toBe('reasoning');
  });

  test('produces the same output as before when no reasoning chunk arrives', () => {
    const group = buildGroup('r1', [
      stored(1, 'run.started', { input: 'q', session_id: 's1' }),
      chunk(2, 'text_delta', 'hello'),
      chunk(3, 'finish'),
    ]);

    expect(group.items.map((item) => item.kind)).toEqual(['text']);
  });

  test('flushes reasoning before a following tool event', () => {
    const group = buildGroup('r1', [
      chunk(1, 'reasoning_delta', 'plan'),
      stored(2, 'tool.call.started', { tool_name: 'bash' }),
    ]);

    expect(group.items.map((item) => item.kind)).toEqual(['reasoning', 'event']);
  });
});

describe('RunCard reasoning block', () => {
  const group = buildGroup('r1', [
    stored(1, 'run.started', { input: 'q', session_id: 's1' }),
    chunk(2, 'reasoning_delta', 'private reasoning'),
    chunk(3, 'text_delta', 'final answer'),
    chunk(4, 'finish'),
  ]);

  test('streams inside a collapsible, visually separated Thinking block', () => {
    const markup = render(group, true);
    expect(markup).toContain('reasoning-block');
    expect(markup).toContain('思考过程');
    expect(markup).toContain('private reasoning');
    expect(markup).toContain('final answer');
    // 流式期间默认展开；思考内容不在正文 Markdown 块里。
    expect(markup).toContain('<details class="reasoning-block" open="">');
    expect(markup.indexOf('private reasoning')).toBeLessThan(markup.indexOf('final answer'));
  });

  test('collapses after the stream ends but keeps the block', () => {
    const completed = buildGroup('r1', [
      stored(1, 'run.started', { input: 'q', session_id: 's1' }),
      chunk(2, 'reasoning_delta', 'private reasoning'),
      chunk(3, 'text_delta', 'final answer'),
      chunk(4, 'finish'),
      stored(5, 'run.completed', { output: 'final answer' }),
    ]);
    const markup = render(completed, false);
    expect(markup).toContain('reasoning-block');
    expect(markup).toContain('private reasoning');
    expect(markup).not.toContain('<details class="reasoning-block" open="">');
  });

  test('does not add a Thinking block when no reasoning chunk exists', () => {
    const plain = buildGroup('r1', [
      stored(1, 'run.started', { input: 'q', session_id: 's1' }),
      chunk(2, 'text_delta', 'plain answer'),
      chunk(3, 'finish'),
    ]);
    const markup = render(plain, true);
    expect(markup).not.toContain('reasoning-block');
    expect(markup).toContain('plain answer');
  });
});
