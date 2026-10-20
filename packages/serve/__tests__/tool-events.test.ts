import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel-agent/core';
import {
  capToolEvent,
  capToolPayload,
  TOOL_EVENT_PAYLOAD_LIMIT,
  TRUNCATED_MARKER,
} from '../src/tool-events';

function event(type: string, data: Record<string, unknown>): RunEvent {
  return { type, run_id: 'run-1', data, ts: 1000 };
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe('capToolPayload', () => {
  it('keeps small values untouched and preserves type', () => {
    const args = { command: 'ls', timeout: 1000 };
    const result = capToolPayload(args);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(args);

    const text = capToolPayload('ok');
    expect(text.truncated).toBe(false);
    expect(text.value).toBe('ok');
  });

  it('truncates oversized strings to <= 8 KiB including the marker', () => {
    const long = 'x'.repeat(TOOL_EVENT_PAYLOAD_LIMIT * 2);
    const result = capToolPayload(long);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    const value = result.value as string;
    expect(value.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(byteLength(value)).toBeLessThanOrEqual(TOOL_EVENT_PAYLOAD_LIMIT);
    expect(result.bytes).toBeGreaterThan(TOOL_EVENT_PAYLOAD_LIMIT);
  });

  it('folds oversized objects into a truncated preview', () => {
    const big = { content: 'y'.repeat(TOOL_EVENT_PAYLOAD_LIMIT * 2) };
    const result = capToolPayload(big);
    expect(result.truncated).toBe(true);
    const folded = result.value as { truncated: boolean; preview: string };
    expect(folded.truncated).toBe(true);
    expect(typeof folded.preview).toBe('string');
    const preview = folded.preview;
    expect(preview.endsWith(TRUNCATED_MARKER)).toBe(true);
  });

  it('handles multi-byte UTF-8 without exceeding the limit', () => {
    const long = '汉'.repeat(TOOL_EVENT_PAYLOAD_LIMIT);
    const result = capToolPayload(long);
    expect(result.truncated).toBe(true);
    expect(byteLength(result.value as string)).toBeLessThanOrEqual(TOOL_EVENT_PAYLOAD_LIMIT);
  });
});

describe('capToolEvent', () => {
  it('adds an args alias to tool.call.started', () => {
    const input = event('tool.call.started', {
      tool_name: 'bash',
      tool_call_id: 'call-1',
      arguments: { command: 'ls' },
    });
    const output = capToolEvent(input);
    const data = output.data as Record<string, unknown>;
    expect(data.arguments).toEqual({ command: 'ls' });
    expect(data.args).toEqual({ command: 'ls' });
    expect(data.truncated).toBeUndefined();
  });

  it('keeps result on tool.call.completed', () => {
    const input = event('tool.call.completed', {
      tool_name: 'bash',
      tool_call_id: 'call-1',
      result: 'done',
      duration_ms: 12,
    });
    const output = capToolEvent(input);
    expect((output.data as Record<string, unknown>).result).toBe('done');
  });

  it('marks truncated payloads on data', () => {
    const big = 'z'.repeat(TOOL_EVENT_PAYLOAD_LIMIT + 10);
    const started = capToolEvent(
      event('tool.call.started', { tool_name: 'bash', arguments: { content: big } }),
    );
    const startedData = started.data as Record<string, unknown>;
    expect(startedData.truncated).toBe(true);
    expect(startedData.truncated_bytes).toBeGreaterThan(TOOL_EVENT_PAYLOAD_LIMIT);

    const completed = capToolEvent(
      event('tool.call.completed', { tool_name: 'bash', result: big }),
    );
    const completedData = completed.data as Record<string, unknown>;
    expect(completedData.truncated).toBe(true);
    expect((completedData.result as string).endsWith(TRUNCATED_MARKER)).toBe(true);
  });

  it('passes through unrelated events unchanged', () => {
    const input = event('llm.response', { finish_reason: 'stop' });
    expect(capToolEvent(input)).toBe(input);
  });
});
