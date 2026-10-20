import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { createRunEngine, type RunEngine } from '../src/run-engine';

function setup(interactionTtlMs = 120_000) {
  const events = new MemoryEventStream();
  const engine = createRunEngine({ events, defaultTenantId: 'default', interactionTtlMs });
  const seen: RunEvent[] = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  return { events, engine, seen };
}

function requestPermission(
  engine: RunEngine,
  overrides: Record<string, unknown> = {},
  ts = Date.now(),
): void {
  engine.handleEvent({
    type: 'tool.permission.request',
    run_id: 'run-1',
    ts,
    data: {
      requestId: 'perm-1',
      tool: 'bash',
      input: { cmd: 'ls' },
      session_id: 'session-1',
      tool_call_id: 'call-1',
      source: 'runtime',
      ...overrides,
    },
  });
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('run engine permission lifecycle', () => {
  it('captures session / tool_call / source and derives deadline from event time', () => {
    const { engine } = setup();
    const ts = Date.now();
    requestPermission(engine, {}, ts);
    const pending = engine.pendingPermissions.get('perm-1');
    expect(pending).toMatchObject({
      run_id: 'run-1',
      tenant_id: 'default',
      tool: 'bash',
      session_id: 'session-1',
      tool_call_id: 'call-1',
      source: 'runtime',
      deadline_at: ts + 120_000,
    });
  });

  it('uses explicit deadline_at when the event provides one', () => {
    const { engine } = setup();
    const ts = Date.now();
    requestPermission(engine, { deadline_at: ts + 5_000 }, ts);
    expect(engine.pendingPermissions.get('perm-1')?.deadline_at).toBe(ts + 5_000);
  });

  it('treats a repeated response as idempotent and rejects a conflicting decision', () => {
    const { engine, seen } = setup();
    requestPermission(engine);

    const first = engine.respondPermission('perm-1', 'allow', false, undefined, 'session');
    expect(first).toEqual({ ok: true, decision: 'allow', scope: 'session' });
    expect(engine.pendingPermissions.has('perm-1')).toBe(false);

    const responses = () => seen.filter((event) => event.type === 'tool.permission.response');
    expect(responses()).toHaveLength(1);
    expect(responses()[0]?.data).toMatchObject({
      requestId: 'perm-1',
      decision: 'allow',
      scope: 'session',
    });

    // 重复点击（同 decision）返回上次结果，不再发事件。
    const repeat = engine.respondPermission('perm-1', 'allow', false);
    expect(repeat).toEqual({ ok: true, decision: 'allow', scope: 'session', duplicate: true });
    expect(responses()).toHaveLength(1);

    // 与第一次不同的 decision 视为冲突。
    expect(codeOf(() => engine.respondPermission('perm-1', 'deny', false))).toBe('conflict');
  });

  it('maps remember:true to always for old clients', () => {
    const { engine, seen } = setup();
    requestPermission(engine);
    const result = engine.respondPermission('perm-1', 'allow', true);
    expect(result.scope).toBe('always');
    const response = seen.find((event) => event.type === 'tool.permission.response');
    expect(response?.data).toMatchObject({ remember: true, scope: 'always' });
  });

  it('publishes tool.permission.expired when the deadline passes and rejects late answers', () => {
    const { engine, seen } = setup();
    const now = Date.now();
    requestPermission(engine, { deadline_at: now + 1_000 }, now);

    engine.sweep(now + 999);
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);

    engine.sweep(now + 1_000);
    expect(engine.pendingPermissions.has('perm-1')).toBe(false);
    const expired = seen.filter((event) => event.type === 'tool.permission.expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.run_id).toBe('run-1');
    expect(expired[0]?.tenant_id).toBe('default');
    expect(expired[0]?.data).toMatchObject({
      requestId: 'perm-1',
      tool: 'bash',
      session_id: 'session-1',
      tool_call_id: 'call-1',
    });

    expect(codeOf(() => engine.respondPermission('perm-1', 'allow', false))).toBe('expired');
    // 第二次迟到应答仍然是 expired，而不是退回 not_found。
    expect(codeOf(() => engine.respondPermission('perm-1', 'deny', false))).toBe('expired');
  });

  it('clears pending permissions on every terminal run event', () => {
    for (const type of ['run.completed', 'run.failed', 'run.cancelled'] as const) {
      const { engine } = setup();
      requestPermission(engine, { requestId: `${type}-perm` });
      engine.handleEvent({ type, run_id: 'run-1', ts: Date.now(), data: {} });
      expect(engine.pendingPermissions.size).toBe(0);
      expect(codeOf(() => engine.respondPermission(`${type}-perm`, 'allow', false))).toBe(
        'expired',
      );
    }
  });

  it('scopes an answer to the tenant that created the request', () => {
    const { engine } = setup();
    requestPermission(engine);
    expect(codeOf(() => engine.respondPermission('perm-1', 'allow', false, 'other'))).toBe(
      'not_found',
    );
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);
  });

  it('does not publish response events twice under concurrent duplicate submits', () => {
    const { engine, seen } = setup();
    requestPermission(engine);
    engine.respondPermission('perm-1', 'allow', false);
    engine.respondPermission('perm-1', 'allow', false);
    expect(seen.filter((event) => event.type === 'tool.permission.response')).toHaveLength(1);
  });
});
