import { describe, expect, it } from 'bun:test';
import { AgentError, type MemberTurnResult, type NewMemberInput } from '../src/index.js';
import { type Deferred, deferred, makeService, settle } from './helpers.js';

describe('AgentService lifecycle', () => {
  it('new registers an idle member and spawns the runtime once', async () => {
    const { service, runtime } = makeService();
    const member = await service.new({ name: 'worker' });

    expect(member.state).toBe('idle');
    expect(member.session_id).toBe(member.id);
    expect(runtime.spawned.map((entry) => entry.id)).toEqual([member.id]);
  });

  it('send returns before the turn finishes and the member stays running', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });

    const sent = await service.send({ to: member.id, content: 'hi' });

    expect(sent.queued).toBe(true);
    expect(sent.state).toBe('running');
    expect(runtime.turns).toHaveLength(1);
    expect(runtime.turns[0]?.message.content).toBe('hi');

    gate.resolve({});
    await settle();
    const [status] = await service.list({ viewer: 'main' });
    expect(status?.state).toBe('completed');
  });

  it('a second send while running is queued instead of starting a second turn', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });

    await service.send({ to: member.id, content: 'first' });
    await service.send({ to: member.id, content: 'second' });
    expect(runtime.turns).toHaveLength(1);

    gate.resolve({});
    await settle();
    expect(runtime.turns.map((entry) => entry.message.content)).toEqual(['first', 'second']);
  });

  it('queued messages start in send order after the previous turn completes', async () => {
    const { service, runtime } = makeService();
    const gates: Deferred<MemberTurnResult>[] = [];
    runtime.handler = () => {
      const gate = deferred<MemberTurnResult>();
      gates.push(gate);
      return gate.promise;
    };
    const member = await service.new({ visibility: 'team' });

    await service.send({ to: member.id, content: 'a' });
    await service.send({ to: member.id, content: 'b' });
    await service.send({ to: member.id, content: 'c' });
    expect(gates).toHaveLength(1);

    gates[0]?.resolve({});
    await settle();
    expect(runtime.turns.map((entry) => entry.message.content)).toEqual(['a', 'b']);

    gates[1]?.resolve({});
    await settle();
    expect(runtime.turns.map((entry) => entry.message.content)).toEqual(['a', 'b', 'c']);
  });

  it('batch new returns per-entry results in order and keeps successful members', async () => {
    const { service, runtime } = makeService();
    const bad = { visibility: 'bogus' } as unknown as NewMemberInput;

    const result = await service.new({ members: [{ name: 'ok' }, bad, { name: 'ok-2' }] });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(runtime.spawned).toHaveLength(2);
  });

  it('batch send reports a failing entry without dropping the others', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });

    const result = await service.send({
      messages: [
        { to: member.id, content: 'a' },
        { to: 'missing', content: 'b' },
        { to: member.id, content: 'c' },
      ],
    });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    const failed = result.results[1];
    expect(failed?.ok === false ? failed.error : '').toContain('unknown_member');
    gate.resolve({});
    await settle();
  });
});

describe('AgentService close', () => {
  it('close cancels the running turn, disposes once, and stays closed after a late turn result', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'work' });

    await service.close({ member: member.id });
    await service.close({ member: member.id });

    expect(runtime.cancelled).toEqual([member.id]);
    expect(runtime.disposed).toEqual([member.id]);

    gate.resolve({ content: 'late' });
    await settle();
    const [status] = await service.list({ viewer: 'main' });
    expect(status?.state).toBe('closed');
  });

  it('send after close rejects with member_closed', async () => {
    const { service } = makeService();
    const member = await service.new({ visibility: 'team' });
    await service.close({ member: member.id });

    const error = await service.send({ to: member.id, content: 'x' }).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('member_closed');
  });

  it('batch close returns per-entry results and does not close twice', async () => {
    const { service, runtime } = makeService();
    const first = await service.new({ visibility: 'team' });
    const second = await service.new({ visibility: 'team' });

    const result = await service.close({ members: [first.id, 'missing', second.id] });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(runtime.disposed.sort()).toEqual([first.id, second.id].sort());
  });
});

describe('AgentService visibility', () => {
  it('private member is hidden from a non-owner list and cannot be addressed by another sender', async () => {
    const { service } = makeService();
    const member = await service.new({ owner: 'alice' });

    expect(await service.list({ viewer: 'bob' })).toEqual([]);
    expect(await service.list()).toEqual([]);
    expect((await service.list({ viewer: 'alice' })).map((entry) => entry.id)).toEqual([member.id]);

    const error = await service
      .send({ to: member.id, content: 'x', from: 'bob' })
      .catch((reason) => reason);
    expect((error as AgentError).code).toBe('member_not_visible');
  });

  it('team and tenant members are visible to any viewer, and visibility filters narrow the list', async () => {
    const { service } = makeService();
    await service.new({ owner: 'alice', visibility: 'team' });
    await service.new({ owner: 'alice', visibility: 'tenant' });

    expect((await service.list({ viewer: 'bob' })).map((entry) => entry.visibility)).toEqual([
      'team',
      'tenant',
    ]);
    expect(
      (await service.list({ viewer: 'bob', visibility: 'tenant' })).map(
        (entry) => entry.visibility,
      ),
    ).toEqual(['tenant']);
  });

  it('list state / parent filters exclude non-matching members', async () => {
    const { service } = makeService();
    const parent = await service.new({ visibility: 'team' });
    const child = await service.new({ visibility: 'team', parentId: parent.id });
    const other = await service.new({ visibility: 'team' });

    const children = await service.list({ viewer: 'main', parentId: parent.id, state: 'idle' });
    expect(children.map((entry) => entry.id)).toEqual([child.id]);
    expect(children.map((entry) => entry.id)).not.toContain(other.id);
  });
});

describe('AgentService replies', () => {
  it('explicit reply suppresses the automatic final text', async () => {
    const { service, runtime } = makeService();
    const parent = await service.new({ visibility: 'team' });
    const child = await service.new({ visibility: 'team', parentId: parent.id });

    runtime.handler = async (member) => {
      if (member.id === child.id) {
        await service.reply(child.id, 'explicit');
        return { content: 'auto' };
      }
      return {};
    };

    await service.send({ to: child.id, content: 'work' });
    await settle();

    const parentTurns = runtime.turns.filter((entry) => entry.member.id === parent.id);
    expect(parentTurns.map((entry) => entry.message.content)).toEqual(['explicit']);
  });

  it('automatic final text reaches the parent queue when the child does not reply', async () => {
    const { service, runtime } = makeService();
    const parent = await service.new({ visibility: 'team' });
    const child = await service.new({ visibility: 'team', parentId: parent.id });

    runtime.handler = async (member) => (member.id === child.id ? { content: 'auto' } : {});

    await service.send({ to: child.id, content: 'work' });
    await settle();

    const parentTurns = runtime.turns.filter((entry) => entry.member.id === parent.id);
    expect(parentTurns.map((entry) => entry.message.content)).toEqual(['auto']);
  });

  it('member without a parent cannot reply', async () => {
    const { service } = makeService();
    const orphan = await service.new({ visibility: 'team' });

    const error = await service.reply(orphan.id, 'hello').catch((reason) => reason);

    expect((error as AgentError).code).toBe('no_parent');
  });
});

describe('AgentService owner inbox', () => {
  it('takeMessages drains queued messages in order without starting a turn or repeating', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });

    await service.send({ to: member.id, content: 'first' });
    await service.send({ to: member.id, content: 'second' });
    await service.send({ to: member.id, content: 'third' });

    const one = await service.takeMessages(member.id, 1);
    expect(one.map((message) => message.content)).toEqual(['second']);
    const rest = await service.takeMessages(member.id);
    expect(rest.map((message) => message.content)).toEqual(['third']);
    expect(await service.takeMessages(member.id)).toEqual([]);
    // 取消息不触发 runTurn：仍只有进行中的第一轮
    expect(runtime.turns).toHaveLength(1);

    gate.resolve({});
    await settle();
    expect(runtime.turns).toHaveLength(1);
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('completed');
  });

  it('takeMessages validates limit and rejects closed / unknown members', async () => {
    const { service } = makeService();
    const member = await service.new({ visibility: 'team' });

    await expect(service.takeMessages(member.id, 0)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(service.takeMessages('missing')).rejects.toMatchObject({
      code: 'unknown_member',
    });

    await service.close({ member: member.id });
    await expect(service.takeMessages(member.id)).rejects.toMatchObject({
      code: 'member_closed',
    });
  });

  it('notePermissionState moves running -> waiting_permission -> running and ignores late states', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.new({ visibility: 'team' });
    await service.send({ to: member.id, content: 'work' });

    service.notePermissionState(member.id, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('waiting_permission');
    service.notePermissionState(member.id, 'running');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('running');

    gate.resolve({});
    await settle();
    // 终态之后的迟到回调不得把成员拉回 waiting
    service.notePermissionState(member.id, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('completed');
  });
});
