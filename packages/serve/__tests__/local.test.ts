import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { createLocalRpcDispatcher, type LocalRpcDispatcher } from '../src/local';
import type { CapabilityManifest } from '../src/rpc';
import { runDispatcher } from './rpc-test-utils';

const dispatchers: LocalRpcDispatcher[] = [];

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.dispose();
});

describe('createLocalRpcDispatcher', () => {
  it('serves capabilities.list without listening on a port', async () => {
    const dispatcher = createLocalRpcDispatcher({ events: new MemoryEventStream() });
    dispatchers.push(dispatcher);
    expect(typeof dispatcher.dispatch).toBe('function');
    expect(typeof dispatcher.manifest).toBe('function');
    expect('port' in dispatcher).toBe(false);

    const manifest = (await runDispatcher(
      dispatcher.dispatch,
      'capabilities.list',
    )) as unknown as CapabilityManifest;
    expect(manifest.config_schema_version).toBe(1);
    expect(manifest.methods.map((method) => method.name)).toContain('sessions.list');
  });

  it('serves sessions.list through the injected backend', async () => {
    const dispatcher = createLocalRpcDispatcher({
      events: new MemoryEventStream(),
      session: {
        async load() {
          return null;
        },
        async save() {},
        async delete() {},
        async list() {
          return ['s1'];
        },
        async listRich() {
          return [
            {
              session_id: 's1',
              title: 'local',
              preview: '',
              status: 'completed',
              started_at: 1,
              updated_at: 1,
              message_count: 0,
            },
          ];
        },
      },
    });
    dispatchers.push(dispatcher);
    const result = await runDispatcher(dispatcher.dispatch, 'sessions.list');
    expect(result.sessions).toHaveLength(1);
    expect((result.sessions as Array<{ session_id: string }>)[0]?.session_id).toBe('s1');
  });

  it('returns config.get with paths', async () => {
    const dispatcher = createLocalRpcDispatcher({
      events: new MemoryEventStream(),
      config: {
        snapshot: (tenantId) => ({
          schema_version: 1,
          config: { provider: { apiKey: '***' } },
          sources: { 'provider.apiKey': 'env' },
          paths: { user: '/home/u/.vessel/config.yaml', project: '/repo/vessel.yaml' },
          tenant_id: tenantId,
        }),
      },
    });
    dispatchers.push(dispatcher);
    const result = await runDispatcher(dispatcher.dispatch, 'config.get');
    expect(result.paths).toEqual({
      user: '/home/u/.vessel/config.yaml',
      project: '/repo/vessel.yaml',
    });
    expect(result.config).toEqual({ provider: { apiKey: '<set>' } });
  });
});
