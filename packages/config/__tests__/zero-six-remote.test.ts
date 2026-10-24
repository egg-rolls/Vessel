import { describe, expect, it } from 'bun:test';
import { snakeToCamel } from '../src/loader';
import { redactConfig, resolveEnvRefsInLayer } from '../src/secrets';
import type { VesselConfig } from '../src/types';
import { validateConfig } from '../src/validator';

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((error) => error.path);
}

describe('0.6 serve.allowed_origins', () => {
  it('accepts absolute https origins and loopback http', () => {
    const config: VesselConfig = {
      serve: {
        allowedOrigins: ['https://console.example.com', 'http://localhost:5173'],
      },
    };
    expect(pathsOf(config)).not.toContain('serve.allowedOrigins');
  });

  it('rejects wildcard / path / non-loopback http', () => {
    const config: VesselConfig = {
      serve: {
        allowedOrigins: ['*', 'https://example.com/path', 'http://example.com'],
      },
    };
    const paths = pathsOf(config);
    expect(paths).toContain('serve.allowedOrigins[0]');
    expect(paths).toContain('serve.allowedOrigins[1]');
    expect(paths).toContain('serve.allowedOrigins[2]');
  });
});

describe('0.6 connect token', () => {
  it('maps snake_case keys and resolves token_env', () => {
    const mapped = snakeToCamel({
      connect: { token_env: 'CONNECT_TOKEN', ca_file: './ca.pem' },
    }) as VesselConfig;
    expect(mapped.connect?.caFile).toBe('./ca.pem');

    const resolved = resolveEnvRefsInLayer(mapped, { CONNECT_TOKEN: 'connect-secret' });
    expect(resolved.errors).toHaveLength(0);
    expect((resolved.layer as VesselConfig).connect?.token).toBe('connect-secret');
  });

  it('redacts connect.token', () => {
    const redacted = redactConfig({ connect: { token: 'connect-secret' } });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('connect-secret');
    expect(text).toContain('<set>');
  });
});
