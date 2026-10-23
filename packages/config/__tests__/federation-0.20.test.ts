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

function withPeer(
  overrides: Partial<FederationPeerConfig> = {},
  extra: VesselConfig = {},
): VesselConfig {
  return { federation: { enabled: true, peers: [peer(overrides)] }, ...extra };
}

describe('federation config', () => {
  it('accepts an explicit peer allowlist', () => {
    expect(paths(withPeer())).toEqual([]);
  });

  it('rejects a peer without tokenEnv instead of allowing an empty bearer', () => {
    expect(paths(withPeer({ tokenEnv: '' }))).toContain('federation.peers[0].tokenEnv');
  });

  it('rejects a plaintext token (env indirection only)', () => {
    const config = withPeer();
    (config.federation?.peers?.[0] as FederationPeerConfig & { token?: string }).token = 'secret';
    expect(paths(config)).toContain('federation.peers[0].token');
  });

  it('rejects duplicate (nodeId, teamId) peers', () => {
    const config: VesselConfig = {
      federation: { enabled: true, peers: [peer(), peer()] },
    };
    expect(paths(config)).toContain('federation.peers[1].teamId');
  });

  it('rejects a peer that points at this node', () => {
    const config = withPeer({}, { host: { nodeId: 'office' } });
    expect(paths(config)).toContain('federation.peers[0].nodeId');
  });

  it('requires url when direction includes outbound', () => {
    expect(paths(withPeer({ url: undefined, direction: 'out' }))).toContain(
      'federation.peers[0].url',
    );
  });

  it('allows inbound-only peers without url', () => {
    expect(paths(withPeer({ url: undefined, direction: 'in' }))).toEqual([]);
  });

  it('rejects non-loopback http peers', () => {
    expect(paths(withPeer({ url: 'http://office.example:7321' }))).toContain(
      'federation.peers[0].url',
    );
  });

  it('rejects maxHops outside 1..16', () => {
    expect(paths({ federation: { enabled: true, maxHops: 0, peers: [peer()] } })).toContain(
      'federation.maxHops',
    );
    expect(paths({ federation: { enabled: true, maxHops: 17, peers: [peer()] } })).toContain(
      'federation.maxHops',
    );
  });

  it('rejects an unknown direction', () => {
    const config = withPeer();
    (config.federation?.peers?.[0] as unknown as { direction?: string }).direction = 'sideways';
    expect(paths(config)).toContain('federation.peers[0].direction');
  });

  it('rejects unknown peer keys instead of silently ignoring them', () => {
    const config = withPeer();
    (config.federation?.peers?.[0] as unknown as { localteamid?: string }).localteamid = 'lab';
    expect(paths(config)).toContain('federation.peers[0].localteamid');
  });
});
