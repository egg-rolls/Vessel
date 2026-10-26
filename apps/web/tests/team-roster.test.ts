import { describe, expect, test } from 'bun:test';
import type { NodeView } from '../src/gateway/NodeProvider';
import type { TeamControl } from '../src/gateway/team-control';
import {
  fetchNodeRoster,
  filterRosterAgents,
  flattenRoster,
  mergeNodeRosters,
  type NodeRoster,
} from '../src/gateway/team-roster';
import type { AgentSummary, TeamMember, TeamSummary } from '../src/gateway/types';

const node: NodeView = { name: 'node-a', url: 'http://node-a.test', current: true };

const team: TeamSummary = {
  team_id: 'team-1',
  name: 'Team One',
  tenant_id: 'default',
  member_count: 1,
  created_at: 1,
};

const member: TeamMember = {
  agent_id: 'agent-1',
  name: 'Agent One',
  membership: 'present',
  presence: 'live',
  visibility: 'team',
};

function roster(overrides: Partial<NodeRoster> = {}): NodeRoster {
  return {
    node,
    ok: true,
    teams: [team],
    rosters: [{ team, members: [member] }],
    partialErrors: 0,
    ...overrides,
  };
}

const listedSingle: AgentSummary = {
  id: 'solo-1',
  name: 'Solo',
  role: 'single',
  owner: 'solo-1',
  visibility: 'private',
  state: 'idle',
  presence: 'live',
  membership: 'present',
  session_id: 'solo-session',
};

function control(overrides: Partial<TeamControl> = {}): TeamControl {
  return {
    listTeams: async () => [team],
    getTeam: async () => ({ team, members: [member], messages: [] }),
    listAgents: async () => [],
    ...overrides,
  } as TeamControl;
}

describe('mergeNodeRosters', () => {
  test('keeps the last successful roster and marks the node stale on failure', () => {
    const merged = mergeNodeRosters(
      [roster()],
      [{ node, ok: false, teams: [], rosters: [], partialErrors: 0, error: 'socket closed' }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ ok: false, stale: true, error: 'socket closed' });
    expect(merged[0]?.teams).toEqual([team]);
    expect(flattenRoster(merged).map((agent) => agent.member.agent_id)).toEqual(['agent-1']);
  });

  test('a successful poll replaces stale data and clears the flag', () => {
    const stale = roster({ ok: false, stale: true, error: 'old failure' });
    const freshTeam = { ...team, name: 'Renamed' };
    const merged = mergeNodeRosters(
      [stale],
      [roster({ teams: [freshTeam], rosters: [{ team: freshTeam, members: [member] }] })],
    );

    expect(merged[0]).toMatchObject({ ok: true, stale: false });
    expect(merged[0]?.teams[0]?.name).toBe('Renamed');
  });

  test('a first failure with no history stays empty and is not marked stale', () => {
    const merged = mergeNodeRosters(
      [],
      [{ node, ok: false, teams: [], rosters: [], partialErrors: 0, error: 'unauthorized' }],
    );

    expect(merged[0]).toMatchObject({ ok: false, stale: false, error: 'unauthorized' });
    expect(flattenRoster(merged)).toEqual([]);
  });

  test('nodes that disappear from the next poll are dropped', () => {
    const other: NodeView = { name: 'node-b', url: 'http://node-b.test', current: false };
    const otherRoster = roster({ node: other });
    const merged = mergeNodeRosters([roster(), otherRoster], [roster()]);

    expect(merged.map((item) => item.node.name)).toEqual(['node-a']);
  });
});

describe('fetchNodeRoster', () => {
  test('list failure is reported without throwing and without inventing agents', async () => {
    const failing = control({
      listTeams: async () => {
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      },
    });

    const result = await fetchNodeRoster(node, failing);

    expect(result).toMatchObject({ ok: false, code: 'forbidden', teams: [], rosters: [] });
  });

  test('individual team detail failure keeps the other rosters and counts the partial error', async () => {
    const second = { ...team, team_id: 'team-2', name: 'Team Two' };
    const partial = control({
      listTeams: async () => [team, second],
      getTeam: async (teamId) => {
        if (teamId === 'team-2') throw new Error('boom');
        return { team, members: [member], messages: [] };
      },
    });

    const result = await fetchNodeRoster(node, partial);

    expect(result.ok).toBe(true);
    expect(result.partialErrors).toBe(1);
    expect(result.rosters.map((entry) => entry.team.team_id)).toEqual(['team-1']);
  });

  test('keeps agents.list singles alongside the Team roster', async () => {
    const result = await fetchNodeRoster(node, control({ listAgents: async () => [listedSingle] }));

    expect(result.agents).toEqual([listedSingle]);
    const flattened = flattenRoster([result]);
    expect(flattened.map((agent) => agent.member.agent_id)).toEqual(['agent-1', 'solo-1']);
    expect(flattened[1]?.team).toBeUndefined();
  });

  test('agents.list failure degrades to an empty list without failing the roster', async () => {
    const result = await fetchNodeRoster(
      node,
      control({
        listAgents: async () => {
          throw new Error('not_found');
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.agents).toEqual([]);
    expect(flattenRoster([result]).map((agent) => agent.member.agent_id)).toEqual(['agent-1']);
  });
});

describe('flattenRoster team-less singles', () => {
  test('only adds Team-less singles and keeps Team filters honest', () => {
    const agents = flattenRoster([
      roster({
        agents: [
          listedSingle,
          { ...listedSingle, id: 'member-1', role: 'member' },
          { ...listedSingle, id: 'single-with-team', team_id: 'team-1' },
        ],
      }),
    ]);

    expect(agents.map((agent) => agent.member.agent_id)).toEqual(['agent-1', 'solo-1']);
    expect(filterRosterAgents(agents, { teamId: 'team-1' })).toHaveLength(1);
    expect(filterRosterAgents(agents, { teamId: 'team-1' })[0]?.member.agent_id).toBe('agent-1');
  });
});
