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
});
