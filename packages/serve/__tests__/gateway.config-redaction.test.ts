import { afterEach, describe, expect, it } from 'bun:test';
import { redactSourcePaths } from '@vessel/config';
import { MemoryEventStream } from '@vessel/core';
import type { Gateway } from '../src/gateway';
import type { ConfigSnapshotLike } from '../src/tenant';
import { createGateway } from './helpers';

const gateways: Gateway[] = [];

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.stop();
});

async function rpc(gateway: Gateway, id: string, method: string) {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ v: 1, id, method }),
  });
  return (await response.json()) as { ok: boolean; result?: unknown };
}

describe('redactSourcePaths', () => {
  it('masks serve.tokens segments and their source values', () => {
    const redacted = redactSourcePaths({
      'serve.tokens.secret.tenantId': 'env',
      'serve.tokens.secret.role': 'env',
      'serve.tokens.other.tenantId': 'project',
      'serve.port': 'cli',
      'provider.apiKey': 'user',
      'transport.token': 'env',
    });

    expect(Object.keys(redacted)).toEqual([
      'serve.tokens.<set>.tenantId',
      'serve.tokens.<set>.role',
      'serve.tokens.<set#2>.tenantId',
      'serve.port',
      'provider.apiKey',
      'transport.token',
    ]);
    expect(redacted['serve.tokens.<set>.tenantId']).toBe('<set>');
    expect(redacted['serve.tokens.<set#2>.tenantId']).toBe('<set>');
    expect(redacted['serve.port']).toBe('cli');
    expect(redacted['provider.apiKey']).toBe('<set>');
    expect(redacted['transport.token']).toBe('<set>');
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(JSON.stringify(redacted)).not.toContain('other');
  });
});

describe('config RPC source redaction', () => {
  const token = 'tok-very-secret-123';

  function snapshot(tenantId: string): ConfigSnapshotLike {
    return {
      schema_version: 1,
      config: {
        provider: { apiKey: '***' },
        serve: { tokens: { [token]: { tenantId: 'default', role: 'admin' } } },
      },
      sources: {
        [`serve.tokens.${token}.tenantId`]: 'env',
        [`serve.tokens.${token}.role`]: 'env',
        'serve.port': 'cli',
      },
      paths: { user: '/u', project: '/p' },
      tenant_id: tenantId,
    };
  }

  it('never returns the raw serve.tokens key through config.get', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      config: { snapshot },
    });
    gateways.push(gateway);

    const response = await rpc(gateway, '1', 'config.get');
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('"serve":{"tokens":{"<set>"');
    expect(serialized).toContain('"tenantId":"default"');
  });

  it('never returns the raw serve.tokens key through config.sources', async () => {
    const gateway = createGateway({
      events: new MemoryEventStream(),
      config: { snapshot },
    });
    gateways.push(gateway);

    const response = await rpc(gateway, '2', 'config.sources');
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('serve.tokens.<set>.tenantId');
    expect(serialized).toContain('"serve.port":"cli"');
  });
});
