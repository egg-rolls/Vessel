import { afterEach, describe, expect, it } from 'bun:test';
import type { VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import { setLocale } from '../src/i18n/index.js';
import {
  buildStatusSnapshot,
  countPendingPermissions,
  findActiveRun,
  formatSnapshotTime,
  formatStatusSnapshot,
} from '../src/repl/status-snapshot.js';
import { makeCtx, makeState } from './helpers.js';

function ev(type: string, runId: string, data: Record<string, unknown>, ts: number): RunEvent {
  return { type, run_id: runId, data, ts } as RunEvent;
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('status snapshot', () => {
  it('uses the latest run without a terminal event as active', () => {
    const events = [
      ev('run.started', 'run-old', { session_id: 's1' }, 1000),
      ev('run.completed', 'run-old', {}, 2000),
      ev('run.started', 'run-new', { session_id: 's2' }, 3000),
      ev('subagent.run.started', 'run-child', { delegateId: 'd1' }, 3100),
    ];

    expect(findActiveRun(events)).toEqual({
      state: 'running',
      runId: 'run-new',
      sessionId: 's2',
      startedAt: 3000,
    });
  });

  it('resets to idle after a terminal event', () => {
    expect(
      findActiveRun([
        ev('run.started', 'r1', {}, 1000),
        ev('run.failed', 'r1', { error: 'x' }, 2000),
      ]),
    ).toEqual({ state: 'idle' });
  });

  it('counts pending permission requests and clears them on response or run end', () => {
    expect(
      countPendingPermissions([
        ev('tool.permission.request', 'r1', { requestId: 'a' }, 1000),
        ev('tool.permission.request', 'r1', { requestId: 'b' }, 1100),
        ev('tool.permission.response', 'r1', { requestId: 'a', decision: 'allow' }, 1200),
      ]),
    ).toBe(1);

    expect(
      countPendingPermissions([
        ev('tool.permission.request', 'r1', { requestId: 'a' }, 1000),
        ev('run.completed', 'r1', {}, 1200),
      ]),
    ).toBe(0);
  });

  it('builds the local snapshot without RPC', () => {
    const ctx = makeCtx({
      provider: { name: 'mock', model: 'mock-1', baseUrl: 'memory' },
      config: {
        context: { maxTokens: 1000 },
        permission: { autoApprove: ['bash', 'read'] },
      } as VesselConfig,
      tenant: { tenant_id: 'acme' },
      version: '0.14.0',
    });
    ctx.context.add({ role: 'user', content: 'hello world' } as never);
    ctx.events.publish(ev('run.started', 'r1', { session_id: 's1' }, 1000));
    ctx.events.publish(ev('tool.permission.request', 'r1', { requestId: 'p1' }, 1100));

    const state = makeState('s1');
    state.queuedCount = 2;
    const snapshot = buildStatusSnapshot(ctx, state, 5000);

    expect(snapshot.run).toMatchObject({ state: 'running', runId: 'r1', startedAt: 1000 });
    expect(snapshot.sessionId).toBe('s1');
    expect(snapshot.provider).toEqual({ name: 'mock', model: 'mock-1', baseUrl: 'memory' });
    expect(snapshot.context).toMatchObject({ max: 1000, messages: 1 });
    expect(snapshot.context.used).toBeGreaterThan(0);
    expect(snapshot.permissions).toEqual({ autoApprove: ['bash', 'read'], pending: 1 });
    expect(snapshot.queue.input).toBe(2);
    expect(snapshot.instance).toMatchObject({ version: '0.14.0', tenantId: 'acme', rpc: false });
  });

  it('formats time independently of platform locale', () => {
    const ts = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatSnapshotTime(ts)).toBe('2026-01-02 03:04:05');
  });

  it('formats a one-screen snapshot with as_of and all sections', () => {
    setLocale('en');
    const ctx = makeCtx({
      config: {
        context: { maxTokens: 1000 },
        permission: { autoApprove: ['bash'] },
      } as VesselConfig,
      tenant: { tenant_id: 'acme' },
      version: '0.14.0',
    });
    ctx.events.publish(ev('run.started', 'run-abcdefghijklmnop', {}, 1000));

    const state = makeState('session-x');
    state.queuedCount = 3;
    const text = formatStatusSnapshot(buildStatusSnapshot(ctx, state, 61000));

    expect(text).toContain('Status ·');
    expect(text).toContain('run');
    expect(text).toContain('run-abcdefghijklmnop');
    expect(text).toContain('1m00s');
    expect(text).toContain('session-x');
    expect(text).toContain('mock · mock-model · memory');
    expect(text).toContain('1,000 tok');
    expect(text).toContain('auto-approve (bash)');
    expect(text).toContain('3 input queued');
    expect(text).toContain('tenant acme');
  });

  it('shows idle and zero queue for a fresh session', () => {
    setLocale('en');
    const ctx = makeCtx();
    const text = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 1000));
    expect(text).toContain('idle');
    expect(text).toContain('0 input queued');
  });

  it('shows effective limits, active usage, and unbounded budgets', () => {
    setLocale('en');
    const ctx = makeCtx({
      config: {
        termination: { maxIterations: 30 },
        limits: {
          requestLimit: 100,
          toolCallsLimit: 50,
          inputTokensLimit: 100000,
          outputTokensLimit: 50000,
        },
        context: { maxTokens: 1000 },
      } as VesselConfig,
    });
    ctx.events.publish(ev('run.started', 'r-active', {}, 1000));
    ctx.events.publish(
      ev(
        'llm.response',
        'r-active',
        { usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } },
        2000,
      ),
    );
    ctx.events.publish(ev('tool.call.started', 'r-active', { tool_name: 'bash' }, 3000));

    const text = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 61000));
    expect(text).toContain('iterations 1/30');
    expect(text).toContain('tools 1/50');
    expect(text).toContain('runtime 1m00s/5m00s');
    expect(text).toContain('in 1,200/100,000');
    expect(text).toContain('out 300/50,000');
    expect(text).toContain('ctx 0/1,000');
    expect(text).toContain('cost unknown/unbounded');
  });

  it('keeps configured limits visible but marks usage absent when idle', () => {
    setLocale('en');
    const ctx = makeCtx({
      config: { termination: { maxIterations: 30 }, context: { maxTokens: 1000 } } as VesselConfig,
    });
    const text = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 1000));
    expect(text).toContain('iterations -/30');
    expect(text).toContain('tools -/50');
    expect(text).toContain('runtime -/5m00s');
    expect(text).toContain('cost -/unbounded');
    expect(text).not.toContain('limit blocked');
  });

  it('appends the agent queue snapshot and the latest compaction', () => {
    setLocale('en');
    const ctx = makeCtx({ config: { context: { maxTokens: 1000 } } as VesselConfig });
    ctx.events.publish(ev('run.started', 'r1', {}, 1000));
    ctx.events.publish(
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd-running', depth: 0 }, 1000),
    );
    ctx.events.publish(
      ev(
        'agent.queue.entered',
        'run-parent',
        { agent_id: 'd-wait', run_id: 'run-child', position: 1, wait_reason: 'capacity' },
        1100,
      ),
    );
    ctx.events.publish(
      ev('context.compacted', 'r1', { removed: 1234, remaining: 5000, reason: 'auto' }, 1200),
    );

    const snapshot = buildStatusSnapshot(ctx, makeState('s1'), 2000);
    expect(snapshot.agentQueue).toMatchObject({ queued: 1, running: 1 });
    expect(snapshot.agentQueue.entries[0]).toMatchObject({
      id: 'd-wait',
      position: 1,
      waitReason: 'capacity',
    });
    expect(snapshot.lastCompaction).toMatchObject({
      removed: 1234,
      remaining: 5000,
      reason: 'auto',
    });

    const text = formatStatusSnapshot(snapshot);
    expect(text).toContain('agent queue');
    expect(text).toContain('1 queued · 1 running');
    expect(text).toContain('d-wait · pos 1 · capacity');
    expect(text).toContain('removed 1,234 · remaining 5,000 · auto');
  });

  it('shows the latest 80% warning once per key while its run is active', () => {
    setLocale('en');
    const ctx = makeCtx({ config: { context: { maxTokens: 1000 } } as VesselConfig });
    ctx.events.publish(ev('run.started', 'r1', {}, 1000));
    ctx.events.publish(
      ev(
        'agent.limit.warning',
        'r1',
        {
          scope: 'run',
          key: 'inputTokensLimit',
          current: 800,
          max: 1000,
          source: 'config.limits',
          threshold: 0.8,
        },
        1100,
      ),
    );
    ctx.events.publish(
      ev(
        'agent.limit.warning',
        'r1',
        { scope: 'run', key: 'inputTokensLimit', current: 900, max: 1000, threshold: 0.8 },
        1200,
      ),
    );
    ctx.events.publish(
      ev(
        'agent.limit.warning',
        'r1',
        { scope: 'run', key: 'toolCallsLimit', current: 40, max: 50, threshold: 0.8 },
        1300,
      ),
    );

    const active = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 2000));
    expect((active.match(/inputTokensLimit/g) ?? []).length).toBe(1);
    expect(active).toContain('run/inputTokensLimit 900/1000 · 80% threshold');
    expect(active).toContain('run/toolCallsLimit 40/50');

    ctx.events.publish(ev('run.completed', 'r1', {}, 1500));
    const done = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 2000));
    expect(done).not.toContain('limit warning');
  });

  it('appends a limit block row only while its run is active', () => {
    setLocale('en');
    const ctx = makeCtx({ config: { context: { maxTokens: 1000 } } as VesselConfig });
    ctx.events.publish(ev('run.started', 'r1', {}, 1000));
    ctx.events.publish(
      ev(
        'agent.limit.blocked',
        'r1',
        {
          scope: 'agent',
          key: 'toolCallsLimit',
          current: 50,
          max: 50,
          source: 'config.limits',
          hint: 'raise limits.toolCallsLimit',
        },
        2000,
      ),
    );

    const active = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 3000));
    expect(active).toContain(
      'limit blocked · agent/toolCallsLimit 50/50 · config.limits · raise limits.toolCallsLimit',
    );

    ctx.events.publish(ev('run.completed', 'r1', {}, 4000));
    const done = formatStatusSnapshot(buildStatusSnapshot(ctx, makeState('s1'), 5000));
    expect(done).not.toContain('limit blocked');
  });
});
