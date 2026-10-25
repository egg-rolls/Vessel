import { describe, expect, test } from 'bun:test';
import { nullableChange, trimmedOrUndefined } from '../src/domains/teams/team-form';
import { filterTeamResults, matchesTeamQuery } from '../src/domains/teams/team-search';
import {
  isTeamEditHash,
  teamEditHash,
  teamNodeFilterFromHash,
  teamsForNodeHash,
} from '../src/domains/teams/team-url';
import type { NodeTeams } from '../src/gateway/team-roster';
import type { TeamSummary } from '../src/gateway/types';

const team = (overrides: Partial<TeamSummary> = {}): TeamSummary => ({
  team_id: 'core',
  name: 'Core Team',
  tenant_id: 'default',
  member_count: 2,
  created_at: 1,
  ...overrides,
});

const node = (name: string) => ({
  name,
  url: `https://${name}.example`,
  current: false,
});

describe('matchesTeamQuery', () => {
  test('matches name and team id, case-insensitively', () => {
    expect(matchesTeamQuery(team(), 'core')).toBe(true);
    expect(matchesTeamQuery(team(), 'CORE TEAM')).toBe(true);
    expect(matchesTeamQuery(team(), '')).toBe(true);
  });

  test('rejects text that appears in neither name nor id', () => {
    expect(matchesTeamQuery(team(), 'ops')).toBe(false);
  });
});

describe('filterTeamResults', () => {
  test('drops empty groups but keeps failed nodes visible', () => {
    const results: NodeTeams[] = [
      {
        node: node('alpha'),
        ok: true,
        teams: [team(), team({ team_id: 'ops', name: 'Ops' })],
      },
      { node: node('beta'), ok: true, teams: [team({ team_id: 'design', name: 'Design' })] },
      { node: node('gamma'), ok: false, teams: [], error: 'unauthorized', code: 'unauthorized' },
    ];

    const filtered = filterTeamResults(results, 'core');
    expect(filtered.map((result) => result.node.name)).toEqual(['alpha', 'gamma']);
    expect(filtered[0]?.teams.map((item) => item.team_id)).toEqual(['core']);
    expect(filtered[1]?.ok).toBe(false);
  });

  test('returns every group unchanged for an empty query', () => {
    const results: NodeTeams[] = [{ node: node('alpha'), ok: true, teams: [team()] }];
    expect(filterTeamResults(results, '   ')).toEqual(results);
  });
});

describe('team URL helpers', () => {
  test('builds and detects the edit hash', () => {
    const hash = teamEditHash('node/1', 'team 1');
    expect(hash).toBe('#/teams/node%2F1/team%201/edit');
    expect(isTeamEditHash(hash)).toBe(true);
    expect(isTeamEditHash(hash, 'node/1', 'team 1')).toBe(true);
    expect(isTeamEditHash(hash, 'node/1', 'other')).toBe(false);
    expect(isTeamEditHash(hash, 'other', 'team 1')).toBe(false);
  });

  test('does not treat the chat or member pages as edit pages', () => {
    expect(isTeamEditHash('#/teams/n/t')).toBe(false);
    expect(isTeamEditHash('#/teams/n/t/agents/a')).toBe(false);
    expect(isTeamEditHash('#/nodes/n/edit')).toBe(false);
  });

  test('round-trips the node filter deep link', () => {
    const hash = teamsForNodeHash('node/1');
    expect(hash).toBe('#/teams?node=node%2F1');
    expect(teamNodeFilterFromHash(hash)).toBe('node/1');
    expect(teamNodeFilterFromHash('#/teams')).toBeUndefined();
    expect(teamNodeFilterFromHash('#/teams?node=')).toBeUndefined();
  });
});

describe('team form helpers', () => {
  test('only reports nullable fields that actually changed', () => {
    expect(nullableChange('  human ', 'human')).toEqual({ changed: false, value: null });
    expect(nullableChange('', 'human')).toEqual({ changed: true, value: null });
    expect(nullableChange('alice', 'human')).toEqual({ changed: true, value: 'alice' });
    expect(trimmedOrUndefined('   ')).toBeUndefined();
    expect(trimmedOrUndefined(' x ')).toBe('x');
  });
});
