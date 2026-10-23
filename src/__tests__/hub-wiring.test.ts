import { describe, expect, it } from 'bun:test';
import type { AgentEvent, AgentService, ListFilter, MemberStatus } from '@vessel-agent/agent';
import {
  HUB_MAX_AGENTS,
  HUB_MAX_TEAMS,
  type HubControlChange,
} from '../../packages/serve/src/index';
import { createHubControl, createTeamScope, type HubTeamSourceLike } from '../hub-wiring';

/** fake 成员：只有投影读取的字段是必需语义，其余字段原样存在用于验证不透传。 */
interface FakeMember extends Record<string, unknown> {
  id: string;
  session_id: string;
}

function createFakeService(members: FakeMember[]) {
  let listener: ((event: AgentEvent) => void) | undefined;
  const filters: ListFilter[] = [];
  const service = {
    async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
      filters.push(filter);
      return members as unknown as MemberStatus[];
    },
    subscribe(next: (event: AgentEvent) => void): () => void {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    service: service as unknown as AgentService,
    filters,
    emit(event: AgentEvent): void {
      listener?.(event);
    },
    hasListener(): boolean {
      return listener !== undefined;
    },
  };
}

/** 让后台 refresh（service.list 的微任务）完成。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('createHubControl.snapshot', () => {
  it('projects only whitelisted agent fields', async () => {
    const { service } = createFakeService([
      {
        id: 'a1',
        session_id: 'session-secret-1',
        name: 'Alpha',
        team_id: 't1',
        membership: 'present',
        presence: 'live',
        epoch: 2,
        model: 'model-secret',
        system_prompt: 'prompt-secret',
        content: 'content-secret',
        workspace: '/workspace-secret',
        current_tool: 'bash',
        usage: { inputTokens: 1 },
      },
      { id: 'a2', session_id: 'session-secret-2', name: 'Beta', team_id: 't1', membership: 'left' },
    ]);
    const hub = createHubControl({ service, now: () => 1000 });

    const snapshot = await hub.snapshot('tenant-a');

    expect(snapshot.counts).toEqual({ teams: 0, agents: 2, live_agents: 1 });
    expect(snapshot.teams).toEqual([]);
    expect(snapshot.truncated).toBe(false);
    const [first] = snapshot.agents;
    if (first === undefined) throw new Error('expected an agent projection');
    expect(Object.keys(first).sort()).toEqual([
      'agent_id',
      'epoch',
      'membership',
      'name',
      'presence',
      'team_id',
    ]);
    for (const secret of [
      'session-secret',
      'model-secret',
      'prompt-secret',
      'content-secret',
      'workspace-secret',
      'current_tool',
      'usage',
    ]) {
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }
  });

  it('drops unbound members and keeps left members with input presence', async () => {
    const { service } = createFakeService([
      { id: 'bound', session_id: 's1', team_id: 't1' },
      { id: 'left-member', session_id: 's2', team_id: 't1', membership: 'left', presence: 'live' },
      { id: 'unbound', session_id: 's3' },
    ]);
    const hub = createHubControl({ service });

    const snapshot = await hub.snapshot('tenant-a');

    expect(snapshot.agents.map((agent) => agent.agent_id)).toEqual(['bound', 'left-member']);
    expect(snapshot.agents[0]).toMatchObject({ membership: 'present', presence: 'gone' });
    expect(snapshot.agents[1]).toMatchObject({ membership: 'left', presence: 'live' });
    expect(snapshot.counts.agents).toBe(2);
  });

  it('truncates teams and agents while keeping full counts', async () => {
    const members: FakeMember[] = Array.from({ length: HUB_MAX_AGENTS + 1 }, (_, index) => ({
      id: `a${index}`,
      session_id: `s${index}`,
      team_id: 't1',
    }));
    const teamSource: HubTeamSourceLike = {
      list: async () =>
        Array.from({ length: HUB_MAX_TEAMS + 1 }, (_, index) => ({
          team_id: `t${index}`,
          name: `Team ${index}`,
        })),
    };
    const { service } = createFakeService(members);
    const hub = createHubControl({ service, teamSource });

    const snapshot = await hub.snapshot('tenant-a');

    expect(snapshot.agents).toHaveLength(HUB_MAX_AGENTS);
    expect(snapshot.teams).toHaveLength(HUB_MAX_TEAMS);
    expect(snapshot.counts).toEqual({
      teams: HUB_MAX_TEAMS + 1,
      agents: HUB_MAX_AGENTS + 1,
      live_agents: 0,
    });
    expect(snapshot.truncated).toBe(true);
  });

  it('projects team metadata from an optional teamSource and tracks last_active', async () => {
    let teamListener: ((event: unknown) => void) | undefined;
    const teamSource: HubTeamSourceLike = {
      list: async () => [
        {
          team_id: 't1',
          name: 'Team One',
          member_count: 3,
          agent_count: 2,
          messages: ['do-not-project'],
        },
      ],
      subscribe(next) {
        teamListener = next;
        return () => {
          teamListener = undefined;
        };
      },
    };
    const { service } = createFakeService([{ id: 'a1', session_id: 's1', team_id: 't1' }]);
    const hub = createHubControl({ service, teamSource, now: () => 1234 });

    const before = await hub.snapshot('tenant-a');
    expect(before.teams).toEqual([
      { team_id: 't1', name: 'Team One', member_count: 3, agent_count: 2 },
    ]);

    const changes: HubControlChange[] = [];
    hub.subscribe('tenant-a', (change) => changes.push(change));
    await flushMicrotasks();
    teamListener?.({ type: 'team.message', team_id: 't1' });

    expect(changes).toEqual([{ pointers: [{ team_id: 't1', reason: 'team.message', ts: 1234 }] }]);
    const after = await hub.snapshot('tenant-a');
    expect(after.teams[0]?.last_active).toBe(1234);
  });
});

describe('createHubControl.subscribe', () => {
  it('maps agent lifecycle events to directoryChanged and agent.state pointers', async () => {
    const { service, emit } = createFakeService([
      { id: 'a1', session_id: 's1', team_id: 't1' },
      { id: 'a2', session_id: 's2', team_id: 't2' },
    ]);
    const hub = createHubControl({ service, now: () => 1000 });
    const changes: HubControlChange[] = [];

    const unsubscribe = hub.subscribe('tenant-a', (change) => changes.push(change));
    await flushMicrotasks();

    emit({ type: 'agent.spawned', agent_id: 'a1', ts: 1 });
    expect(changes).toEqual([
      {
        directoryChanged: true,
        pointers: [{ team_id: 't1', reason: 'agent.state', ts: 1000 }],
      },
    ]);

    for (const type of [
      'agent.resumed',
      'agent.closed',
      'agent.rotated',
      'agent.rejoined',
      'agent.retired',
    ]) {
      emit({ type, agent_id: 'a2', ts: 2 });
    }
    expect(changes).toHaveLength(6);
    expect(changes.slice(1).every((change) => change.pointers?.[0]?.team_id === 't2')).toBe(true);

    emit({ type: 'agent.message.queued', agent_id: 'a1', ts: 3 });
    expect(changes).toHaveLength(6);

    unsubscribe();
    emit({ type: 'agent.closed', agent_id: 'a1', ts: 4 });
    expect(changes).toHaveLength(6);
  });

  it('emits directoryChanged without a pointer for unresolved teams', async () => {
    const { service, emit } = createFakeService([
      { id: 'a1', session_id: 's1', team_id: 't1' },
      { id: 'unbound', session_id: 's2' },
    ]);
    const hub = createHubControl({ service, now: () => 2000 });
    const changes: HubControlChange[] = [];

    hub.subscribe('tenant-a', (change) => changes.push(change));
    await flushMicrotasks();

    emit({ type: 'agent.closed', agent_id: 'unknown-agent', ts: 1 });
    emit({ type: 'agent.closed', agent_id: 'unbound', ts: 2 });

    expect(changes).toEqual([{ directoryChanged: true }, { directoryChanged: true }]);
  });
});

describe('createTeamScope', () => {
  it('maps current, current-body and retired-body sessions; unknown is undefined', async () => {
    const { service } = createFakeService([
      { id: 'a1', session_id: 's-current', team_id: 't1' },
      {
        id: 'a2',
        session_id: 's-base',
        team_id: 't2',
        current_body: { session_id: 's-body' },
        body_history: [{ session_id: 's-retired' }],
      },
      { id: 'a3', session_id: 's-unbound' },
    ]);
    const scope = createTeamScope({ service });
    await flushMicrotasks();

    expect(scope.teamForSession('s-current')).toBe('t1');
    expect(scope.teamForSession('s-body')).toBe('t2');
    expect(scope.teamForSession('s-retired')).toBe('t2');
    expect(scope.teamForSession('s-unbound')).toBeUndefined();
    expect(scope.teamForSession('missing')).toBeUndefined();
  });
});
