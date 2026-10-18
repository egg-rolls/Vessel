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
  it('未注入控制面 -> 明确提示', async () => {
    const result = await runMetricsCommand([], makeCtx());
    expect(result.handled).toBe(true);
    expect(result.output ?? '').toContain('Metrics are not enabled');
  });

  it('无 rpc 时回退 ctx.metrics', async () => {
    const ctx = makeCtx();
    ctx.metrics = () => snapshot;
    const result = await runMetricsCommand([], ctx);
    expect(result.output ?? '').toContain('13 runs');
    expect(result.output ?? '').toContain('34 tool calls');
  });

  it('多余参数返回 usage', async () => {
    const ctx = makeCtx();
    ctx.metrics = () => snapshot;
    expect((await runMetricsCommand(['extra'], ctx)).output ?? '').toContain('Usage: /metrics');
  });

  it('快照闭包抛错走 error-classifier', async () => {
    const ctx = makeCtx();
    ctx.metrics = () => {
      throw new Error('boom');
    };
    const output = (await runMetricsCommand([], ctx)).output ?? '';
    expect(output).toContain('Failed to read metrics');
    expect(output).toContain('[unknown]');
  });

  it('RPC live：默认来源', async () => {
    const calls: unknown[] = [];
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          return snapshot as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await runMetricsCommand([], ctx);
    expect(result.output).toContain('Metrics: 13 runs');
    expect(calls).toEqual([{ method: 'metrics.get', params: { source: 'live' } }]);
  });

  it('RPC trace：带重建前缀与 source 参数', async () => {
    const calls: unknown[] = [];
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          return { metrics: snapshot } as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await runMetricsCommand(['--source', 'trace'], ctx);
    expect(result.output).toContain('Metrics (rebuilt from trace):');
    expect(calls).toEqual([{ method: 'metrics.get', params: { source: 'trace' } }]);
  });

  it('RPC --json 输出可解析快照', async () => {
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(): Promise<T> {
          return snapshot as T;
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await runMetricsCommand(['--json'], ctx);
    const parsed = JSON.parse((result.output ?? '').trim()) as MetricsSnapshotLike;
    expect(parsed.runs.started).toBe(13);
  });

  it('--source trace 无 rpc 时明确提示', async () => {
    const result = await runMetricsCommand(['--source', 'trace'], makeCtx());
    expect(result.output).toContain('require the RPC control plane');
  });

  it('--source 非法值给 usage', async () => {
    const result = await runMetricsCommand(['--source', 'nope'], makeCtx());
    expect(result.output).toContain('Usage: /metrics');
  });

  it('RPC 错误按 code 展示', async () => {
    const ctx = makeCtx({
      rpc: {
        async request<T = unknown>(): Promise<T> {
          throw { code: 'internal', message: 'rebuild failed' };
        },
        subscribe: () => () => undefined,
      },
    });
    const result = await runMetricsCommand(['--source', 'trace'], ctx);
    expect(result.output).toContain('✗ [internal] rebuild failed');
  });
});
