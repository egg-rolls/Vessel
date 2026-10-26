import { describe, expect, it } from 'bun:test';
import {
  AgentError,
  type AgentEvent,
  type CreateMemberInput,
  createAgentService,
  type MemberRuntimePort,
  type MemberTurnResult,
} from '../src/index.js';
import { type Deferred, deferred, makeService, settle } from './helpers.js';

describe('AgentService lifecycle', () => {
  it('create registers an idle member and spawns the runtime once', async () => {
    const { service, runtime } = makeService();
    const member = await service.create({ name: 'worker' });

    expect(member.state).toBe('idle');
    expect(member.session_id).toBe(member.id);
    expect(runtime.spawned.map((entry) => entry.id)).toEqual([member.id]);
  });

  it('send returns before the turn finishes and the member stays running', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.create({ visibility: 'team' });

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
    const member = await service.create({ visibility: 'team' });

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
    const member = await service.create({ visibility: 'team' });

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

  it('batch create returns per-entry results in order and keeps successful members', async () => {
    const { service, runtime } = makeService();
    const bad = { visibility: 'bogus' } as unknown as CreateMemberInput;

    const result = await service.create({ members: [{ name: 'ok' }, bad, { name: 'ok-2' }] });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(runtime.spawned).toHaveLength(2);
  });

  it('batch send reports a failing entry without dropping the others', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.create({ visibility: 'team' });

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
    const member = await service.create({ visibility: 'team' });
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
    const member = await service.create({ visibility: 'team' });
    await service.close({ member: member.id });

    const error = await service.send({ to: member.id, content: 'x' }).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('member_closed');
  });

  it('batch close returns per-entry results and does not close twice', async () => {
    const { service, runtime } = makeService();
    const first = await service.create({ visibility: 'team' });
    const second = await service.create({ visibility: 'team' });

    const result = await service.close({ members: [first.id, 'missing', second.id] });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(runtime.disposed.sort()).toEqual([first.id, second.id].sort());
  });
});

describe('AgentService visibility', () => {
  it('private member is hidden from a non-owner list and cannot be addressed by another sender', async () => {
    const { service } = makeService();
    const member = await service.create({ owner: 'alice' });

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
    await service.create({ owner: 'alice', visibility: 'team' });
    await service.create({ owner: 'alice', visibility: 'tenant' });

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
    const parent = await service.create({ visibility: 'team' });
    const child = await service.create({ visibility: 'team', parentId: parent.id });
    const other = await service.create({ visibility: 'team' });

    const children = await service.list({ viewer: 'main', parentId: parent.id, state: 'idle' });
    expect(children.map((entry) => entry.id)).toEqual([child.id]);
    expect(children.map((entry) => entry.id)).not.toContain(other.id);
  });
});

describe('AgentService message source', () => {
  it('labels federation senders as agent, not human', async () => {
    const { service, runtime } = makeService();
    const member = await service.create({ visibility: 'team' });

    await service.send({
      to: member.id,
      content: 'remote',
      from: 'federation:human@RemoteNode:RemoteTeam',
    });
    await settle();

    expect(runtime.turns[0]?.message.source).toBe('agent');
  });

  it('still labels unregistered local principals as human', async () => {
    const { service, runtime } = makeService();
    const member = await service.create({ visibility: 'team' });

    await service.send({ to: member.id, content: 'local', from: 'stranger' });
    await settle();

    expect(runtime.turns[0]?.message.source).toBe('human');
  });
});

describe('AgentService replies', () => {
  it('explicit reply suppresses the automatic final text', async () => {
    const { service, runtime } = makeService();
    const parent = await service.create({ visibility: 'team' });
    const child = await service.create({ visibility: 'team', parentId: parent.id });

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
    const parent = await service.create({ visibility: 'team' });
    const child = await service.create({ visibility: 'team', parentId: parent.id });

    runtime.handler = async (member) => (member.id === child.id ? { content: 'auto' } : {});

    await service.send({ to: child.id, content: 'work' });
    await settle();

    const parentTurns = runtime.turns.filter((entry) => entry.member.id === parent.id);
    expect(parentTurns.map((entry) => entry.message.content)).toEqual(['auto']);
  });

  it('member without a parent cannot reply', async () => {
    const { service } = makeService();
    const orphan = await service.create({ visibility: 'team' });

    const error = await service.reply(orphan.id, 'hello').catch((reason) => reason);

    expect((error as AgentError).code).toBe('no_parent');
  });
});

describe('AgentService conversation propagation', () => {
  it('generates an id at the human entry and carries it into queued / turn events', async () => {
    const { service, runtime } = makeService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const member = await service.create({ visibility: 'team' });

    const dispatched = await service.dispatch({ to: member.id, content: 'hi' });
    expect(dispatched.status).toBe('queued');
    const conversationId = dispatched.status === 'queued' ? dispatched.conversation_id : undefined;
    expect(conversationId).toMatch(/^conv_/);
    expect(events.find((event) => event.type === 'agent.message.queued')?.conversation_id).toBe(
      conversationId,
    );
    expect(events.find((event) => event.type === 'agent.turn.started')?.conversation_id).toBe(
      conversationId,
    );
    await settle();
    expect(runtime.turns[0]?.message.conversation_id).toBe(conversationId);
  });

  it('rejects an invalid explicit conversation id', async () => {
    const { service } = makeService();
    const member = await service.create({ visibility: 'team' });

    await expect(
      service.send({ to: member.id, content: 'x', conversation_id: 'bad id' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reply inherits the running turn conversation', async () => {
    const { service, runtime } = makeService();
    const parent = await service.create({ visibility: 'team' });
    const child = await service.create({ visibility: 'team', parentId: parent.id });
    runtime.handler = async (current) => {
      if (current.id === child.id) {
        await service.reply(child.id, 'explicit');
        return {};
      }
      return {};
    };

    await service.send({
      to: child.id,
      content: 'work',
      conversation_id: 'conv_reply',
    });
    await settle();

    const parentTurn = runtime.turns.find((entry) => entry.member.id === parent.id);
    expect(parentTurn?.message.conversation_id).toBe('conv_reply');
  });

  it('rotate startup inherits the triggering turn conversation', async () => {
    const { service, runtime } = makeService();
    const member = await service.create({ visibility: 'team' });
    let rotated = false;
    runtime.handler = async (current) => {
      if (current.id === member.id && !rotated) {
        rotated = true;
        await service.rotate({
          to: member.id,
          startup_prompt: 'fresh',
          from_session_id: current.session_id,
        });
      }
      return {};
    };

    await service.send({
      to: member.id,
      content: 'work',
      conversation_id: 'conv_rotate',
    });
    await settle();

    const startupTurn = runtime.turns.find((entry) => entry.message.content.startsWith('fresh'));
    expect(startupTurn).toBeDefined();
    expect(startupTurn?.message.conversation_id).toBe('conv_rotate');
  });
});

describe('AgentService owner inbox', () => {
  it('takeMessages drains queued messages in order without starting a turn or repeating', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.create({ visibility: 'team' });

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
    const member = await service.create({ visibility: 'team' });

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

  it('external owner queue is never pumped and only leaves through takeMessages', async () => {
    const { service, runtime } = makeService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const owner = await service.attachOwner({ id: 'main' });
    const member = await service.create({ visibility: 'team', parentId: owner.id });
    runtime.handler = async (target) =>
      target.id === member.id ? { content: 'auto' } : { content: 'owner-should-not-run' };

    await service.send({ to: owner.id, content: 'direct' });
    // owner 是 external：send 只入队，runTurn 一次都不跑
    expect(runtime.turns).toHaveLength(0);
    expect(
      (await service.list({ viewer: 'main' })).find((entry) => entry.id === owner.id)?.state,
    ).toBe('idle');
    expect(
      events.some(
        (event) =>
          event.type === 'agent.message.queued' &&
          event.agent_id === owner.id &&
          event.from === 'main',
      ),
    ).toBe(true);

    // 成员自动回复也进 owner 队列，pump 不得消费
    await service.send({ to: member.id, content: 'work' });
    await settle();
    expect(runtime.turns.map((entry) => entry.member.id)).toEqual([member.id]);

    const taken = await service.takeMessages(owner.id);
    expect(taken.map((message) => message.content)).toEqual(['direct', 'auto']);
    expect(await service.takeMessages(owner.id)).toEqual([]);
    // 再触发 pump（新消息入队）也不会把 owner 队列交给 runtime
    await service.send({ to: owner.id, content: 'again' });
    expect(runtime.turns.map((entry) => entry.member.id)).toEqual([member.id]);
    expect((await service.takeMessages(owner.id)).map((message) => message.content)).toEqual([
      'again',
    ]);
  });

  it('hasMember is true for private member sessions and false for the external owner session', async () => {
    const { service } = makeService();
    const member = await service.create({ visibility: 'private' });

    expect(await service.hasMember(member.session_id)).toBe(true);

    await service.attachOwner({ id: 'main', sessionId: 'session-parent' });
    expect(await service.hasMember('session-parent')).toBe(false);
    expect(await service.hasMember('main')).toBe(false);
    expect(await service.hasMember('missing')).toBe(false);
  });

  it('notePermissionState moves running -> waiting_permission -> running and ignores late states', async () => {
    const { service, runtime } = makeService();
    const gate = deferred<MemberTurnResult>();
    runtime.handler = () => gate.promise;
    const member = await service.create({ visibility: 'team' });
    await service.send({ to: member.id, content: 'work' });

    service.notePermissionState(member.id, member.session_id, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('waiting_permission');
    service.notePermissionState(member.id, member.session_id, 'running');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('running');

    gate.resolve({});
    await settle();
    // 终态之后的迟到回调不得把成员拉回 waiting
    service.notePermissionState(member.id, member.session_id, 'waiting');
    expect((await service.list({ viewer: 'main' }))[0]?.state).toBe('completed');
  });
});

describe('AgentService update (0.25)', () => {
  it('renames immediately, keeps names unique and emits field names only', async () => {
    const { service } = makeService();
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    const first = await service.create({ name: 'alpha' });
    await service.create({ name: 'beta' });

    const duplicate = await service
      .update({ id: first.id, name: 'beta' })
      .catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(AgentError);
    expect((duplicate as AgentError).code).toBe('invalid_input');

    const updated = await service.update({
      id: first.id,
      name: 'gamma',
      model: 'model-2',
      systemPrompt: 'prompt-secret',
    });
    expect(updated.agent.name).toBe('gamma');
    expect(updated.changed).toEqual(['name', 'model', 'system_prompt']);
    expect(updated.applies_to).toBe('next_body');

    const event = events.find((entry) => entry.type === 'agent.updated');
    expect(event).toMatchObject({
      agent_id: first.id,
      changed: ['name', 'model', 'system_prompt'],
    });
    expect(JSON.stringify(event)).not.toContain('prompt-secret');
  });

  it('does not touch the running body; new model applies to the next spawned Body', async () => {
    const { service, runtime } = makeService();
    const member = await service.create({ model: 'model-old', systemPrompt: 'prompt-old' });
    expect(runtime.spawned[0]?.model).toBe('model-old');

    const updated = await service.update({
      id: member.id,
      model: 'model-new',
      systemPrompt: 'prompt-new',
    });
    expect(updated.applies_to).toBe('next_body');
    expect(runtime.spawned).toHaveLength(1);
    expect(runtime.spawned[0]?.model).toBe('model-old');
    expect(runtime.spawned[0]?.system_prompt).toBe('prompt-old');

    const rotated = await service.rotate({ to: member.id, startup_prompt: 'hello' });
    expect(rotated.status).toBe('rotated');
    expect(runtime.spawned).toHaveLength(2);
    expect(runtime.spawned[1]?.model).toBe('model-new');
    expect(runtime.spawned[1]?.system_prompt).toBe('prompt-new');
  });

  it('batch update keeps input order and applies successful entries', async () => {
    const { service } = makeService();
    const first = await service.create({ name: 'first' });
    const second = await service.create({ name: 'second' });

    const result = await service.update({
      updates: [
        { id: first.id, name: 'first-renamed' },
        { id: 'missing', name: 'nope' },
        { id: second.id, model: 'model-2' },
      ],
    });

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    const failed = result.results[1];
    expect(failed?.ok === false ? failed.code : undefined).toBe('unknown_member');
    const renamed = result.results[0];
    expect(renamed?.ok ? renamed.status.agent.name : undefined).toBe('first-renamed');
    const statuses = await service.list({ viewer: 'main' });
    expect(statuses.find((entry) => entry.id === first.id)?.name).toBe('first-renamed');
  });
});

describe('AgentService.applyPermissionRules（CONTRACT-hot-apply §4）', () => {
  it('forwards the rules to the execution kernel and counts applied bodies', async () => {
    const { service, runtime } = makeService();
    await service.create({ name: 'worker' });

    const applied = await service.applyPermissionRules({
      default: 'ask',
      autoApprove: ['bash'],
      neverAutoApprove: ['agent.close'],
    });

    expect(applied).toBe(1);
    expect(runtime.appliedPermissionRules).toEqual([
      { default: 'ask', autoApprove: ['bash'], neverAutoApprove: ['agent.close'] },
    ]);
  });

  it('returns 0 when the kernel does not support hot rules', async () => {
    const runtime: MemberRuntimePort = {
      spawn: async () => {},
      runTurn: async () => ({}),
      cancel: () => {},
      dispose: () => {},
    };
    const service = createAgentService({ tenantId: 'default', runtime });
    expect(await service.applyPermissionRules({ default: 'ask' })).toBe(0);
  });

  it('a kernel failure is logged and does not throw', async () => {
    const runtime = {
      spawn: async () => {},
      runTurn: async () => ({}),
      cancel: () => {},
      dispose: () => {},
      applyPermissionRules: async (): Promise<number> => {
        throw new Error('kernel exploded');
      },
    } satisfies MemberRuntimePort;
    const service = createAgentService({ tenantId: 'default', runtime });
    expect(await service.applyPermissionRules({ default: 'ask' })).toBe(0);
  });
});
