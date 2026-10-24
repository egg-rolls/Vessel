import { describe, expect, it } from 'bun:test';
import { parseTeamPolicy, TeamPolicyError } from '../src/team-policy';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

function teamConfig(policy: Record<string, unknown>): VesselConfig {
  return { teams: [{ workspace: '/tmp/vessel-team-federation-0-21', policy }] };
}

describe('0.21 team policy federation.accept', () => {
  it("accepts 'principal' and 'log'", () => {
    for (const accept of ['principal', 'log'] as const) {
      expect(pathsOf(teamConfig({ federation: { accept } }))).toEqual([]);
      expect(parseTeamPolicy({ federation: { accept } })).toEqual({ federation: { accept } });
    }
  });

  it("turns the removed 'members' value into an explicit error with the migration hint", () => {
    const config = teamConfig({ federation: { accept: 'members' } });
    const errors = validateConfig(config).errors;
    const error = errors.find((item) => item.path === 'teams[0].policy.federation.accept');
    expect(error).toBeDefined();
    expect(error?.message).toContain('use "principal"');
    expect(() => parseTeamPolicy({ federation: { accept: 'members' } })).toThrow(TeamPolicyError);
  });

  it('defaults by omission: no field is written', () => {
    expect(pathsOf(teamConfig({}))).toEqual([]);
    expect(pathsOf(teamConfig({ federation: {} }))).toEqual([]);
    expect(parseTeamPolicy({})).toEqual({});
    expect(parseTeamPolicy({ federation: {} })).toEqual({ federation: {} });
  });

  it('rejects values other than principal / log', () => {
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
    expect(pathsOf(teamConfig({ federation: 'principal' }))).toContain(
      'teams[0].policy.federation',
    );
    expect(() => parseTeamPolicy({ federation: 'principal' })).toThrow(TeamPolicyError);
  });
});
