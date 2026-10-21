/**
 * 0.18：权限 / ask 应答必须投递到**该 tenant 的运行时事件流**。
 *
 * 生产装配里每个 tenant 的 runtime / 工具等的是自己的 runtimeEvents；
 * shared 只做出站投影。engine 只观察 tenant 流（Step 2），应答也只回到这里。
 */

import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { createRunEngine, type RunEngine } from '../src/run-engine';

/** tenant → shared 的出站桥（只服务 Web 投影，不驱动 engine）。 */
function bridge(from: MemoryEventStream, to: MemoryEventStream, tenantId: string): () => void {
  return from.subscribe((event) => {
    to.publish(event.tenant_id === undefined ? { ...event, tenant_id: tenantId } : event);
  });
}

function collect(stream: MemoryEventStream): RunEvent[] {
  const seen: RunEvent[] = [];
  stream.subscribe((event) => {
    seen.push(event);
  });
  return seen;
}

/** gateway Step 2 的接线：每个 tenant 流 → engine.handleEvent（补 tenant_id）。 */
function observeTenant(stream: MemoryEventStream, tenantId: string, engine: RunEngine): () => void {
  return stream.subscribe((event) => {
    engine.handleEvent(
      event.tenant_id === undefined || event.tenant_id === ''
        ? { ...event, tenant_id: tenantId }
        : event,
    );
  });
}

function setupWithTenants(tenantIds: readonly string[]) {
  const shared = new MemoryEventStream();
  const tenantStreams = new Map<string, MemoryEventStream>();
  for (const id of tenantIds) tenantStreams.set(id, new MemoryEventStream());
  const stops = [...tenantStreams].map(([id, stream]) => bridge(stream, shared, id));
  const engine = createRunEngine({
    defaultTenantId: 'default',
    tenantEventsFor: (tenantId) => tenantStreams.get(tenantId),
  });
  for (const [id, stream] of tenantStreams) stops.push(observeTenant(stream, id, engine));
  const tenantA = tenantStreams.get('tenant-a') as MemoryEventStream;
  const tenantB = tenantStreams.get('tenant-b') as MemoryEventStream | undefined;
  const seen = {
    shared: collect(shared),
    tenantA: collect(tenantA),
    tenantB: tenantB === undefined ? [] : collect(tenantB),
  };
  const dispose = () => {
    for (const stop of stops) stop();
  };
  return { shared, tenantStreams, engine, seen, dispose };
}

function requestPermissionOn(stream: MemoryEventStream, runId = 'run-1', requestId = 'perm-1') {
  stream.publish({
    type: 'tool.permission.request',
    run_id: runId,
    data: { requestId, tool: 'bash', input: { cmd: 'ls' } },
    ts: Date.now(),
  });
}

function requestAskOn(stream: MemoryEventStream, runId = 'run-1', requestId = 'ask-1') {
  stream.publish({
    type: 'ask.user.requested',
    run_id: runId,
    data: { requestId, questions: [{ header: 'Q', question: 'which?' }] },
    ts: Date.now(),
  });
}

function responses(seen: RunEvent[]): RunEvent[] {
  return seen.filter((event) => event.type === 'tool.permission.response');
}

function answers(seen: RunEvent[]): RunEvent[] {
  return seen.filter((event) => event.type === 'ask.user.answered');
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('run engine answer delivery (0.18)', () => {
  it('delivers a permission answer to the owning tenant stream only', () => {
    const { tenantStreams, engine, seen, dispose } = setupWithTenants(['tenant-a', 'tenant-b']);
    requestPermissionOn(tenantStreams.get('tenant-a') as MemoryEventStream);
    expect(engine.pendingPermissions.get('perm-1')?.tenant_id).toBe('tenant-a');

    const result = engine.respondPermission('perm-1', 'allow', false, 'tenant-a');
    expect(result).toEqual({ ok: true, decision: 'allow', scope: 'once' });

    // 工具等的是 tenant 流：必须到达。
    expect(responses(seen.tenantA)).toHaveLength(1);
    expect(responses(seen.tenantA)[0]?.data).toMatchObject({
      requestId: 'perm-1',
      decision: 'allow',
    });
    expect(responses(seen.tenantA)[0]?.tenant_id).toBe('tenant-a');
    // 另一个 tenant 不得收到。
    expect(responses(seen.tenantB)).toHaveLength(0);
    // shared 经出站桥看到一次（Web 仍能收到），且没有重复发布。
    expect(responses(seen.shared)).toHaveLength(1);
    dispose();
  });

  it('delivers an ask answer to the owning tenant stream only', () => {
    const { tenantStreams, engine, seen, dispose } = setupWithTenants(['tenant-a', 'tenant-b']);
    requestAskOn(tenantStreams.get('tenant-a') as MemoryEventStream);
    expect(engine.pendingAsks.get('ask-1')?.tenant_id).toBe('tenant-a');

    engine.respondAsk('ask-1', [{ header: 'Q', question: 'which?', answer: 'this' }], 'tenant-a');

    expect(answers(seen.tenantA)).toHaveLength(1);
    expect(answers(seen.tenantA)[0]?.data).toMatchObject({ requestId: 'ask-1' });
    expect(answers(seen.tenantA)[0]?.tenant_id).toBe('tenant-a');
    expect(answers(seen.tenantB)).toHaveLength(0);
    expect(answers(seen.shared)).toHaveLength(1);
    dispose();
  });

  it('rejects an answer when the tenant stream is gone instead of dropping it', () => {
    const stream = new MemoryEventStream();
    let available = true;
    const engine = createRunEngine({
      defaultTenantId: 'default',
      tenantEventsFor: () => (available ? stream : undefined),
    });
    observeTenant(stream, 'default', engine);

    requestPermissionOn(stream);
    available = false;

    expect(codeOf(() => engine.respondPermission('perm-1', 'allow', false))).toBe('run_ended');
    // pending 不因投递失败而消失，迟到的 tenant 流仍可重试。
    expect(engine.pendingPermissions.has('perm-1')).toBe(true);
    stream.publish({ type: 'run.failed', run_id: 'run-1', data: {}, ts: Date.now() });
    expect(engine.pendingPermissions.size).toBe(0);
  });

  it('keeps run-terminal cleanup working with tenant streams', () => {
    const { tenantStreams, engine, seen, dispose } = setupWithTenants(['tenant-a', 'tenant-b']);
    requestPermissionOn(tenantStreams.get('tenant-a') as MemoryEventStream);
    requestAskOn(tenantStreams.get('tenant-a') as MemoryEventStream);

    (tenantStreams.get('tenant-a') as MemoryEventStream).publish({
      type: 'run.completed',
      run_id: 'run-1',
      data: {},
      ts: Date.now(),
    });
    expect(engine.pendingPermissions.size).toBe(0);
    expect(engine.pendingAsks.size).toBe(0);
    // 终态不发应答事件。
    expect(responses(seen.tenantA)).toHaveLength(0);
    expect(answers(seen.tenantA)).toHaveLength(0);
    dispose();
  });

  it('keeps pending asks until an answer or a terminal event (no TTL)', () => {
    const { tenantStreams, engine, dispose } = setupWithTenants(['tenant-a']);
    const stream = tenantStreams.get('tenant-a') as MemoryEventStream;
    requestAskOn(stream);

    // 0.18：没有 TTL / sweep；时间流逝不淘汰 pending。
    expect(engine.pendingAsks.has('ask-1')).toBe(true);
    engine.respondAsk('ask-1', []);
    expect(engine.pendingAsks.has('ask-1')).toBe(false);
    dispose();
  });

  it('does not double-publish when the tenant stream is the same object', () => {
    const stream = new MemoryEventStream();
    const seen = collect(stream);
    const engine = createRunEngine({
      defaultTenantId: 'default',
      tenantEventsFor: () => stream,
    });
    observeTenant(stream, 'default', engine);

    requestAskOn(stream);
    engine.respondAsk('ask-1', []);

    expect(answers(seen)).toHaveLength(1);
  });
});
