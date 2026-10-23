import { describe, expect, it } from 'bun:test';
import { normalizeEvalReport } from '../src/evals';
import { maskAppId, normalizeFeishuStatus } from '../src/feishu';
import { normalizeMetricsSnapshot } from '../src/metrics';

describe('metrics normalization', () => {
  it('fills missing fields with zero', () => {
    expect(normalizeMetricsSnapshot(null)).toEqual({
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
      updated_at: 0,
    });
  });

  it('keeps valid numbers and drops invalid ones', () => {
    const snapshot = normalizeMetricsSnapshot({
      runs: { started: 2, completed: 1, failed: -1, cancelled: 'x' },
      tool_calls: { total: 4, failed: 1 },
      llm: { requests: 3, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      duration_ms: { total: 100, max: 60, avg: 50.5 },
      updated_at: 123,
    });
    expect(snapshot.runs).toEqual({ started: 2, completed: 1, failed: 0, cancelled: 0 });
    expect(snapshot.duration_ms.avg).toBe(50.5);
    expect(snapshot.updated_at).toBe(123);
  });
});

describe('feishu normalization', () => {
  it('masks unmasked app ids', () => {
    expect(maskAppId('cli_abc123')).toBe('cli_***');
    expect(maskAppId('cli_***')).toBe('cli_***');
    expect(maskAppId('')).toBe('');
  });

  it('exposes only frozen fields', () => {
    const status = normalizeFeishuStatus({
      connected: true,
      appIdMasked: 'cli_abc123',
      active_chats: 2,
      queued_messages: 1,
      last_error: 'offline',
      app_secret: 'must-not-leak',
    });
    expect(status).toEqual({
      connected: true,
      appIdMasked: 'cli_***',
      active_chats: 2,
      queued_messages: 1,
      last_error: 'offline',
    });
  });

  it('defaults missing fields safely', () => {
    expect(normalizeFeishuStatus(undefined)).toEqual({
      connected: false,
      appIdMasked: '',
      active_chats: 0,
      queued_messages: 0,
    });
  });
});

describe('eval report normalization', () => {
  it('returns null when suite is missing', () => {
    expect(normalizeEvalReport(null)).toBeNull();
    expect(normalizeEvalReport({})).toBeNull();
    expect(normalizeEvalReport({ suite: '' })).toBeNull();
  });

  it('normalizes cases and drops invalid entries', () => {
    const report = normalizeEvalReport({
      suite: 'smoke',
      network: 1,
      started_at: 10,
      finished_at: 20,
      duration_ms: 10,
      total: 2,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 1,
      cases: [
        {
          id: 'basic',
          status: 'passed',
          duration_ms: 5,
          assertions: [{ type: 'no_error', ok: true }, { type: 'bad' }],
          output: 'hello',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          internal: 'drop',
        },
        { id: 'bad', status: 'unknown' },
      ],
    });
    expect(report).not.toBeNull();
    expect(report?.network).toBe(false);
    expect(report?.cases).toHaveLength(1);
    expect(report?.cases[0]?.assertions).toEqual([{ type: 'no_error', ok: true }]);
    expect(report?.cases[0]?.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });
    const firstCase = report?.cases[0];
    if (!firstCase) throw new Error('expected first case');
    expect((firstCase as unknown as Record<string, unknown>).internal).toBeUndefined();
  });
});
