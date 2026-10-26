import { describe, expect, it } from 'bun:test';
import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel-agent/core';
import {
  type AgentEvent,
  type AgentService,
  createAgentService,
  createInProcessMemberRuntime,
  type TeamBinder,
} from '../src/index.js';
import { makeService, makeTeam, settle } from './helpers.js';

const TEAM_ID = 'alpha';

function makeBinder(...teams: ReturnType<typeof makeTeam>[]): TeamBinder {
  return {
    ensureForWorkspace: async () => {
      throw new Error('unexpected ensureForWorkspace');
    },
    get: (teamId: string) => teams.find((team) => team.team_id === teamId),
  };
}

function collect(service: AgentService): AgentEvent[] {
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));
  return events;
}

function lastRoleEvent(events: AgentEvent[]): AgentEvent | undefined {
  return events.filter((event) => event.type === 'agent.role.changed').at(-1);
}

describe('AgentService role conversion', () => {
  it('converts temporary -> member -> single -> member with owner/parent/team/visibility', async () => {
    const binder = makeBinder(makeTeam(TEAM_ID), makeTeam('beta'));
    const { service, runtime } = makeService({ teamBinder: binder });
    const events = collect(service);

    const created = await service.create({
      kind: 'contractor',
      owner: 'hirer',
      teamId: TEAM_ID,
    });
    expect(created.role).toBe('temporary');
    expect(created.owner).toBe('hirer');
    expect(created.parent_id).toBe('hirer');

    const member = await service.update({ id: created.id, role: 'member' });
    expect(member.agent.role).toBe('member');
    expect(member.agent.owner).toBe(created.id);
    expect(member.agent.parent_id).toBeUndefined();
    expect(member.agent.team_id).toBe(TEAM_ID);
    expect(member.agent.visibility).toBe('team');
    expect(lastRoleEvent(events)).toMatchObject({
      type: 'agent.role.changed',
      agent_id: created.id,
      from: 'temporary',
      to: 'member',
      owner: created.id,
      team_id: TEAM_ID,
    });

    const single = await service.update({ id: created.id, role: 'single' });
    expect(single.agent.role).toBe('single');
    expect(single.agent.owner).toBe(created.id);
    expect(single.agent.parent_id).toBeUndefined();
    expect(single.agent.team_id).toBeUndefined();
    expect(single.agent.visibility).toBe('private');
    const singleEvent = lastRoleEvent(events);
    expect(singleEvent).toMatchObject({
      from: 'member',
      to: 'single',
      owner: created.id,
    });
    expect(singleEvent?.team_id).toBeUndefined();

    const moved = await service.update({
      id: created.id,
      role: 'member',
      teamId: 'beta',
    });
    expect(moved.agent.role).toBe('member');
    expect(moved.agent.team_id).toBe('beta');
    expect(moved.agent.visibility).toBe('team');

    // 转换 notice 只追加，不启动 turn；转换也不换 Body。
    expect(runtime.turns).toHaveLength(0);
    expect(runtime.spawned).toHaveLength(1);
    expect(runtime.disposed).toHaveLength(0);
    expect(runtime.notices.at(-1)).toEqual({
      memberId: created.id,
      text: `[runtime] identity changed: single → member; owner=${created.id}; team=beta`,
    });
  });

  it('temporary conversion takes owner/parent from the converter principal', async () => {
    const binder = makeBinder(makeTeam(TEAM_ID));
    const { service } = makeService({ teamBinder: binder });
    const member = await service.create({ kind: 'peer', teamId: TEAM_ID });

    const temporary = await service.update({
      id: member.id,
      role: 'temporary',
      from: 'hirer-2',
    });

    expect(temporary.agent.role).toBe('temporary');
    expect(temporary.agent.owner).toBe('hirer-2');
    expect(temporary.agent.parent_id).toBe('hirer-2');
    expect(temporary.agent.team_id).toBe(TEAM_ID);
    expect(temporary.agent.visibility).toBe('team');
  });

  it('rejects member conversion without a team', async () => {
    const { service } = makeService();
    const unbound = await service.create({ kind: 'contractor', owner: 'hirer' });

    const error = await service
      .update({ id: unbound.id, role: 'member' })
      .catch((reason) => reason);
    expect(error).toMatchObject({ code: 'invalid_input' });
    // 失败不产生半转换：记录保持 temporary / private。
    const status = await service.identify(unbound.id);
    expect(status?.role).toBe('temporary');
    expect(status?.visibility).toBe('private');
  });
});

describe('AgentService.reinstate role mapping', () => {
  it('keeps temporary temporary and converts single to member on team add', async () => {
    const binder = makeBinder(makeTeam(TEAM_ID));
    const { service } = makeService({ teamBinder: binder });

    const temporary = await service.create({ kind: 'contractor', owner: 'hirer' });
    const reinstatedTemporary = await service.reinstate({
      to: temporary.id,
      team_id: TEAM_ID,
      from: 'hirer',
    });
    expect(reinstatedTemporary.role).toBe('temporary');
    expect(reinstatedTemporary.owner).toBe('hirer');
    expect(reinstatedTemporary.team_id).toBe(TEAM_ID);

    const solo = await service.create({ kind: 'contractor', owner: 'hirer' });
    const single = await service.update({ id: solo.id, role: 'single' });
    expect(single.agent.role).toBe('single');

    const reinstatedSingle = await service.reinstate({
      to: solo.id,
      team_id: TEAM_ID,
      from: solo.id,
    });
    expect(reinstatedSingle.role).toBe('member');
    expect(reinstatedSingle.owner).toBe(solo.id);
    expect(reinstatedSingle.parent_id).toBeUndefined();
    expect(reinstatedSingle.team_id).toBe(TEAM_ID);
    expect(reinstatedSingle.visibility).toBe('team');
  });

  it('still rejects the root owner from the roster', async () => {
    const binder = makeBinder(makeTeam(TEAM_ID));
    const { service } = makeService({ teamBinder: binder });
    await service.attachOwner({ id: 'main', sessionId: 'main' });

    const error = await service
      .reinstate({ to: 'main', team_id: TEAM_ID, from: 'main' })
      .catch((reason) => reason);
    expect(error).toMatchObject({ code: 'invalid_input' });
  });
});

describe('conversion notice reaches the next request without a turn', () => {
  it('injects the identity change notice into the next member request', async () => {
    const requests: ChatRequest[][] = [];
    const providerFactory = (): LLMProvider => {
      const captured: ChatRequest[] = [];
      requests.push(captured);
      return {
        async chat(req): Promise<LLMResponse> {
          captured.push(req);
          return { content: 'ok', finish_reason: 'stop' };
        },
      };
    };
    const runtime = createInProcessMemberRuntime({
      providerFactory,
      model: 'test-model',
    });
    const service = createAgentService({
      tenantId: 'default',
      runtime,
      teamBinder: makeBinder(makeTeam(TEAM_ID)),
    });

    const member = await service.create({
      kind: 'contractor',
      owner: 'hirer',
      teamId: TEAM_ID,
      name: 'worker',
    });

    await service.send({ to: member.id, content: 'first' });
    await settle();
    expect(requests[0]).toHaveLength(1);

    await service.update({ id: member.id, role: 'member' });
    // notice 不启动 turn。
    expect(requests[0]).toHaveLength(1);

    await service.send({ to: member.id, content: 'second' });
    await settle();

    const second = requests[0]?.[1]?.messages ?? [];
    const notice = second.find((entry) => entry.name === 'vessel:notice');
    expect(notice?.content).toContain('identity changed: temporary → member');
    expect(second.at(-1)).toMatchObject({ role: 'user', content: 'second' });
  });
});
