import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@vessel-agent/core';
import type { AgentEvent, MemberTurnResult } from '../src/index.js';
import { type Deferred, deferred, makeService, settle } from './helpers.js';

function warning(key: string): RunEvent {
  return {
    type: 'agent.limit.warning',
    run_id: 'run-1',
    data: { key, current: 800, max: 1000, threshold: 0.8, hint: 'rotate' },
    ts: 1,
  };
}

describe('AgentService rotate', () => {
  it('late reply from a retired body never reaches the parent queue', async () => {
    const { service, runtime } = makeService();
    await service.attachOwner({ id: 'main' });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const gate = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => (message.content === 'work' ? gate.promise : {});

    const member = await service.new({ visibility: 'team', parentId: 'main' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });

    const result = await service.rotate({ to: member.id, startup_prompt: 'continue' });
    expect(result.status).toBe('rotated');
    if (result.status !== 'rotated') return;
    expect(result.from_session_id).toBe(oldSession);
    expect(result.epoch).toBe(1);

    gate.resolve({ content: 'late-final' });
    await settle();

    // 旧 Body 的自动最终文本绝不进父队列。
    expect(await service.takeMessages('main')).toEqual([]);

    const staleTerminal = events.find(
      (event) => event.type.startsWith('agent.turn.') && event.stale === true,
    );
    expect(staleTerminal).toBeDefined();
    expect(staleTerminal?.body_id).toBe(oldSession);
    expect(staleTerminal?.session_id).toBe(oldSession);

    const staleReply = events.find((event) => event.type === 'agent.reply.stale');
    expect(staleReply).toMatchObject({
      body_id: oldSession,
      epoch: 0,
      reason: 'epoch_fenced',
    });
    expect(events.find((event) => event.type === 'agent.retired')?.body_id).toBe(oldSession);

    const status = (await service.list({ viewer: 'main' })).find((entry) => entry.id === member.id);
    expect(status?.session_id).toBe(result.to_session_id);
    expect(status?.epoch).toBe(1);
  });

  it('rotate spawn failure keeps pointer, rotation and queued messages on the old body', async () => {
    const { service, runtime } = makeService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const gate = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => (message.content === 'work' ? gate.promise : {});

    const member = await service.new({ visibility: 'team' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });
    await service.send({ to: member.id, content: 'queued' });

    runtime.spawnError = new Error('spawn boom');
    const failed = await service.rotate({ to: member.id, startup_prompt: 'fresh' });

    expect(failed).toMatchObject({
      status: 'failed',
      code: 'rotate_failed',
      reason: 'spawn boom',
    });
    const [during] = await service.list({ viewer: 'main' });
    expect(during?.session_id).toBe(oldSession);
    expect(during?.epoch).toBe(0);
    expect(runtime.spawned).toHaveLength(1);
    expect(runtime.spawnedSessions).toEqual([oldSession]);
    expect(events.some((event) => event.type === 'agent.rotated')).toBe(false);
    expect(
      events.some((event) => event.type === 'agent.rotate.failed' && event.reason === 'spawn boom'),
    ).toBe(true);

    gate.resolve({});
    await settle();
    // 队列原样回到旧 Body，且没有自动重试。
    expect(runtime.turns.map((turn) => turn.message.content)).toEqual(['work', 'queued']);
    expect(runtime.turns.every((turn) => turn.member.session_id === oldSession)).toBe(true);

    // rotation 相位已复位，下一次 rotate 可以正常提交。
    runtime.spawnError = undefined;
    const retried = await service.rotate({ to: member.id, startup_prompt: 'fresh' });
    expect(retried.status).toBe('rotated');
  });

  it('snapshot write failure rolls back the pointer and leaves no live new engine', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vessel-rotate-'));
    // 让 <dataDir>/agents 成为普通文件，mkdir 必然失败（跨平台可移植）。
    await writeFile(join(dataDir, 'agents'), 'not a directory', 'utf8');
    try {
      const { service, runtime } = makeService({ dataDir, snapshot: { enabled: true } });
      const events: AgentEvent[] = [];
      service.subscribe((event) => events.push(event));

      const member = await service.new({ visibility: 'team' });
      const oldSession = member.session_id;
      const failed = await service.rotate({ to: member.id, startup_prompt: 'next' });

      expect(failed).toMatchObject({
        status: 'failed',
        code: 'rotate_failed',
        reason: 'snapshot_write_failed',
      });

      const [status] = await service.list({ viewer: 'main' });
      expect(status?.session_id).toBe(oldSession);
      expect(status?.epoch).toBe(0);

      const newSession = runtime.spawnedSessions[1];
      expect(newSession).toBeDefined();
      expect(newSession).not.toBe(oldSession);
      expect(runtime.disposedSessions).toContain(newSession as string);
      expect(
        events.some(
          (event) =>
            event.type === 'agent.rotate.failed' && event.reason === 'snapshot_write_failed',
        ),
      ).toBe(true);

      // 旧指针仍可寻址。
      const dispatched = await service.dispatch({ to: oldSession, content: 'still here' });
      expect(dispatched.status).toBe('queued');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('new body session is addressable and retired session is not', async () => {
    const { service, runtime } = makeService();
    const member = await service.new({ visibility: 'team' });
    const firstSession = member.session_id;

    // 第一次 rotate 的旧 session 与 agent id 同值（按 id 仍可寻址）；
    // 第二次 rotate 才产生一个“退役且不同于 id”的 session。
    const first = await service.rotate({ to: member.id, startup_prompt: 'one' });
    expect(first.status).toBe('rotated');
    if (first.status !== 'rotated') return;
    const retiredSession = first.to_session_id;

    const second = await service.rotate({ to: member.id, startup_prompt: 'two' });
    expect(second.status).toBe('rotated');
    if (second.status !== 'rotated') return;
    const newSession = second.to_session_id;
    await settle();

    expect(runtime.spawnedSessions).toEqual([firstSession, retiredSession, newSession]);
    const status = (await service.list({ viewer: 'main' })).find((entry) => entry.id === member.id);
    expect(status?.session_id).toBe(newSession);
    expect(status?.epoch).toBe(2);

    const live = await service.dispatch({ to: newSession, content: 'hello' });
    expect(live).toMatchObject({ status: 'queued', resolved_to: member.id });

    await expect(service.dispatch({ to: retiredSession, content: 'x' })).rejects.toMatchObject({
      code: 'unknown_member',
    });
    await expect(service.send({ to: retiredSession, content: 'x' })).rejects.toMatchObject({
      code: 'unknown_member',
    });
  });

  it('limit warning from a retired body is ignored and deduped for the current body', async () => {
    const { service, runtime } = makeService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const gate: Deferred<MemberTurnResult> = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => (message.content === 'work' ? gate.promise : {});

    const member = await service.new({ visibility: 'team' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });

    const systemMessages = () =>
      events.filter((event) => event.type === 'agent.message.queued' && event.from === 'system');

    service.noteMemberEvent(member.id, oldSession, warning('input_tokens'));
    service.noteMemberEvent(member.id, oldSession, warning('input_tokens'));
    expect(systemMessages()).toHaveLength(1);

    const rotated = await service.rotate({ to: member.id, startup_prompt: 'fresh' });
    expect(rotated.status).toBe('rotated');
    if (rotated.status !== 'rotated') return;

    // 旧 Body 的预警在当前指针下被丢弃。
    service.noteMemberEvent(member.id, oldSession, warning('input_tokens'));
    expect(systemMessages()).toHaveLength(1);

    // 新 Body 同一 key 可再次提示（rotate 清空了去重集合）。
    service.noteMemberEvent(member.id, rotated.to_session_id, warning('input_tokens'));
    expect(systemMessages()).toHaveLength(2);

    gate.resolve({});
    await settle();
  });

  it('permission state from a retired body cannot block the new body', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    const nextGate = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => {
      if (message.content === 'work') return gate.promise;
      if (message.content === 'next') return nextGate.promise;
      return {};
    };

    const member = await service.new({ visibility: 'team' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });

    const rotated = await service.rotate({ to: member.id, startup_prompt: 'fresh' });
    expect(rotated.status).toBe('rotated');
    if (rotated.status !== 'rotated') return;

    gate.resolve({});
    await settle();

    const newTurns = () =>
      runtime.turns
        .filter((turn) => turn.member.session_id === rotated.to_session_id)
        .map((turn) => turn.message.content);
    expect(newTurns()).toEqual(['fresh']);

    // 新 Body 正在跑：旧 Body 的迟到 waiting 不得改写当前 state。
    await service.send({ to: member.id, content: 'next' });
    await settle();
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('running');
    service.notePermissionState(member.id, oldSession, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('running');

    nextGate.resolve({});
    await settle();
    expect(newTurns()).toEqual(['fresh', 'next']);
  });

  it('a stale turn ending in waiting_permission does not block the new body', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => (message.content === 'work' ? gate.promise : {});

    const member = await service.new({ visibility: 'team' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });
    service.notePermissionState(member.id, oldSession, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('waiting_permission');

    const rotated = await service.rotate({ to: member.id, startup_prompt: 'fresh' });
    expect(rotated.status).toBe('rotated');
    if (rotated.status !== 'rotated') return;

    gate.resolve({});
    await settle();

    const status = (await service.list({ viewer: 'main' }))[0];
    expect(status?.session_id).toBe(rotated.to_session_id);
    expect(status?.state).not.toBe('waiting_permission');
    expect(
      runtime.turns
        .filter((turn) => turn.member.session_id === rotated.to_session_id)
        .map((turn) => turn.message.content),
    ).toContain('fresh');
  });

  it('drops a pending old-body limit warning when rotating', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = async (_member, message) => (message.content === 'work' ? gate.promise : {});

    const member = await service.new({ visibility: 'team' });
    const oldSession = member.session_id;
    await service.send({ to: member.id, content: 'work' });
    service.noteMemberEvent(member.id, oldSession, warning('input_tokens'));

    const rotated = await service.rotate({ to: member.id, startup_prompt: 'fresh' });
    expect(rotated.status).toBe('rotated');
    if (rotated.status !== 'rotated') return;

    gate.resolve({});
    await settle();

    const contents = runtime.turns
      .filter((turn) => turn.member.session_id === rotated.to_session_id)
      .map((turn) => turn.message.content);
    expect(contents[0]).toBe('fresh');
    expect(contents.some((content) => content.includes('Context/usage limit warning'))).toBe(false);
  });
});
