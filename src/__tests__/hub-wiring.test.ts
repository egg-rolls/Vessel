import { describe, expect, it } from 'bun:test';
import {
  type AgentEvent,
  type AgentService,
  type CloseInput,
  createTeamService,
  type DispatchInput,
  type ListFilter,
  type MemberStatus,
  type ReinstateInput,
  type TeamLogEntry,
  type TeamRecord,
  type TeamStore,
} from '@vessel-agent/agent';
import type { TeamPolicy } from '@vessel-agent/config';
import {
  HUB_MAX_AGENTS,
  HUB_MAX_TEAMS,
  type HubControlChange,
} from '../../packages/serve/src/index';
import {
  createHubControl,
  createTeamScope,
  type HubTeamEventLike,
  type HubTeamSourceLike,
} from '../hub-wiring';

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
    let teamListener: ((event: HubTeamEventLike) => void) | undefined;
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
    teamListener?.({ kind: 'post', team_id: 't1' });

    // message_id 作为 request_id；正文 / body_history 绝不进入指针。
    teamListener?.({
      kind: 'post',
      team_id: 't1',
      message_id: 'm1',
      content: 'secret-body',
      body_history: [{ session_id: 's1', content: 'secret-body' }],
    } as HubTeamEventLike);
    expect(changes.at(-1)).toEqual({
      pointers: [{ team_id: 't1', reason: 'team.message', ts: 1234, request_id: 'm1' }],
    });
    expect(JSON.stringify(changes)).not.toContain('secret-body');
    const after = await hub.snapshot('tenant-a');
    expect(after.teams[0]?.last_active).toBe(1234);
  });

  it('passes through online_count and computes it from present + live agents', async () => {
    const teamSource: HubTeamSourceLike = {
      list: async () => [
        {
          team_id: 't1',
          name: 'Team One',
          member_count: 3,
          agent_count: 2,
          online_count: 7,
        },
        {
          team_id: 't2',
          name: 'Team Two',
          member_count: 2,
          agent_count: 1,
          online_count: 5,
        },
      ],
    };
    const { service } = createFakeService([
      { id: 'a1', session_id: 's1', team_id: 't1', membership: 'present', presence: 'live' },
      { id: 'a2', session_id: 's2', team_id: 't1', membership: 'left', presence: 'live' },
    ]);
    const hub = createHubControl({ service, teamSource });

    const snapshot = await hub.snapshot('tenant-a');
    const t1 = snapshot.teams.find((team) => team.team_id === 't1');
    const t2 = snapshot.teams.find((team) => team.team_id === 't2');
    expect(t1?.online_count).toBe(1);
    expect(t2?.online_count).toBe(5);
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

describe('createHubControl with a real TeamService', () => {
  function makeTeamFixture() {
    const listeners = new Set<(event: AgentEvent) => void>();
    const members: MemberStatus[] = [
      {
        id: 'a1',
        session_id: 'a1',
        owner: 'main',
        visibility: 'team',
        state: 'idle',
        membership: 'present',
        presence: 'live',
        team_id: 'alpha',
      },
    ];
    const record: TeamRecord = {
      v: 1,
      team_id: 'alpha',
      name: 'alpha',
      tenant_id: 'default',
      workspace: '/ws/alpha',
      policy: {},
      created_at: 1,
    };
    const store: TeamStore = {
      async ensureForWorkspace() {
        return record;
      },
      async seed() {},
      get(teamId: string) {
        return teamId === 'alpha' ? record : undefined;
      },
      policy(teamId: string): TeamPolicy | undefined {
        return teamId === 'alpha' ? (record.policy as TeamPolicy) : undefined;
      },
      list() {
        return [record];
      },
      async readLog(): Promise<TeamLogEntry[]> {
        return [];
      },
      async appendLog(_entry: TeamLogEntry) {},
      async flush() {},
    };
    let dispatchCount = 0;
    const agent = {
      async list(_filter: ListFilter = {}) {
        return members;
      },
      async identify(_id: string) {
        return undefined;
      },
      async dispatch(input: DispatchInput) {
        dispatchCount += 1;
        return {
          status: 'queued' as const,
          message_id: `d-${dispatchCount}`,
          resolved_to: input.to,
          resolution: 'live' as const,
        };
      },
      async reinstate(input: ReinstateInput) {
        const target = members.find((member) => member.id === input.to);
        if (target === undefined) throw new Error(`unknown_member: ${input.to}`);
        target.team_id = input.team_id;
        target.membership = 'present';
        return target;
      },
      async close(input: CloseInput) {
        const id = input.member ?? input.to;
        const target = members.find((member) => member.id === id);
        if (target !== undefined) {
          target.membership = 'left';
          target.state = 'closed';
          target.presence = 'gone';
        }
        return { state: 'closed' as const };
      },
      subscribe(listener: (event: AgentEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const service = agent as unknown as AgentService;
    const teamService = createTeamService({ tenantId: 'default', agent: service, store });
    return {
      service,
      teamService,
      emit(event: AgentEvent): void {
        for (const listener of [...listeners]) listener(event);
      },
    };
  }

  it('maps real post / reply / roster events to content-free hub pointers', async () => {
    const { service, teamService, emit } = makeTeamFixture();
    const hub = createHubControl({ service, teamSource: teamService, now: () => 5000 });
    const changes: HubControlChange[] = [];
    const unsubscribe = hub.subscribe('tenant-a', (change) => changes.push(change));
    await flushMicrotasks();

    const posted = await teamService.post({ team_id: 'alpha', content: 'SECRET-BODY' });
    const pointers = (): NonNullable<HubControlChange['pointers']> =>
      changes.flatMap((change) => change.pointers ?? []);
    expect(
      pointers().filter(
        (pointer) => pointer.reason === 'team.message' && pointer.request_id === posted.message_id,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(changes)).not.toContain('SECRET-BODY');

    emit({
      type: 'agent.reply.posted',
      agent_id: 'a1',
      session_id: 'a1',
      team_id: 'alpha',
      visibility: 'team',
      message_id: 'm-reply',
      content: 'SECRET-REPLY',
      ts: 10,
    });
    await flushMicrotasks();
    expect(
      pointers().some(
        (pointer) => pointer.reason === 'team.message' && pointer.request_id === 'm-reply',
      ),
    ).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('SECRET-REPLY');

    const before = changes.length;
    await teamService.members({ team_id: 'alpha', action: 'remove', member: 'a1' });
    expect(changes.slice(before).some((change) => change.directoryChanged === true)).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('SECRET-REPLY');

    unsubscribe();
    teamService.dispose();
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
