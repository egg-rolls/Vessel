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

describe('0.6 transport.nodes / connect', () => {
  it('accepts remote nodes and validates ids/urls', () => {
    const valid: VesselConfig = {
      transport: {
        kind: 'remote',
        nodes: [
          { id: 'node-b', url: 'https://b.example.com:8642', tokenEnv: 'NODE_B_TOKEN' },
          { id: 'node-c', url: 'http://127.0.0.1:8643', caFile: './ca.pem' },
        ],
      },
      connect: { tokenEnv: 'CONNECT_TOKEN', caFile: './ca.pem' },
    };
    expect(pathsOf(valid)).toHaveLength(0);

    const invalid: VesselConfig = {
      transport: {
        kind: 'remote',
        nodes: [
          { id: 'bad id', url: 'http://b.example.com:8642' },
          { id: 'dup', url: 'https://c.example.com' },
          { id: 'dup', url: 'https://d.example.com' },
        ],
      },
    };
    const paths = pathsOf(invalid);
    expect(paths).toContain('transport.nodes[0].id');
    expect(paths).toContain('transport.nodes[0].url');
    expect(paths).toContain('transport.nodes[2].id');
  });

  it('requires nodes for kind=remote', () => {
    const config: VesselConfig = { transport: { kind: 'remote' } };
    expect(pathsOf(config)).toContain('transport.nodes');
  });

  it('maps snake_case keys and resolves token_env for connect/nodes', () => {
    const mapped = snakeToCamel({
      serve: { allowed_origins: ['https://console.example.com'] },
      connect: { token_env: 'CONNECT_TOKEN', ca_file: './ca.pem' },
      transport: { nodes: [{ id: 'b', url: 'https://b.example.com', token_env: 'NODE_B' }] },
    }) as VesselConfig;
    expect(mapped.serve?.allowedOrigins).toEqual(['https://console.example.com']);
    expect(mapped.connect?.caFile).toBe('./ca.pem');
    expect(mapped.transport?.nodes?.[0]?.url).toBe('https://b.example.com');

    const resolved = resolveEnvRefsInLayer(mapped, {
      CONNECT_TOKEN: 'connect-secret',
      NODE_B: 'node-secret',
    });
    expect(resolved.errors).toHaveLength(0);
    const layer = resolved.layer as VesselConfig;
    expect(layer.connect?.token).toBe('connect-secret');
    expect(layer.transport?.nodes?.[0]?.token).toBe('node-secret');
  });

  it('redacts connect.token and transport.nodes[].token', () => {
    const redacted = redactConfig({
      connect: { token: 'connect-secret' },
      transport: { nodes: [{ id: 'b', url: 'https://b.example.com', token: 'node-secret' }] },
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('connect-secret');
    expect(text).not.toContain('node-secret');
    expect(text).toContain('<set>');
  });
});
