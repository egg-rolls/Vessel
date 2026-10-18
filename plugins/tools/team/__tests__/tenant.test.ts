/**
 * 0.5：team 事件带 tenant_id（A-3 §10.7 / A-4 §11.1）。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentHandle,
  type AgentSpec,
  type AgentStatus,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type RuntimeHost,
} from '@vessel/core';
import { CoreHostAdapter } from '../src/core-adapter.js';
import { createTeamPlugin } from '../src/index.js';

function makeHost(): RuntimeHost {
  const handles = new Map<string, AgentHandle>();
  return {
    events: new MemoryEventStream(),
    async spawn(spec: AgentSpec): Promise<AgentHandle> {
      const id = spec.id ?? 'member';
      const status: AgentStatus = { id, state: 'idle', toolNames: [] };
      const handle = {
        id,
        name: id,
        status: () => status,
        async run() {
          return { id: `${id}-run`, result: Promise.resolve('ok') };
        },
        async close() {},
      } as unknown as AgentHandle;
      handles.set(id, handle);
      return handle;
    },
    get: (id: string) => handles.get(id),
    list: () => [],
    async send() {},
    async inbox() {
      return { messages: [], cursor: '' };
    },
    async cancel() {},
    async close() {},
  } as unknown as RuntimeHost;
}

describe('team tenant scope', () => {
  it('stamps tenant_id on team events', async () => {
    const events = new MemoryEventStream();
    const adapter = new CoreHostAdapter(makeHost(), { events, tenantId: 'acme' });
    await adapter.spawn({
      provider: new MemoryLLMProvider(),
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
    });

    const spawned = events.getHistory().find((event) => event.type === 'team.member.spawned');
    expect(spawned?.tenant_id).toBe('acme');
  });

  it('keeps 0.4 envelope when tenantId is omitted', async () => {
    const events = new MemoryEventStream();
    const adapter = new CoreHostAdapter(makeHost(), { events });
    await adapter.spawn({
      provider: new MemoryLLMProvider(),
      model: 'test-model',
      pluginHost: new MemoryPluginHost(),
    });

    const spawned = events.getHistory().find((event) => event.type === 'team.member.spawned');
    expect(spawned !== undefined && 'tenant_id' in spawned).toBe(false);
  });

  it('rejects an invalid tenant id', () => {
    expect(() =>
      createTeamPlugin({
        host: makeHost(),
        providerFactory: () => new MemoryLLMProvider(),
        model: 'test-model',
        tenantId: 'Bad Tenant',
      }),
    ).toThrow(/invalid tenant id/);
  });
});
