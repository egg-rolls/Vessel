import { describe, expect, it } from 'bun:test';
import { formatCostReport, runCostCommand } from '../src/commands/cost-command.js';
import type { MetricsSnapshotLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const snapshot: MetricsSnapshotLike = {
  runs: { started: 1, completed: 1, failed: 0, cancelled: 0 },
  tool_calls: { total: 2, failed: 0 },
  llm: { requests: 1, prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  duration_ms: { total: 2500, max: 2500, avg: 2500 },
  updated_at: 1,
};

describe('/cost', () => {
  it('无价格配置时只报 token/时长，不编造金额', () => {
    const report = formatCostReport(snapshot);
    expect(report).toContain('pricing not configured');
    expect(report).toContain('100 prompt + 20 completion = 120 total');
    expect(report).toContain('total 2.5s');
    expect(report).not.toMatch(/\$\d/);
  });

  it('metrics 不可用时明确说明，不伪装成 0', async () => {
    const ctx = makeCtx();
    const result = await runCostCommand([], ctx);
    expect(result.output).toContain('Usage data unavailable');
  });

  it('有 metrics 时输出快照', async () => {
    const ctx = makeCtx({ metrics: () => snapshot });
    const result = await runCostCommand([], ctx);
    expect(result.output).toContain('120 total');
  });
});
