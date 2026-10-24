import { describe, expect, it } from 'bun:test';
import type { FederationPeerConfig, VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function paths(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

function peer(overrides: Partial<FederationPeerConfig> = {}): FederationPeerConfig {
  return {
    nodeId: 'office',
    teamId: 'research',
    url: 'https://office.example:7321',
    tokenEnv: 'VESSEL_FED_OFFICE',
    ...overrides,
  };
}

function withFederation(
  federation: Record<string, unknown>,
  extra: VesselConfig = {},
): VesselConfig {
  return {
    federation: { enabled: true, peers: [peer()], ...federation } as VesselConfig['federation'],
    ...extra,
  };
}

describe('0.21 federation rateLimitPerMinute', () => {
  it('accepts 1..600 and rejects 0 (no unlimited value)', () => {
    expect(paths(withFederation({ rateLimitPerMinute: 600 }))).toEqual([]);
    expect(paths(withFederation({ rateLimitPerMinute: 1 }))).toEqual([]);
    expect(paths(withFederation({ rateLimitPerMinute: 0 }))).toContain(
      'federation.rateLimitPerMinute',
    );
  });

  it('rejects out-of-range, fractional, and non-numeric values', () => {
    for (const value of [601, -1, 1.5, '60', null]) {
      expect(paths(withFederation({ rateLimitPerMinute: value }))).toContain(
        'federation.rateLimitPerMinute',
      );
    }
  });
});

describe('0.21 federation peer allowDirectory', () => {
  it('accepts a boolean and defaults by omission', () => {
    expect(paths(withFederation({ peers: [peer({ allowDirectory: true })] }))).toEqual([]);
    expect(paths(withFederation({ peers: [peer({ allowDirectory: false })] }))).toEqual([]);
    expect(paths(withFederation({ peers: [peer()] }))).toEqual([]);
  });

  it('rejects non-boolean values instead of coercing them', () => {
    const config = withFederation({ peers: [peer()] });
    (config.federation?.peers?.[0] as unknown as { allowDirectory?: unknown }).allowDirectory =
      'yes';
    expect(paths(config)).toContain('federation.peers[0].allowDirectory');
  });
});

describe('0.21 team description / defaultPrincipal', () => {
  function team(entry: Record<string, unknown>): VesselConfig {
    return {
      teams: [{ workspace: '/tmp/vessel-team-0-21', ...entry }] as VesselConfig['teams'],
    };
  }

  it('accepts a non-empty description and a shaped default principal', () => {
    expect(paths(team({ description: 'lab team', defaultPrincipal: 'alice' }))).toEqual([]);
    expect(paths(team({ defaultPrincipal: 'owner' }))).toEqual([]);
  });

  it('rejects an empty description or a default principal outside the address alphabet', () => {
    expect(paths(team({ description: '   ' }))).toContain('teams[0].description');
    for (const value of ['alice b', 'alice.b', 'a'.repeat(65), '', 1]) {
      expect(paths(team({ defaultPrincipal: value }))).toContain('teams[0].defaultPrincipal');
    }
  });
});
