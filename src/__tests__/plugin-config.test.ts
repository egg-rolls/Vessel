import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryPluginHost, type Plugin, type PluginHost } from '../../packages/core/src/index';
import {
  buildTeamMemberHost,
  declarativePluginEntries,
  installWithConfig,
  pluginConfigFor,
  withPluginConfig,
} from '../plugin-config';

function fakeHost(): PluginHost {
  return new MemoryPluginHost();
}

describe('installWithConfig（0.6.1 E1）', () => {
  it('无配置时保持旧的一参调用', async () => {
    let received: unknown[] = [];
    const plugin = {
      name: 'p',
      install(...args: unknown[]) {
        received = args;
      },
    } as unknown as Plugin;
    await installWithConfig(plugin, fakeHost(), undefined);
    expect(received).toHaveLength(1);
  });

  it('有配置时传 { config }', async () => {
    let received: unknown;
    const plugin = {
      name: 'p',
      install(_host: PluginHost, options?: { config?: Record<string, unknown> }) {
        received = options;
      },
    } as unknown as Plugin;

    await installWithConfig(plugin, fakeHost(), { allow: ['read'] });
    expect(received).toEqual({ config: { allow: ['read'] } });
  });

  it('withPluginConfig 包装后由 install(host) 自动透传', async () => {
    let received: unknown;
    const plugin = {
      name: 'tool-policy',
      version: '1.0.0',
      install(_host: PluginHost, options?: { config?: Record<string, unknown> }) {
        received = options;
      },
    } as unknown as Plugin;

    const wrapped = withPluginConfig(plugin, { deny: ['bash'] });
    expect(wrapped.name).toBe('tool-policy');
    await wrapped.install(fakeHost());
    expect(received).toEqual({ config: { deny: ['bash'] } });
  });
});

describe('声明式 guardrails / hooks（0.6.1 P2）', () => {
  it('按 name 合并 config 并去重', () => {
    const config = {
      guardrails: [
        { name: 'tool-policy', config: { allow: ['read'] } },
        { name: 'redact-secrets', enabled: false },
      ],
      hooks: [{ name: 'tool-policy', config: { deny: ['bash'] } }, { name: 'hook-logging' }],
    } as unknown as VesselConfig;

    expect(declarativePluginEntries(config)).toEqual([
      { name: 'tool-policy', config: { allow: ['read'], deny: ['bash'] } },
      { name: 'redact-secrets', enabled: false },
      { name: 'hook-logging' },
    ]);
  });

  it('显式 plugins[].config 覆盖声明式 config', () => {
    expect(
      pluginConfigFor(
        'tool-policy',
        [{ name: 'tool-policy', config: { allow: ['edit'] } }],
        [{ name: 'tool-policy', config: { allow: ['read'], deny: ['bash'] } }],
      ),
    ).toEqual({ allow: ['edit'], deny: ['bash'] });
    expect(pluginConfigFor('tool-policy', undefined, [])).toBeUndefined();
  });
});

describe('buildTeamMemberHost（0.6.1 E10）', () => {
  function tool(name: string) {
    return { name, description: name, inputSchema: {}, handler: async () => '' };
  }

  it('成员宿主排除 team_* 工具并保留其它工具', () => {
    const host = fakeHost();
    host.registerTool(tool('bash'));
    host.registerTool(tool('team_spawn'));
    host.registerTool(tool('team_send'));

    const child = buildTeamMemberHost(host);
    expect(child.listTools().map((entry) => entry.name)).toEqual(['bash']);
  });
});
