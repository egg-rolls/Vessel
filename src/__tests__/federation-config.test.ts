import { describe, expect, it } from 'bun:test';
import type { FederationConfig } from '../../packages/config/src/index';
import { resolveFederationOptions } from '../federation-config';

function config(overrides: Partial<FederationConfig> = {}): FederationConfig {
  return {
    enabled: true,
    peers: [
      {
        nodeId: 'node-b',
        teamId: 'research',
        url: 'https://node-b.example/',
        tokenEnv: 'PEER_TOKEN',
      },
    ],
    ...overrides,
  };
}

const env = { PEER_TOKEN: 'secret-token' };

describe('resolveFederationOptions', () => {
  it('defaults direction to both and maxHops to 4 while resolving the env token', () => {
    const { options, issues } = resolveFederationOptions({
      federation: config(),
      nodeId: 'node-a',
      env,
    });
    expect(issues).toEqual([]);
    expect(options.enabled).toBe(true);
    expect(options.maxHops).toBe(4);
    expect(options.rateLimitPerMinute).toBe(60);
    expect(options.peers).toEqual([
      {
        nodeId: 'node-b',
        teamId: 'research',
        direction: 'both',
        tokenEnv: 'PEER_TOKEN',
        token: 'secret-token',
        allowDirectory: false,
        url: 'https://node-b.example',
      },
    ]);
  });

  it('treats rateLimitPerMinute=0 as unlimited and reports a warning issue', () => {
    const { options, issues } = resolveFederationOptions({
      federation: config({ rateLimitPerMinute: 0 }),
      nodeId: 'node-a',
      env,
    });
    expect(options.rateLimitPerMinute).toBe(0);
    expect(issues).toContainEqual({ reason: 'rate_limit_disabled' });
  });

  it('falls back to 60 for an illegal rateLimitPerMinute instead of disabling limiting', () => {
    for (const value of [601, -1, 1.5, Number.NaN]) {
      const { options, issues } = resolveFederationOptions({
        federation: config({ rateLimitPerMinute: value }),
        nodeId: 'node-a',
        env,
      });
      expect(options.rateLimitPerMinute).toBe(60);
      expect(issues).not.toContainEqual({ reason: 'rate_limit_disabled' });
    }
  });

  it('enables allowDirectory only on an explicit true', () => {
    const { options } = resolveFederationOptions({
      federation: config({
        peers: [
          {
            nodeId: 'node-b',
            teamId: 'research',
            url: 'https://node-b.example',
            tokenEnv: 'PEER_TOKEN',
            allowDirectory: true,
          },
        ],
      }),
      nodeId: 'node-a',
      env,
    });
    expect(options.peers[0]?.allowDirectory).toBe(true);
  });

  it('drops a peer whose token env is missing instead of sending an empty bearer', () => {
    const { options, issues } = resolveFederationOptions({
      federation: config(),
      nodeId: 'node-a',
      env: {},
    });
    expect(options.peers).toEqual([]);
    expect(issues).toEqual([{ peer: 'node-b:research', reason: 'missing_token' }]);
  });

  it('drops a peer that points at this node even without host.nodeId config', () => {
    const { options, issues } = resolveFederationOptions({
      federation: config({
        peers: [
          {
            nodeId: 'node-a',
            teamId: 'lab',
            url: 'https://node-a.example',
            tokenEnv: 'PEER_TOKEN',
          },
        ],
      }),
      nodeId: 'node-a',
      env,
    });
    expect(options.peers).toEqual([]);
    expect(issues).toEqual([{ peer: 'node-a:lab', reason: 'self_peer' }]);
  });

  it('preserves localTeamId and an inbound-only peer without url', () => {
    const { options, issues } = resolveFederationOptions({
      federation: config({
        peers: [
          {
            nodeId: 'node-b',
            teamId: 'research',
            localTeamId: 'lab',
            direction: 'in',
            tokenEnv: 'PEER_TOKEN',
          },
        ],
      }),
      nodeId: 'node-a',
      env,
    });
    expect(issues).toEqual([]);
    expect(options.peers[0]).toMatchObject({
      nodeId: 'node-b',
      teamId: 'research',
      localTeamId: 'lab',
      direction: 'in',
      token: 'secret-token',
    });
    expect(options.peers[0]?.url).toBeUndefined();
  });
});
