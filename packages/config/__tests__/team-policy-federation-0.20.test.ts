import { describe, expect, it } from 'bun:test';
import { parseTeamPolicy, TeamPolicyError } from '../src/team-policy';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

function teamConfig(policy: Record<string, unknown>): VesselConfig {
  return { teams: [{ workspace: '/tmp/vessel-team-federation', policy }] };
}

describe('S7.2 team policy federation.accept', () => {
  it("accepts 'log' and 'members'", () => {
    for (const accept of ['log', 'members'] as const) {
      expect(pathsOf(teamConfig({ federation: { accept } }))).toEqual([]);
      expect(parseTeamPolicy({ federation: { accept } })).toEqual({ federation: { accept } });
    }
  });

  it('defaults by omission: no field is written', () => {
    expect(pathsOf(teamConfig({}))).toEqual([]);
    expect(pathsOf(teamConfig({ federation: {} }))).toEqual([]);
    expect(parseTeamPolicy({})).toEqual({});
    expect(parseTeamPolicy({ federation: {} })).toEqual({ federation: {} });
  });

  it('rejects values other than log / members', () => {
    for (const accept of ['all', 'fanout', true, 1, null]) {
      expect(pathsOf(teamConfig({ federation: { accept } }))).toContain(
        'teams[0].policy.federation.accept',
      );
      expect(() => parseTeamPolicy({ federation: { accept } })).toThrow(TeamPolicyError);
    }
  });

  it('rejects unknown keys inside federation', () => {
    expect(pathsOf(teamConfig({ federation: { accept: 'log', fanout: true } }))).toContain(
      'teams[0].policy.federation.fanout',
    );
    expect(() => parseTeamPolicy({ federation: { fanout: true } })).toThrow(/not a valid key/);
  });

  it('rejects a non-object federation block', () => {
    expect(pathsOf(teamConfig({ federation: 'members' }))).toContain('teams[0].policy.federation');
    expect(() => parseTeamPolicy({ federation: 'members' })).toThrow(TeamPolicyError);
  });
});
