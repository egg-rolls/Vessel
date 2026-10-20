import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import type { Guardrail } from '../src/types/guardrail';
import { GuardrailStage } from '../src/types/guardrail';
import type { Hook } from '../src/types/hook';
import { HookType } from '../src/types/hook';
import type { Plugin } from '../src/types/plugin';
import type { ProviderFactory } from '../src/types/provider';
import type { ToolDefinition } from '../src/types/tool';

function baseOptions(events = new MemoryEventStream()) {
  return {
    provider: new MemoryLLMProvider(),
    model: 'test-model',
    context: new MemoryContextManager(),
    events,
    limits: {},
    termination: { maxIterations: 3 },
  };
}

function makeTool(name: string): ToolDefinition {
  return { name, description: name, inputSchema: {}, handler: async () => 'ok' };
}

const providerFactory: ProviderFactory = () => ({
  chat: async () => ({ content: 'ok', finish_reason: 'stop' }),
});

function makeGuardrail(name: string): Guardrail {
  return { name, stage: GuardrailStage.Input, check: async () => ({ allowed: true }) };
}

function makeHook(name: string): Hook {
  return { name, type: HookType.BeforeLlm, run: async () => {} };
}

describe('plugin lifecycle v2 (0.9)', () => {
  it('initializes plugins in installation order after install', async () => {
    const order: string[] = [];
    const plugin = (name: string): Plugin => ({
      name,
      install() {
        order.push(`install:${name}`);
      },
      init() {
        order.push(`init:${name}`);
      },
    });

    await AgentRuntime.create({ ...baseOptions(), plugins: [plugin('a'), plugin('b')] });

    expect(order).toEqual(['install:a', 'install:b', 'init:a', 'init:b']);
  });

  it('passes the host to init', async () => {
    const host = new MemoryPluginHost();
    let seenHost: unknown;
    const plugin: Plugin = {
      name: 'ctx',
      install() {},
      init(ctx) {
        seenHost = ctx.host;
      },
    };

    await AgentRuntime.create({ ...baseOptions(), pluginHost: host, plugins: [plugin] });

    expect(seenHost).toBe(host);
  });

  it('isolates init failures and continues with later plugins', async () => {
    const events = new MemoryEventStream();
    const initialized: string[] = [];
    const plugins: Plugin[] = [
      {
        name: 'broken',
        install() {},
        init() {
          throw new Error('init boom');
        },
      },
      {
        name: 'healthy',
        install() {},
        init() {
          initialized.push('healthy');
        },
      },
    ];

    const runtime = await AgentRuntime.create({ ...baseOptions(events), plugins });

    expect(initialized).toEqual(['healthy']);
    const failed = events.getHistory().find((e) => e.type === 'plugin.init.failed');
    expect(failed?.data).toMatchObject({ name: 'broken', error: 'init boom' });
    await runtime.dispose();
  });

  it('rolls back all four registration kinds when install throws', async () => {
    const events = new MemoryEventStream();
    const host = new MemoryPluginHost();
    const fallbackTool = makeTool('existing');
    host.registerTool(fallbackTool);

    const keptTool = makeTool('kept');
    const goodPlugin: Plugin = {
      name: 'good',
      install(h) {
        h.registerTool(keptTool);
      },
    };
    const tool = makeTool('rolled-back-tool');
    const guardrail = makeGuardrail('rolled-back-guardrail');
    const hook = makeHook('rolled-back-hook');
    const badPlugin: Plugin = {
      name: 'bad',
      install(h) {
        h.registerTool(tool);
        h.registerProvider('rolled-back-provider', providerFactory);
        h.registerGuardrail(guardrail);
        h.registerHook(hook);
        throw new Error('install boom');
      },
    };

    await expect(
      AgentRuntime.create({
        ...baseOptions(events),
        pluginHost: host,
        plugins: [goodPlugin, badPlugin],
      }),
    ).rejects.toThrow('install boom');

    expect(host.getTool('rolled-back-tool')).toBeUndefined();
    expect(host.getProvider('rolled-back-provider')).toBeUndefined();
    expect(host.getGuardrails()).not.toContain(guardrail);
    expect(host.getHooks()).not.toContain(hook);
    expect(host.getTool('kept')).toBe(keptTool);
    expect(host.getTool('existing')).toBe(fallbackTool);

    const failed = events.getHistory().find((e) => e.type === 'plugin.failed');
    expect(failed?.data).toMatchObject({ name: 'bad', error: 'install boom' });
  });

  it('does not remove a pre-existing entry when a plugin hits a duplicate name', async () => {
    const host = new MemoryPluginHost();
    const existing = makeTool('existing');
    host.registerTool(existing);
    const plugin: Plugin = {
      name: 'duplicate',
      install(h) {
        h.registerTool(makeTool('fresh'));
        h.registerTool(makeTool('existing'));
      },
    };

    await expect(
      AgentRuntime.create({ ...baseOptions(), pluginHost: host, plugins: [plugin] }),
    ).rejects.toThrow('already registered');

    expect(host.getTool('fresh')).toBeUndefined();
    expect(host.getTool('existing')).toBe(existing);
  });

  it('disposes plugins in reverse installation order', async () => {
    const order: string[] = [];
    const plugin = (name: string): Plugin => ({
      name,
      install() {},
      dispose() {
        order.push(name);
      },
    });

    const runtime = await AgentRuntime.create({
      ...baseOptions(),
      plugins: [plugin('a'), plugin('b'), plugin('c')],
    });
    await runtime.dispose();

    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('isolates dispose failures, closes the session last, and is idempotent', async () => {
    const events = new MemoryEventStream();
    const order: string[] = [];
    let closed = 0;
    const plugins: Plugin[] = [
      {
        name: 'first',
        install() {},
        dispose() {
          order.push('first');
        },
      },
      {
        name: 'throwing',
        install() {},
        dispose() {
          order.push('throwing');
          throw new Error('dispose boom');
        },
      },
    ];

    const runtime = await AgentRuntime.create({
      ...baseOptions(events),
      session: {
        save: async () => {},
        load: async () => null,
        list: async () => [],
        listRich: async () => [],
        delete: async () => {},
        close: () => {
          closed += 1;
          order.push('session');
        },
      },
      plugins,
    });

    await runtime.dispose();
    await runtime.dispose();

    expect(order).toEqual(['throwing', 'first', 'session']);
    expect(closed).toBe(1);
    const failed = events.getHistory().find((e) => e.type === 'plugin.dispose.failed');
    expect(failed?.data).toMatchObject({ name: 'throwing', error: 'dispose boom' });
  });
});
