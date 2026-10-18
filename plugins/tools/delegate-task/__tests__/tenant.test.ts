/**
 * 0.5：delegate-task 事件带 tenant_id，且重发时保留 seq / tenant_id（A-4 §11.1）。
 */

import { describe, expect, it } from 'bun:test';
import {
  type AgentHandle,
  type AgentSpec,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type RunEvent,
  type RuntimeHost,
  type Usage,
} from '@vessel/core';
import { createDelegateTaskPlugin } from '../src/index';

const usage: Usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function makeFakeHost(): { host: RuntimeHost; childEvents: MemoryEventStream } {
  const childEvents = new MemoryEventStream();
  const handles = new Map<string, AgentHandle>();

  const host = {
    events: childEvents,
    async spawn(spec: AgentSpec): Promise<AgentHandle> {
      const id = spec.id ?? 'child';
      let runCounter = 0;
      const handle = {
        id,
        name: id,
        status: () => ({ id, state: 'idle', toolNames: [] }),
        async run(_input: unknown) {
          runCounter += 1;
          const runId = `${id}-run-${runCounter}`;
          childEvents.publish({
            type: 'run.started',
            run_id: runId,
            data: { run_id: runId, agentId: id },
            ts: 10,
            seq: 41,
            tenant_id: 'child_tenant',
          });
          childEvents.publish({
            type: 'llm.response',
            run_id: runId,
            data: { agentId: id, finish_reason: 'stop' },
            ts: 11,
            seq: 42,
            tenant_id: 'child_tenant',
          });
          return {
            id: runId,
            result: Promise.resolve('done'),
            usage: () => usage,
          };
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

  return { host, childEvents };
}

function history(events: MemoryEventStream): RunEvent[] {
  return events.getHistory();
}

describe('delegate-task tenant scope', () => {
  it('stamps its own events and preserves seq/tenant on forwarded events', async () => {
    const { host: runtimeHost } = makeFakeHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      tenantId: 'acme',
      runtimeHost,
    });
    const pluginHost = new MemoryPluginHost();
    plugin.install(pluginHost);
    const tool = pluginHost.getTool('delegate_task');
    expect(tool).toBeDefined();

    const parentEvents = new MemoryEventStream();
    await tool?.handler(
      { task: 'hello' },
      { run_id: 'parent-run', messages: [], events: parentEvents },
    );

    const events = history(parentEvents);
    const started = events.find((event) => event.type === 'subagent.delegate.started');
    const completed = events.find((event) => event.type === 'subagent.delegate.completed');
    expect(started?.tenant_id).toBe('acme');
    expect(completed?.tenant_id).toBe('acme');

    const forwardedStarted = events.find((event) => event.type === 'subagent.run.started');
    const forwardedLlm = events.find((event) => event.type === 'subagent.llm.response');
    expect(forwardedStarted).toMatchObject({ seq: 41, tenant_id: 'child_tenant' });
    expect(forwardedLlm).toMatchObject({ seq: 42, tenant_id: 'child_tenant' });
  });

  it('adds tenant_id to forwarded events that lack it', async () => {
    const childEvents = new MemoryEventStream();
    const runtimeHost = {
      events: childEvents,
      async spawn(spec: AgentSpec): Promise<AgentHandle> {
        const id = spec.id ?? 'child';
        return {
          id,
          name: id,
          status: () => ({ id, state: 'idle', toolNames: [] }),
          async run() {
            childEvents.publish({
              type: 'run.started',
              run_id: 'child-run',
              data: { run_id: 'child-run', agentId: id },
              ts: 1,
            });
            return { id: 'child-run', result: Promise.resolve('done'), usage: () => usage };
          },
          async close() {},
        } as unknown as AgentHandle;
      },
      get: () => undefined,
      list: () => [],
      async send() {},
      async inbox() {
        return { messages: [], cursor: '' };
      },
      async cancel() {},
      async close() {},
    } as unknown as RuntimeHost;

    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      tenantId: 'acme',
      runtimeHost,
    });
    const pluginHost = new MemoryPluginHost();
    plugin.install(pluginHost);
    const parentEvents = new MemoryEventStream();
    await pluginHost
      .getTool('delegate_task')
      ?.handler({ task: 'hello' }, { run_id: 'parent-run', messages: [], events: parentEvents });

    const forwarded = history(parentEvents).find((event) => event.type === 'subagent.run.started');
    expect(forwarded?.tenant_id).toBe('acme');
    expect('seq' in (forwarded ?? {})).toBe(false);
  });

  it('keeps 0.4 envelopes when tenantId is omitted', async () => {
    const { host: runtimeHost } = makeFakeHost();
    const plugin = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: 'test-model',
      runtimeHost,
    });
    const pluginHost = new MemoryPluginHost();
    plugin.install(pluginHost);
    const parentEvents = new MemoryEventStream();
    await pluginHost
      .getTool('delegate_task')
      ?.handler({ task: 'hello' }, { run_id: 'parent-run', messages: [], events: parentEvents });

    for (const event of history(parentEvents)) {
      if (event.tenant_id === 'child_tenant') continue;
      expect('tenant_id' in event).toBe(false);
    }
  });

  it('rejects an invalid tenant id', () => {
    expect(() =>
      createDelegateTaskPlugin({
        providerFactory: () => new MemoryLLMProvider(),
        model: 'test-model',
        tenantId: 'Bad Tenant',
      }),
    ).toThrow(/invalid tenant id/);
  });
});
