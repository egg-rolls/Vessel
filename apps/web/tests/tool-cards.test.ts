import { describe, expect, test } from 'bun:test';
import {
  type ChatRenderItem,
  foldToolItems,
  type ToolCardView,
} from '../src/domains/chat/tool-cards';
import type { TimelineItem } from '../src/state/events';

function text(value: string, key: string): TimelineItem {
  return { kind: 'text', text: value, key };
}

function toolEvent(
  key: string,
  type: string,
  data: Record<string, unknown>,
  ts: number,
): TimelineItem {
  return { kind: 'event', event: { type, run_id: 'r1', data, ts }, key };
}

function toolCards(items: ChatRenderItem[]): ToolCardView[] {
  return items.filter((item): item is ToolCardView => item.kind === 'tool');
}

describe('foldToolItems', () => {
  test('same-name calls with distinct ids pair by id instead of FIFO', () => {
    const result = foldToolItems([
      text('before', 't1'),
      toolEvent(
        'ev-1',
        'tool.call.started',
        { tool_call_id: 'a', tool_name: 'bash', arguments: { cmd: 'a' } },
        100,
      ),
      toolEvent(
        'ev-2',
        'tool.call.started',
        { tool_call_id: 'b', tool_name: 'bash', arguments: { cmd: 'b' } },
        101,
      ),
      toolEvent(
        'ev-3',
        'tool.call.completed',
        { tool_call_id: 'b', tool_name: 'bash', result: 'B', duration_ms: 20 },
        110,
      ),
      toolEvent(
        'ev-4',
        'tool.call.completed',
        { tool_call_id: 'a', tool_name: 'bash', result: 'A', duration_ms: 10 },
        111,
      ),
      text('after', 't2'),
    ]);

    expect(result.map((item) => item.kind)).toEqual(['text', 'tool', 'tool', 'text']);
    const [first, second] = toolCards(result);
    expect(first).toMatchObject({
      key: 'ev-1',
      callId: 'a',
      status: 'done',
      result: 'A',
      durationMs: 10,
      startedAt: 100,
    });
    expect(second).toMatchObject({
      key: 'ev-2',
      callId: 'b',
      status: 'done',
      result: 'B',
      durationMs: 20,
      startedAt: 101,
    });
  });

  test('failed calls surface error status, message, and duration', () => {
    const result = foldToolItems([
      toolEvent('ev-1', 'tool.call.started', { tool_call_id: 'c1', tool_name: 'bash' }, 100),
      toolEvent(
        'ev-2',
        'tool.call.failed',
        { tool_call_id: 'c1', tool_name: 'bash', error: 'exit 1', duration_ms: 33 },
        120,
      ),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'tool',
      key: 'ev-1',
      status: 'error',
      error: 'exit 1',
      durationMs: 33,
      startedAt: 100,
    });
  });

  test('calls without ids pair FIFO by tool name', () => {
    const result = foldToolItems([
      toolEvent('ev-1', 'tool.call.started', { tool_name: 'read', arguments: { path: 'a' } }, 10),
      toolEvent('ev-2', 'tool.call.started', { tool_name: 'read', arguments: { path: 'b' } }, 20),
      toolEvent(
        'ev-3',
        'tool.call.completed',
        { tool_name: 'read', result: 'first', duration_ms: 1 },
        30,
      ),
      toolEvent(
        'ev-4',
        'tool.call.completed',
        { tool_name: 'read', result: 'second', duration_ms: 2 },
        31,
      ),
    ]);

    const [first, second] = toolCards(result);
    expect(first).toMatchObject({
      key: 'ev-1',
      status: 'done',
      result: 'first',
      durationMs: 1,
      startedAt: 10,
    });
    expect(second).toMatchObject({
      key: 'ev-2',
      status: 'done',
      result: 'second',
      durationMs: 2,
      startedAt: 20,
    });
  });

  test('text and non-tool events keep their positions around tool cards', () => {
    const result = foldToolItems([
      text('one', 't1'),
      toolEvent('ev-1', 'guardrail.triggered', { reason: 'x' }, 5),
      toolEvent('ev-2', 'tool.call.started', { tool_call_id: 'g1', tool_name: 'grep' }, 6),
      text('two', 't2'),
      toolEvent('ev-3', 'error', { error: 'oops' }, 7),
    ]);

    expect(result.map((item) => item.kind)).toEqual(['text', 'event', 'tool', 'text', 'event']);
    expect(result[0]).toEqual({ kind: 'text', text: 'one', key: 't1' });
    expect(result[1]?.kind === 'event' ? result[1].event.type : '').toBe('guardrail.triggered');
    expect(result[2]).toMatchObject({ kind: 'tool', key: 'ev-2', status: 'running' });
    expect(result[3]).toEqual({ kind: 'text', text: 'two', key: 't2' });
    expect(result[4]?.kind === 'event' ? result[4].event.type : '').toBe('error');
  });

  test('an orphan completion renders its own card at the completion timestamp', () => {
    const result = foldToolItems([
      toolEvent(
        'ev-9',
        'tool.call.completed',
        { tool_call_id: 'orphan', tool_name: 'bash', result: 'ok', duration_ms: 5 },
        77,
      ),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'tool',
      key: 'tool-ev-9',
      callId: 'orphan',
      name: 'bash',
      status: 'done',
      result: 'ok',
      durationMs: 5,
      startedAt: 77,
    });
  });
});
