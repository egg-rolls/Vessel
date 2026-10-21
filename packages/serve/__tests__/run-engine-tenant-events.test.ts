/**
 * 0.18：权限 / ask 应答必须投递到**该 tenant 的运行时事件流**。
 *
 * 生产装配里 gateway 用共享流（shared）出站，每个 tenant 的 runtime / 工具
 * 等的是自己的 runtimeEvents；只有 tenant→shared 单向桥。应答若只发到 shared，
 * 工具永远等不到（120s/永久挂起）。本测试模拟「两个 tenant 流 + 一个共享流」。
 */

import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { createRunEngine, type RunEngine } from '../src/run-engine';

/** tenant → shared 的单向桥（与 cli / tenant-runtime-factory 的装配一致）。 */
function bridge(from: EventStreamLike, to: MemoryEventStream, tenantId: string): () => void {
  return from.subscribe((event) => {
    to.publish(event.tenant_id === undefined ? { ...event, tenant_id: tenantId } : event);
  });
}

type EventStreamLike = MemoryEventStream;

function collect(stream: MemoryEventStream): RunEvent[] {
  const seen: RunEvent[] = [];
  stream.subscribe((event) => {
    seen.push(event);
  });
  return seen;
}

function setupWithTenants(tenantIds: readonly string[]) {
  const shared = new MemoryEventStream();
  const tenantStreams = new Map<string, MemoryEventStream>();
  for (const id of tenantIds) tenantStreams.set(id, new MemoryEventStream());
  const stops = [...tenantStreams].map(([id, stream]) => bridge(stream, shared, id));
  const engine = createRunEngine({
    events: shared,
    defaultTenantId: 'default',
    tenantEventsFor: (tenantId) => tenantStreams.get(tenantId),
  });
  // gateway 在 startGateway 里把共享流接到 engine.handleEvent；这里显式接同一根线。
  stops.push(
    shared.subscribe((event) => {
      engine.handleEvent(event);
    }),
  );
  const seen = {
    shared: collect(shared),
    tenantA: collect(tenantStreams.get('tenant-a') as MemoryEventStream),
    tenantB: collect(tenantStreams.get('tenant-b') as MemoryEventStream),
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
    // shared 经既有桥看到一次（Web 仍能收到），且没有重复发布。
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

  it('falls back to the engine stream when the tenant stream is unknown', () => {
    const shared = new MemoryEventStream();
    const seen = collect(shared);
    const engine = createRunEngine({
      events: shared,
      defaultTenantId: 'default',
      tenantEventsFor: () => undefined,
    });
    shared.subscribe((event) => {
      engine.handleEvent(event);
    });

    requestPermissionOn(shared);
    engine.respondPermission('perm-1', 'allow', false);
    requestAskOn(shared);
    engine.respondAsk('ask-1', [], undefined);

    expect(responses(seen)).toHaveLength(1);
    expect(answers(seen)).toHaveLength(1);
  });

  it('keeps run-terminal cleanup working with tenant streams', () => {
    const { shared, tenantStreams, engine, seen, dispose } = setupWithTenants([
      'tenant-a',
      'tenant-b',
    ]);
    requestPermissionOn(tenantStreams.get('tenant-a') as MemoryEventStream);
    requestAskOn(tenantStreams.get('tenant-a') as MemoryEventStream);

    shared.publish({ type: 'run.completed', run_id: 'run-1', data: {}, ts: Date.now() });
    expect(engine.pendingPermissions.size).toBe(0);
    expect(engine.pendingAsks.size).toBe(0);
    // 终态不发应答事件。
    expect(responses(seen.tenantA)).toHaveLength(0);
    expect(answers(seen.tenantA)).toHaveLength(0);
    dispose();
  });

  it('does not expire pending asks by default (0.18)', () => {
    const shared = new MemoryEventStream();
    const engine = createRunEngine({ events: shared, defaultTenantId: 'default' });
    shared.subscribe((event) => {
      engine.handleEvent(event);
    });

    requestAskOn(shared);
    engine.sweep(Date.now() + 10_000_000);
    expect(engine.pendingAsks.has('ask-1')).toBe(true);
    // 仍然可以应答（没有被后台 sweep 悄悄删掉）。
    engine.respondAsk('ask-1', []);
  });

  it('honors an explicit interactionTtlMs when configured', () => {
    const shared = new MemoryEventStream();
    const engine = createRunEngine({
      events: shared,
      defaultTenantId: 'default',
      interactionTtlMs: 1_000,
    });
    shared.subscribe((event) => {
      engine.handleEvent(event);
    });

    requestAskOn(shared);
    engine.sweep(Date.now() + 5_000);
    expect(engine.pendingAsks.has('ask-1')).toBe(false);
  });

  it('does not double-publish when a tenant stream is the engine stream', () => {
    const shared = new MemoryEventStream();
    const seen = collect(shared);
    const engine: RunEngine = createRunEngine({
      events: shared,
      defaultTenantId: 'default',
      tenantEventsFor: () => shared,
    });
    shared.subscribe((event) => {
      engine.handleEvent(event);
    });

    requestAskOn(shared);
    engine.respondAsk('ask-1', []);

    expect(answers(seen)).toHaveLength(1);
  });
});
