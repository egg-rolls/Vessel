import { describe, expect, it } from 'bun:test';
import { parseTeamPolicy, TeamPolicyError, validateTeamPolicy } from '../src/team-policy';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

function errorsOf(config: VesselConfig) {
  return validateConfig(config).errors;
}

describe('0.19 S4 team policy parsing', () => {
  it('normalizes camelCase and snake_case input to the same policy', () => {
    const camel = parseTeamPolicy({
      permission: { unattended: 'deny-after', denyAfterSeconds: 300 },
      budget: {
        maxHops: 4,
        maxTurns: 10,
        maxTokens: 1000,
        maxWallClockSeconds: 60,
        warningThreshold: 0.5,
        cycle: { maxRepeats: 3, cooldownSeconds: 5 },
      },
    });
    const snake = parseTeamPolicy({
      permission: { unattended: 'deny-after', deny_after_seconds: 300 },
      budget: {
        max_hops: 4,
        max_turns: 10,
        max_tokens: 1000,
        max_wall_clock_seconds: 60,
        warning_threshold: 0.5,
        cycle: { max_repeats: 3, cooldown_seconds: 5 },
      },
    });

    expect(snake).toEqual(camel);
    expect(camel).toEqual({
      permission: { unattended: 'deny-after', denyAfterSeconds: 300 },
      budget: {
        maxHops: 4,
        maxTurns: 10,
        maxTokens: 1000,
        maxWallClockSeconds: 60,
        warningThreshold: 0.5,
        cycle: { maxRepeats: 3, cooldownSeconds: 5 },
      },
    });
  });

  it('keeps hold as the default and rejects deny_after_seconds with hold', () => {
    expect(parseTeamPolicy({ permission: { unattended: 'hold' } })).toEqual({
      permission: { unattended: 'hold' },
    });
    // unattended 缺省即 hold；此时 deny_after_seconds 不允许出现
    expect(() => parseTeamPolicy({ permission: { deny_after_seconds: 10 } })).toThrow(
      TeamPolicyError,
    );
    expect(() => parseTeamPolicy({ permission: { denyAfterSeconds: 10 } })).toThrow(
      /only allowed when unattended/,
    );
  });

  it('rejects allow_after and maxCost explicitly', () => {
    expect(() => parseTeamPolicy({ permission: { allow_after: 30 } })).toThrow(
      /allow-after is not supported; use hold or deny-after/,
    );
    expect(() => parseTeamPolicy({ permission: { allowAfter: 30 } })).toThrow(
      /allow-after is not supported; use hold or deny-after/,
    );
    expect(() => parseTeamPolicy({ budget: { maxCost: 5 } })).toThrow(
      /policy\.budget\.maxCost is not supported/,
    );
    expect(() => parseTeamPolicy({ budget: { max_cost: 5 } })).toThrow(
      /policy\.budget\.maxCost is not supported/,
    );
  });

  it('requires denyAfterSeconds for deny-after', () => {
    expect(() => parseTeamPolicy({ permission: { unattended: 'deny-after' } })).toThrow(
      /denyAfterSeconds is required/,
    );
  });

  it('rejects out-of-range values', () => {
    const invalid = [
      { permission: { unattended: 'deny-after', denyAfterSeconds: 0 } },
      { permission: { unattended: 'deny-after', denyAfterSeconds: 86401 } },
      { permission: { unattended: 'deny-after', denyAfterSeconds: 1.5 } },
      { budget: { maxHops: 0 } },
      { budget: { maxTurns: 1.5 } },
      { budget: { maxTokens: -1 } },
      { budget: { maxWallClockSeconds: 0 } },
      { budget: { warningThreshold: 1 } },
      { budget: { warningThreshold: 0 } },
      { budget: { cycle: { maxRepeats: 0 } } },
      { budget: { cycle: { cooldownSeconds: -1 } } },
    ];
    for (const policy of invalid) {
      expect(() => parseTeamPolicy(policy)).toThrow(TeamPolicyError);
    }
  });

  it('rejects unknown keys inside permission / budget but preserves top-level keys', () => {
    expect(() => parseTeamPolicy({ permission: { timeout: 1 } })).toThrow(/not a valid key/);
    expect(() => parseTeamPolicy({ budget: { maxFuel: 1 } })).toThrow(/not a valid key/);
    expect(() => parseTeamPolicy({ budget: { cycle: { maxLoops: 1 } } })).toThrow(
      /not a valid key/,
    );
    expect(parseTeamPolicy({ future: { enabled: true } })).toEqual({ future: { enabled: true } });
  });

  it('rejects conflicting camelCase / snake_case aliases', () => {
    expect(() => parseTeamPolicy({ budget: { max_hops: 1, maxHops: 2 } })).toThrow(
      /different values/,
    );
  });

  it('validateTeamPolicy collects issues without throwing', () => {
    const issues = validateTeamPolicy({ budget: { maxCost: 1, maxHops: 0 } });
    expect(issues.map((issue) => issue.field)).toEqual(['budget.maxCost', 'budget.maxHops']);
  });
});

describe('0.19 S4 team policy validation', () => {
  function teamConfig(policy: Record<string, unknown>): VesselConfig {
    return { teams: [{ workspace: '/tmp/vessel-team-policy', policy }] };
  }

  it('accepts valid camelCase and snake_case policies', () => {
    expect(
      pathsOf(
        teamConfig({
          permission: { unattended: 'deny-after', deny_after_seconds: 300 },
          budget: { maxHops: 2, max_wall_clock_seconds: 60 },
        }),
      ),
    ).toEqual([]);
  });

  it('surfaces allow_after / maxCost / range errors', () => {
    const errors = errorsOf(
      teamConfig({
        permission: { allow_after: 30 },
        budget: { maxCost: 1, maxHops: 0 },
      }),
    );
    const paths = errors.map((error) => error.path);
    expect(paths).toContain('teams[0].policy.permission.allow_after');
    expect(paths).toContain('teams[0].policy.budget.maxCost');
    expect(paths).toContain('teams[0].policy.budget.maxHops');
    expect(errors.some((error) => error.message === 'policy.budget.maxCost is not supported')).toBe(
      true,
    );
    expect(errors.some((error) => error.message.includes('allow-after is not supported'))).toBe(
      true,
    );
  });

  it('requires deny_after_seconds when unattended is deny-after', () => {
    expect(pathsOf(teamConfig({ permission: { unattended: 'deny-after' } }))).toContain(
      'teams[0].policy.permission.denyAfterSeconds',
    );
  });

  it('keeps top-level unknown keys and the default hold', () => {
    expect(pathsOf(teamConfig({ future: true, permission: { unattended: 'hold' } }))).toEqual([]);
  });

  it('still rejects a non-object policy', () => {
    const config = {
      teams: [{ workspace: '/tmp/vessel-team-policy', policy: 'hold' }],
    } as unknown as VesselConfig;
    expect(pathsOf(config)).toContain('teams[0].policy');
  });
});

describe('S5 hub config', () => {
  it('accepts a complete loopback hub block', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: {
        dataDir: '/tmp/vessel-hub',
        direction: 'hub',
        listen: { hostname: '127.0.0.1', port: 8643 },
        allowRemote: false,
        tls: { certFile: '/tmp/hub-cert.pem', keyFile: '/tmp/hub-key.pem' },
        allowedOrigins: ['https://console.example.com', 'http://localhost:5173'],
        tokenEnv: 'HUB_TOKEN',
        allowFileSecrets: true,
        pairingTtlSeconds: 300,
      },
    };
    expect(pathsOf(config)).toEqual([]);
  });

  it('rejects hub.token (plaintext token is not accepted)', () => {
    const config = {
      dataDir: '/tmp/vessel',
      hub: { dataDir: '/tmp/vessel-hub', token: 'secret' },
    } as unknown as VesselConfig;
    expect(pathsOf(config)).toContain('hub.token');
  });

  it('rejects a hub data dir equal to the global data dir', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: { dataDir: '/tmp/vessel/' },
    };
    const errors = errorsOf(config);
    expect(errors.map((error) => error.path)).toContain('hub.data_dir');
    expect(errors.some((error) => error.message.includes('hub_data_dir_conflict'))).toBe(true);
  });

  it('requires TLS and tokenEnv for a remote hub', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: {
        dataDir: '/tmp/vessel-hub',
        listen: { hostname: '0.0.0.0', port: 8643 },
        allowRemote: true,
      },
    };
    const paths = pathsOf(config);
    expect(paths).toContain('hub.tls');
    expect(paths).toContain('hub.tokenEnv');
  });

  it('rejects a non-loopback hub without allowRemote', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: {
        dataDir: '/tmp/vessel-hub',
        listen: { hostname: '0.0.0.0', port: 8643 },
      },
    };
    expect(pathsOf(config)).toContain('hub.allowRemote');
  });

  it('rejects wildcard / path / non-loopback http origins', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: {
        dataDir: '/tmp/vessel-hub',
        allowedOrigins: ['*', 'https://example.com/path', 'http://example.com'],
      },
    };
    const paths = pathsOf(config);
    expect(paths).toContain('hub.allowedOrigins[0]');
    expect(paths).toContain('hub.allowedOrigins[1]');
    expect(paths).toContain('hub.allowedOrigins[2]');
  });

  it('forbids hub in a tenant overlay', () => {
    const config = {
      tenant: {
        tenants: {
          alpha: { config: { hub: { dataDir: '/tmp/tenant-hub' } } },
        },
      },
    } as unknown as VesselConfig;
    const errors = errorsOf(config);
    expect(errors.map((error) => error.path)).toContain('tenant.tenants.alpha.config.hub');
    expect(
      errors.some((error) => error.message === '"hub" is not allowed in a tenant config overlay'),
    ).toBe(true);
  });

  it('validates direction, pairing TTL and allowFileSecrets', () => {
    const config = {
      dataDir: '/tmp/vessel',
      hub: {
        dataDir: '/tmp/vessel-hub',
        direction: 'peer',
        allowFileSecrets: 'yes',
        pairingTtlSeconds: 10,
      },
    } as unknown as VesselConfig;
    const paths = pathsOf(config);
    expect(paths).toContain('hub.direction');
    expect(paths).toContain('hub.allowFileSecrets');
    expect(paths).toContain('hub.pairingTtlSeconds');
  });
});
