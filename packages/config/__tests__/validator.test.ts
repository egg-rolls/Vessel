import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

function errorsOf(config: VesselConfig) {
  return validateConfig(config).errors;
}

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

  it('accepts a node-mode hub block with url, caFile and joinCodeEnv', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: {
        direction: 'node',
        url: 'https://hub.example.com:8643',
        caFile: '/etc/vessel/hub-ca.pem',
        joinCodeEnv: 'VESSEL_HUB_JOIN_CODE',
      },
    };
    expect(pathsOf(config)).toEqual([]);
  });

  it('accepts a loopback http hub url in node mode', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: { direction: 'node', url: 'http://127.0.0.1:8643' },
    };
    expect(pathsOf(config)).toEqual([]);
  });

  it('rejects invalid hub.url shapes', () => {
    const urls = [
      'ftp://hub.example.com',
      'https://hub.example.com/path',
      'https://hub.example.com?tenant=default',
      'https://user:pass@hub.example.com',
      'http://hub.example.com',
    ];
    for (const url of urls) {
      const config: VesselConfig = {
        dataDir: '/tmp/vessel',
        hub: { direction: 'node', url },
      };
      expect(pathsOf(config), url).toContain('hub.url');
    }
  });

  it('rejects empty or NUL hub.caFile', () => {
    for (const caFile of ['', '/etc/vessel/ca\0.pem']) {
      const config: VesselConfig = {
        dataDir: '/tmp/vessel',
        hub: { direction: 'node', caFile },
      };
      expect(pathsOf(config), JSON.stringify(caFile)).toContain('hub.caFile');
    }
  });

  it('rejects an invalid hub.joinCodeEnv', () => {
    const config: VesselConfig = {
      dataDir: '/tmp/vessel',
      hub: { direction: 'node', joinCodeEnv: 'not a valid env name' },
    };
    expect(pathsOf(config)).toContain('hub.joinCodeEnv');
  });

  it('still rejects unknown hub keys', () => {
    const config = {
      dataDir: '/tmp/vessel',
      hub: { direction: 'node', hubToken: 'secret' },
    } as unknown as VesselConfig;
    expect(pathsOf(config)).toContain('hub.hubToken');
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
