import { describe, expect, it } from 'bun:test';
import { normalizeEvalReport } from '../src/evals';
import { maskAppId, normalizeFeishuStatus } from '../src/feishu';
import { normalizeMetricsSnapshot } from '../src/metrics';
import {
  dedupeWorkflowSummaries,
  isSafeWorkflowName,
  parseWorkflowLimit,
  parseWorkflowStatus,
  sortWorkflowSummaries,
  toWireWorkflowDetail,
  toWireWorkflowSummary,
  type WorkflowRunSummary,
} from '../src/workflow';

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    workflow_run_id: 'wf_1',
    workflow_name: 'release-check',
    status: 'running',
    step_count: 3,
    completed_steps: 1,
    started_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

describe('workflow parsers', () => {
  it('parses status filters', () => {
    expect(parseWorkflowStatus(null)).toBeNull();
    expect(parseWorkflowStatus('interrupted')).toBe('interrupted');
    expect(parseWorkflowStatus('bogus')).toBeNull();
    expect(parseWorkflowStatus('')).toBeNull();
  });

  it('parses limits with default 50 and max 200', () => {
    expect(parseWorkflowLimit(null)).toBe(50);
    expect(parseWorkflowLimit('1')).toBe(1);
    expect(parseWorkflowLimit('200')).toBe(200);
    expect(parseWorkflowLimit('0')).toBeNull();
    expect(parseWorkflowLimit('201')).toBeNull();
    expect(parseWorkflowLimit('1.5')).toBeNull();
    expect(parseWorkflowLimit('abc')).toBeNull();
    expect(parseWorkflowLimit('')).toBeNull();
  });

  it('accepts only safe single-segment names', () => {
    expect(isSafeWorkflowName('release-check')).toBe(true);
    expect(isSafeWorkflowName('a.b_c-1')).toBe(true);
    expect(isSafeWorkflowName('')).toBe(false);
    expect(isSafeWorkflowName('../x')).toBe(false);
    expect(isSafeWorkflowName('a/b')).toBe(false);
    expect(isSafeWorkflowName('a\\b')).toBe(false);
    expect(isSafeWorkflowName('a..b')).toBe(false);
    expect(isSafeWorkflowName('.hidden')).toBe(false);
    expect(isSafeWorkflowName('-x')).toBe(false);
    expect(isSafeWorkflowName('a b')).toBe(false);
    expect(isSafeWorkflowName('a'.repeat(129))).toBe(false);
  });
});

describe('workflow wire normalization', () => {
  it('keeps only frozen summary fields', () => {
    const wire = toWireWorkflowSummary({
      ...summary(),
      definition_path: '/secret/path.yaml',
      internal: { secret: true },
    });
    expect(wire).toEqual(summary());
  });

  it('drops invalid summaries', () => {
    expect(toWireWorkflowSummary(null)).toBeNull();
    expect(toWireWorkflowSummary({ ...summary(), status: 'bogus' })).toBeNull();
    expect(toWireWorkflowSummary({ ...summary(), workflow_run_id: '' })).toBeNull();
  });

  it('normalizes detail and truncates output_preview to 200 chars', () => {
    const wire = toWireWorkflowDetail({
      ...summary(),
      definition_path: './workflows/release-check.yaml',
      inputs: { env: 'prod', bad: 1 },
      steps: [
        {
          id: 'plan',
          type: 'agent',
          status: 'completed',
          attempts: 1,
          started_at: 1000,
          finished_at: 2000,
          output_preview: 'x'.repeat(300),
          extra: 'drop',
        },
        { id: 'bad', type: 'loop', status: 'completed' },
      ],
    });
    expect(wire).not.toBeNull();
    expect(wire?.definition_path).toBe('./workflows/release-check.yaml');
    expect(wire?.inputs).toEqual({ env: 'prod' });
    expect(wire?.steps).toHaveLength(1);
    expect(wire?.steps[0]?.output_preview).toHaveLength(200);
    const firstStep = wire?.steps[0];
    if (!firstStep) throw new Error('expected first step');
    expect((firstStep as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it('returns null for detail without definition_path', () => {
    expect(toWireWorkflowDetail(summary())).toBeNull();
  });

  it('dedupes by id and sorts updated_at desc then id asc', () => {
    const list = [
      summary({ workflow_run_id: 'b', updated_at: 10 }),
      summary({ workflow_run_id: 'a', updated_at: 10 }),
      summary({ workflow_run_id: 'c', updated_at: 20 }),
      summary({ workflow_run_id: 'a', updated_at: 30 }),
    ];
    const sorted = sortWorkflowSummaries(dedupeWorkflowSummaries(list));
    expect(sorted.map((item) => item.workflow_run_id)).toEqual(['c', 'a', 'b']);
    expect(sorted.find((item) => item.workflow_run_id === 'a')?.updated_at).toBe(10);
  });
});

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
