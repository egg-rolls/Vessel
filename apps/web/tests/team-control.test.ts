import { afterEach, describe, expect, test } from 'bun:test';
import type { NodeView } from '../src/gateway/NodeProvider';
import { createRemoteTeamControl } from '../src/gateway/team-control';
import {
  fetchNodeRoster,
  filterRosterAgents,
  flattenRoster,
  type NodeRoster,
} from '../src/gateway/team-roster';
import type { TeamMember, TeamSummary } from '../src/gateway/types';

const node: NodeView = {
  name: 'alpha',
  url: 'https://alpha.example',
  nodeId: 'n-alpha',
  current: false,
};

interface Call {
  method: string;
  params: Record<string, unknown>;
  authorization: string | null;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 记录 RPC 调用；`failTeamId` 的 teams.get 返回 403。 */
function installFetch(list: TeamSummary[], failTeamId?: string): void {
  calls = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({
      method: body.method,
      params: body.params ?? {},
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    if (body.method === 'teams.list') return json({ ok: true, result: { teams: list } });
    if (body.method === 'teams.get') {
      const teamId = String(body.params.team_id);
      if (teamId === failTeamId) {
        return json({ ok: false, error: { code: 'forbidden', message: 'no' } }, 403);
      }
      return json({
        ok: true,
        result: { team: summary(teamId), members: [member(`agent-${teamId}`)], messages: [] },
      });
    }
    return json({ ok: true, result: summary(String(body.params.team_id ?? 'core')) });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function summary(teamId: string): TeamSummary {
  return { team_id: teamId, name: teamId, tenant_id: 'default', member_count: 0, created_at: 1 };
}

function member(agentId: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agent_id: agentId,
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'idle',
    ...overrides,
  };
}

describe('remote Team control contract', () => {
  test('create / update / archive use the canonical methods and params', async () => {
    installFetch([]);
    const control = createRemoteTeamControl(node, () => 'token-alpha');

    await control.createTeam({
      workspace: '/work/core',
      name: 'Core',
    });
    await control.updateTeam({ team_id: 'core', description: null, name: 'Core 2' });
    await control.archiveTeam('core');

    expect(calls.map((call) => call.method)).toEqual([
      'teams.create',
      'teams.update',
      'teams.archive',
    ]);
    expect(calls[0]?.params).toEqual({
      workspace: '/work/core',
      name: 'Core',
    });
    // null 表示清空，必须原样送到服务端，不能省略。
    expect(calls[1]?.params).toEqual({ team_id: 'core', name: 'Core 2', description: null });
    expect(calls[2]?.params).toEqual({ team_id: 'core' });
    expect(calls.every((call) => call.authorization === 'Bearer token-alpha')).toBe(true);
  });

  test('one failing team detail is counted, not silently dropped as empty', async () => {
    installFetch([summary('ok'), summary('broken')], 'broken');
    const control = createRemoteTeamControl(node, () => 'token-alpha');
    const roster = await fetchNodeRoster(node, control);

    expect(roster.ok).toBe(true);
    expect(roster.rosters.map((entry) => entry.team.team_id)).toEqual(['ok']);
    expect(roster.partialErrors).toBe(1);
  });
});

describe('roster filters', () => {
  const rosters: NodeRoster[] = [
    {
      node,
      ok: true,
      teams: [summary('core')],
      rosters: [
        {
          team: summary('core'),
          members: [
            member('agent-1', { state: 'running', presence: 'live' }),
            member('agent-2', { state: 'closed', presence: 'gone', membership: 'left' }),
          ],
        },
      ],
      partialErrors: 0,
    },
  ];
  const agents = flattenRoster(rosters);

  test('filters by node / team / state / presence together', () => {
    expect(filterRosterAgents(agents, {})).toHaveLength(2);
    expect(filterRosterAgents(agents, { nodeKey: 'n-alpha' })).toHaveLength(2);
    expect(filterRosterAgents(agents, { nodeKey: 'other' })).toHaveLength(0);
    expect(filterRosterAgents(agents, { teamId: 'core', state: 'running' })).toHaveLength(1);
    expect(filterRosterAgents(agents, { presence: 'gone' })).toHaveLength(1);
    expect(filterRosterAgents(agents, { teamId: 'nope' })).toHaveLength(0);
  });
});
