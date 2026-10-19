import { describe, expect, it } from 'bun:test';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { MemoryLLMProvider } from '../src/provider/providers';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import type { Plugin, PluginHost, PluginInstallOptions } from '../src/types/plugin';

function baseOptions() {
  return {
    provider: new MemoryLLMProvider(),
    model: 'test-model',
    context: new MemoryContextManager(),
    events: new MemoryEventStream(),
    limits: {},
    termination: { maxIterations: 10 },
  };
}

describe('Plugin.install options (0.6.1 E1)', () => {
  it('keeps legacy install(host) working', async () => {
    let installed = false;
    const plugin: Plugin = {
      name: 'legacy',
      install(_host: PluginHost) {
        installed = true;
      },
    };

    await AgentRuntime.create({ ...baseOptions(), plugins: [plugin] });
    expect(installed).toBe(true);
  });

  it('forwards config by plugin name and omits options otherwise', async () => {
    const seen: Array<{ name: string; options: PluginInstallOptions | undefined }> = [];
    const make = (name: string): Plugin => ({
      name,
      install(_host, options) {
        seen.push({ name, options });
      },
    });

    await AgentRuntime.create({
      ...baseOptions(),
      plugins: [make('configured'), make('plain')],
      pluginConfigs: { configured: { mode: 'deny', allow: ['read'] } },
    });

    expect(seen).toEqual([
      { name: 'configured', options: { config: { mode: 'deny', allow: ['read'] } } },
      { name: 'plain', options: undefined },
    ]);
  });
});
