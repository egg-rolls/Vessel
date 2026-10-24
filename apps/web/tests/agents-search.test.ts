import { describe, expect, test } from 'bun:test';
import {
  agentDisplayName,
  filterAgentsByQuery,
  matchesAgentQuery,
  shortAgentId,
} from '../src/domains/agents/agent-search';
import type { RosterAgent } from '../src/gateway/team-roster';
import type { TeamMember, TeamSummary } from '../src/gateway/types';

const team: TeamSummary = {
  team_id: 'core',
  name: 'Core Team',
  tenant_id: 'default',
  member_count: 2,
  created_at: 1,
};

const node = { name: 'alpha', url: 'https://alpha.example', current: false };

const member = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  agent_id: 'agent-0123456789',
  name: 'Alice',
  membership: 'present',
  presence: 'live',
  visibility: 'team',
  state: 'idle',
  ...overrides,
});

const agent = (overrides: Partial<TeamMember> = {}): RosterAgent => ({
  node,
  team,
  member: member(overrides),
});

describe('agentDisplayName', () => {
  test('prefers the member name and falls back to a short id', () => {
    expect(agentDisplayName(member())).toBe('Alice');
    expect(agentDisplayName(member({ name: '   ' }))).toBe('agent-01');
    expect(shortAgentId('short')).toBe('short');
  });
});

describe('matchesAgentQuery / filterAgentsByQuery', () => {
  test('matches by name or full id', () => {
    const alice = agent();
    expect(matchesAgentQuery(alice, 'ali')).toBe(true);
    expect(matchesAgentQuery(alice, '0123456789')).toBe(true);
    expect(matchesAgentQuery(alice, '')).toBe(true);
  });

  test('rejects unrelated text and filters the list', () => {
    const agents = [agent(), agent({ agent_id: 'agent-zzz', name: 'Bob' })];
    expect(matchesAgentQuery(agents[1] as RosterAgent, 'alice')).toBe(false);
    expect(filterAgentsByQuery(agents, 'bob').map((item) => item.member.agent_id)).toEqual([
      'agent-zzz',
    ]);
    expect(filterAgentsByQuery(agents, 'nomatch')).toEqual([]);
  });
});
