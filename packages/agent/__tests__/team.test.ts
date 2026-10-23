import { describe, expect, it } from 'bun:test';
import { type DispatchResult, TeamError } from '../src/index.js';
import { makeMember, makeTeamHarness, settle } from './helpers.js';

describe('TeamService.post', () => {
  it('writes exactly one log entry for a post without mentions and never dispatches', async () => {
    const { service, agent, store } = makeTeamHarness();

    const result = await service.post({ team_id: 'alpha', content: 'status only' });

    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]?.kind).toBe('post');
    expect(store.logs[0]?.team_id).toBe('alpha');
    expect(store.logs[0]?.content).toBe('status only');
    expect(store.logs[0]?.to).toEqual([]);
    expect(store.logs[0]?.mentions).toEqual([]);
    expect(result.delivered).toEqual([]);
    expect(result.kind).toBe('post');
    expect(agent.dispatches).toHaveLength(0);
  });

  it('dedupes mentions and isolates a failed delivery from the others and the log', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [
        makeMember({ id: 'a', name: 'a', team_id: 'alpha' }),
        makeMember({ id: 'b', name: 'b', team_id: 'alpha' }),
      ],
    });
    agent.dispatchImpl = async (input): Promise<DispatchResult> => {
      if (input.to === 'a') throw new Error('boom');
      return { status: 'queued', message_id: 'msg-b', resolved_to: 'b', resolution: 'live' };
    };

    const result = await service.post({
      team_id: 'alpha',
      content: 'go',
      mentions: ['a', 'a', 'b'],
      from: 'main',
    });

    // a 只投递一次、b 一次；失败不中止 b，也不回滚日志
    expect(agent.dispatches.map((dispatch) => dispatch.to)).toEqual(['a', 'b']);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]?.kind).toBe('mention');
    expect(store.logs[0]?.mentions).toEqual(['a', 'b']);

    const deliveryA = result.delivered.find((delivery) => delivery.agent_id === 'a');
    const deliveryB = result.delivered.find((delivery) => delivery.agent_id === 'b');
    expect(deliveryA?.status).toBe('error');
    expect(deliveryA?.reason).toBe('boom');
    expect(deliveryB?.status).toBe('queued');
    expect(deliveryB?.message_id).toBe('msg-b');
  });
});

describe('TeamService.members', () => {
  it('remove archives without deleting history; add reinstates without a new session', async () => {
    const { service, agent } = makeTeamHarness({
      members: [makeMember({ id: 'b', name: 'bob', team_id: 'alpha', session_id: 'session-b' })],
    });

    const removed = await service.members({
      team_id: 'alpha',
      action: 'remove',
      member: 'bob',
    });

    expect(removed).toEqual({
      team_id: 'alpha',
      action: 'remove',
      agent_id: 'b',
      membership: 'left',
    });
    expect(agent.closes).toEqual(['b']);
    const archived = agent.members.find((member) => member.id === 'b');
    expect(archived).toBeDefined();
    expect(archived?.session_id).toBe('session-b');
    expect(archived?.team_id).toBe('alpha');
    expect(archived?.membership).toBe('left');

    agent.members.push(makeMember({ id: 'c', name: 'carol', session_id: 'session-c' }));
    const added = await service.members({ team_id: 'alpha', action: 'add', member: 'carol' });

    expect(agent.reinstates).toHaveLength(1);
    expect(agent.reinstates[0]?.to).toBe('c');
    expect(agent.reinstates[0]?.team_id).toBe('alpha');
    expect(agent.dispatches).toHaveLength(0);
    const target = agent.members.find((member) => member.id === 'c');
    expect(target?.session_id).toBe('session-c');
    expect(target?.membership).toBe('present');
    expect(added?.membership).toBe('present');
  });
});

describe('TeamService system messages', () => {
  it('writes only for team-bound events and distinguishes archive from leave', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [makeMember({ id: 'a1', name: 'a1', team_id: 'alpha' })],
    });

    agent.emit({ type: 'agent.spawned', agent_id: 'a1', team_id: 'alpha', ts: 1 });
    agent.emit({ type: 'agent.spawned', agent_id: 'unbound', ts: 2 });
    agent.emit({ type: 'agent.rejoined', agent_id: 'unbound-2', ts: 3 });
    agent.emit({ type: 'agent.rotated', agent_id: 'a1', team_id: 'alpha', ts: 4 });
    await settle();

    // members remove 期间 agent.closed 应写成 archive；其余 closed 是 leave。
    await service.members({ team_id: 'alpha', action: 'remove', member: 'a1' });
    await settle();
    agent.emit({ type: 'agent.closed', agent_id: 'other', team_id: 'alpha', ts: 5 });
    await settle();

    const system = store.logs.filter((log) => log.kind === 'system');
    expect(system.map((log) => log.system_event)).toEqual(['join', 'rotate', 'archive', 'leave']);
    expect(system.map((log) => log.content)).toEqual([
      'agent joined team',
      'agent rotated body',
      'agent archived',
      'agent left team',
    ]);
    expect(system.every((log) => log.from === 'system')).toBe(true);
    expect(system.every((log) => log.to.length === 1)).toBe(true);
    expect(store.logs.every((log) => log.team_id === 'alpha')).toBe(true);
  });
});

describe('TeamService.send / listForCaller', () => {
  it('logs same-team sends, dispatches cross-team without a log, and scopes member list', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [
        makeMember({ id: 'a', name: 'alice', team_id: 'alpha', session_id: 'session-a' }),
        makeMember({ id: 'b', name: 'bob', team_id: 'alpha', session_id: 'session-b' }),
        makeMember({ id: 'c', name: 'carol', team_id: 'beta', session_id: 'session-c' }),
        makeMember({ id: 'd', name: 'dave', session_id: 'session-d' }),
      ],
    });

    const sameTeam = await service.send({
      from_session_id: 'session-a',
      to: 'bob',
      content: 'hi bob',
    });
    expect(sameTeam.status).toBe('queued');
    expect(sameTeam.logged).toBe(true);
    expect(sameTeam.resolved_to).toBe('b');
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      team_id: 'alpha',
      from: 'a',
      to: ['b'],
      mentions: ['b'],
      kind: 'mention',
    });

    // 有 Team 的调用者：name 只在同 Team roster 内解析；跨 Team 名字不解析。
    const crossTeamName = await service.send({
      from_session_id: 'session-a',
      to: 'carol',
      content: 'hi carol',
    });
    expect(crossTeamName.status).toBe('error');
    expect(crossTeamName.code).toBe('unknown_member');
    expect(store.logs).toHaveLength(1);

    const direct = await service.send({
      from_session_id: 'session-a',
      to: 'c',
      content: 'direct',
    });
    expect(direct.logged).toBe(false);
    expect(direct.resolved_to).toBe('c');

    const noTeam = await service.send({
      from_session_id: 'session-d',
      to: 'a',
      content: 'from dave',
    });
    expect(noTeam.status).toBe('queued');
    expect(noTeam.logged).toBe(false);

    expect(agent.dispatches.map((dispatch) => dispatch.from)).toEqual(['a', 'a', 'd']);
    // 同 Team name 解析为 id；跨 Team 只接受 id / session（按 id 直接 dispatch）。
    expect(agent.dispatches.map((dispatch) => dispatch.to)).toEqual(['b', 'c', 'a']);

    const alphaRoster = await service.listForCaller('session-a');
    expect(alphaRoster.map((member) => member.agent_id).sort()).toEqual(['a', 'b']);
    const unboundRoster = await service.listForCaller('session-d');
    expect(unboundRoster.map((member) => member.agent_id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('TeamService log write failure', () => {
  it('fails post and send with zero dispatch calls when appendLog throws', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [
        makeMember({ id: 'a', team_id: 'alpha' }),
        makeMember({ id: 'b', team_id: 'alpha', session_id: 'session-b' }),
      ],
    });
    store.appendError = new Error('disk full');

    let postError: unknown;
    try {
      await service.post({ team_id: 'alpha', content: 'go', mentions: ['a'] });
    } catch (error) {
      postError = error;
    }
    expect(postError).toBeInstanceOf(TeamError);
    expect((postError as TeamError).code).toBe('team_log_write_failed');
    expect(agent.dispatches).toHaveLength(0);

    const sent = await service.send({
      from_session_id: 'a',
      to: 'b',
      content: 'hello',
    });
    expect(sent.status).toBe('error');
    expect(sent.code).toBe('team_log_write_failed');
    expect(sent.logged).toBe(false);
    expect(agent.dispatches).toHaveLength(0);
  });
});
