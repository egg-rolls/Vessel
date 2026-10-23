import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStream } from '@vessel-agent/core';
import type { AgentEvent, MemberTurnResult, PermissionDecision } from '../src/index.js';
import { deferred, makeService, settle } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AgentService events', () => {
  it('emits spawned, queued, turn.started and turn.completed once per send', async () => {
    const { service, runtime } = makeService();
    runtime.handler = async () => ({
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    const seen: AgentEvent[] = [];
    service.subscribe((event) => seen.push(event));

    const member = await service.new({ name: 'worker', visibility: 'team' });
    await service.send({ to: member.id, content: 'hi' });
    await settle();

    expect(seen.map((event) => event.type)).toEqual([
      'agent.spawned',
      'agent.message.queued',
      'agent.turn.started',
      'agent.turn.completed',
    ]);
    const [spawned, queued, started, completed] = seen;
    expect(spawned?.visibility).toBe('team');
    expect(spawned?.name).toBe('worker');
    expect(queued?.agent_id).toBe(member.id);
    expect(queued?.session_id).toBe(member.id);
    expect(typeof queued?.message_id).toBe('string');
    expect(queued?.from).toBe('main');
    expect(queued?.visibility).toBe('team');
    expect(queued?.name).toBe('worker');
    expect(started?.state).toBe('running');
    expect(completed?.state).toBe('completed');
    expect(completed?.outcome).toBe('completed');
    expect(completed?.visibility).toBe('team');
    expect(completed?.name).toBe('worker');
    expect(completed?.usage?.total_tokens).toBe(7);
    expect(typeof completed?.ts).toBe('number');
  });

  it('omits turn.completed usage when the runtime returns none', async () => {
    const { service } = makeService();
    const seen: AgentEvent[] = [];
    service.subscribe((event) => seen.push(event));

    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'hi' });
    await settle();

    const completed = seen.find((event) => event.type === 'agent.turn.completed');
    expect(completed).toBeDefined();
    expect('usage' in (completed as AgentEvent)).toBe(false);
    // 未命名成员不伪造 name
    expect('name' in (completed as AgentEvent)).toBe(false);
  });

  it('a failing turn emits agent.turn.failed with the reason', async () => {
    const { service, runtime } = makeService();
    const seen: AgentEvent[] = [];
    service.subscribe((event) => seen.push(event));
    runtime.handler = async () => {
      throw new Error('provider exploded');
    };

    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'hi' });
    await settle();

    const failed = seen.find((event) => event.type === 'agent.turn.failed');
    expect(failed?.outcome).toBe('failed');
    expect(failed?.state).toBe('failed');
    expect(failed?.reason).toContain('provider exploded');
  });

  it('close while running emits agent.closed and a cancelled turn, never completed', async () => {
    const { service, runtime } = makeService();
    const seen: AgentEvent[] = [];
    service.subscribe((event) => seen.push(event));
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'work' });

    await service.close({ member: member.id });
    gate.resolve({ content: 'late' });
    await settle();

    expect(seen.filter((event) => event.type === 'agent.closed')).toHaveLength(1);
    expect(seen.filter((event) => event.type === 'agent.turn.cancelled')).toHaveLength(1);
    expect(seen.some((event) => event.type === 'agent.turn.completed')).toBe(false);
  });

  it('a throwing subscriber does not break send or the turn', async () => {
    const { service } = makeService();
    service.subscribe(() => {
      throw new Error('listener exploded');
    });

    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'hi' });
    await settle();

    const [status] = await service.list({ viewer: 'main' });
    expect(status?.state).toBe('completed');
  });

  it('unsubscribe stops delivery and is idempotent', async () => {
    const { service } = makeService();
    let spawned = 0;
    const off = service.subscribe((event) => {
      if (event.type === 'agent.spawned') spawned += 1;
    });

    await service.new({ visibility: 'team' });
    off();
    off();
    await service.new({ visibility: 'team' });

    expect(spawned).toBe(1);
  });

  it('permission request and response events carry tool, request_id and decision', async () => {
    const decision = deferred<PermissionDecision>();
    const { service, runtime } = makeService({
      permissionBridge: { request: () => decision.promise },
    });
    const seen: AgentEvent[] = [];
    service.subscribe((event) => seen.push(event));
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'work' });

    const pending = service.requestPermission(member.id, member.session_id, {
      requestId: 'req-1',
      tool: 'bash',
    });
    await settle();
    const requested = seen.find((event) => event.type === 'agent.permission.requested');
    expect(requested?.tool).toBe('bash');
    expect(requested?.request_id).toBe('req-1');
    expect(requested?.state).toBe('waiting_permission');

    decision.resolve({ decision: 'allow' });
    expect(await pending).toEqual({ decision: 'allow' });
    const responded = seen.find((event) => event.type === 'agent.permission.responded');
    expect(responded?.decision).toBe('allow');
    expect(responded?.request_id).toBe('req-1');
    expect(responded?.state).toBe('running');

    gate.resolve({});
    await settle();
  });

  it('events option receives RunEvent with member id as run_id and snake_case data', async () => {
    const stream = new MemoryEventStream();
    const { service } = makeService({ events: stream });
    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'hi' });
    await settle();

    const history = stream.getHistory();
    const spawned = history.find((event) => event.type === 'agent.spawned');
    expect(spawned?.run_id).toBe(member.id);
    expect(spawned?.tenant_id).toBe('default');
    const data = spawned?.data as Record<string, unknown> | undefined;
    expect(data?.agent_id).toBe(member.id);
    expect(data?.session_id).toBe(member.id);
    expect(typeof data?.ts).toBe('number');
    expect(history.some((event) => event.type === 'agent.turn.completed')).toBe(true);
  });

  it('snapshot restore publishes agent.stale through the events option', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    await first.service.attachOwner({ id: 'main', visibility: 'team' });
    await first.service.flushSnapshot();

    const stream = new MemoryEventStream();
    const second = makeService({ dataDir, events: stream });
    await second.service.list({ viewer: 'main' });

    const stale = stream.getHistory().find((event) => event.type === 'agent.stale');
    expect(stale?.run_id).toBe('main');
    const data = stale?.data as Record<string, unknown> | undefined;
    expect(data?.state).toBe('idle');
    expect(data?.presence).toBe('gone');
  });
});
