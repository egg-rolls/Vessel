import { describe, expect, it } from 'bun:test';
import { formatMetrics, runMetricsCommand } from '../src/commands/metrics-command.js';
import type { MetricsSnapshotLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const snapshot: MetricsSnapshotLike = {
  runs: { started: 13, completed: 10, failed: 1, cancelled: 0 },
  tool_calls: { total: 34, failed: 2 },
  llm: { requests: 5, prompt_tokens: 800, completion_tokens: 434, total_tokens: 1234 },
  duration_ms: { total: 6400, avg: 3200, max: 5000 },
  updated_at: 1000,
};

describe('formatMetrics', () => {
  it('单行输出全部字段', () => {
    const output = formatMetrics(snapshot, 31_000);
    expect(output).not.toContain('\n');
    expect(output).toContain('Metrics: 13 runs (10 completed, 1 failed, 0 cancelled)');
    expect(output).toContain('34 tool calls (2 failed)');
    expect(output).toContain('5 LLM requests');
    expect(output).toContain('1234 tokens (800 prompt, 434 completion)');
    expect(output).toContain('duration total 6400ms / avg 3200ms / max 5000ms');
    expect(output).toContain('updated 30s ago');
  });

  it('零值快照与缺失 updated_at', () => {
    const zero: MetricsSnapshotLike = {
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, avg: 0, max: 0 },
      updated_at: 0,
    };
    const output = formatMetrics(zero);
    expect(output).toContain('Metrics: 0 runs');
    expect(output).toContain('updated -');
  });

  it('小数 avg 四舍五入', () => {
    const output = formatMetrics(
      { ...snapshot, duration_ms: { total: 10, avg: 3.6, max: 5 } },
      31_000,
    );
    expect(output).toContain('avg 4ms');
  });
});

describe('/metrics command', () => {
  it('未注入控制面 -> 明确提示', () => {
    const result = runMetricsCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Metrics are not enabled');
  });

  it('打印快照', () => {
    const ctx = makeCtx();
    ctx.metrics = () => snapshot;
    const result = runMetricsCommand([], ctx);
    expect(result.output ?? '').toContain('13 runs');
    expect(result.output ?? '').toContain('34 tool calls');
  });

  it('多余参数返回 usage', () => {
    const ctx = makeCtx();
    ctx.metrics = () => snapshot;
    expect(runMetricsCommand(['extra'], ctx).output ?? '').toContain('Usage: /metrics');
  });

  it('快照闭包抛错走 error-classifier', () => {
    const ctx = makeCtx();
    ctx.metrics = () => {
      throw new Error('boom');
    };
    const output = runMetricsCommand([], ctx).output ?? '';
    expect(output).toContain('Failed to read metrics');
    expect(output).toContain('[unknown]');
  });
});
