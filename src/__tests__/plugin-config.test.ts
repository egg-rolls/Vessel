import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { MemoryPluginHost, type Plugin, type PluginHost } from '../../packages/core/src/index';
import {
  buildPluginConfigMap,
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

  it('buildPluginConfigMap：显式配置覆盖声明式，未配置的插件不出现', () => {
    expect(
      buildPluginConfigMap(
        [{ name: 'tool-policy', config: { allow: ['edit'] } }, { name: 'basic-tools' }],
        [{ name: 'tool-policy', config: { allow: ['read'], deny: ['bash'] } }],
      ),
    ).toEqual({ 'tool-policy': { allow: ['edit'], deny: ['bash'] } });
    expect(buildPluginConfigMap(undefined, [])).toEqual({});
  });

  it('agentCwd 仅作为 basic-tools 的 cwd 兜底，显式配置优先（0.11.1）', () => {
    expect(buildPluginConfigMap(undefined, [], '/abs/work')).toEqual({
      'basic-tools': { cwd: '/abs/work' },
    });
    expect(
      buildPluginConfigMap(
        [{ name: 'basic-tools', config: { allowed_roots: ['/abs'] } }],
        [],
        '/abs/work',
      ),
    ).toEqual({ 'basic-tools': { allowed_roots: ['/abs'], cwd: '/abs/work' } });
    expect(
      buildPluginConfigMap(
        [{ name: 'basic-tools', config: { cwd: '/explicit' } }],
        [],
        '/abs/work',
      ),
    ).toEqual({ 'basic-tools': { cwd: '/explicit' } });
    // 未设置 agent.cwd 时不注入
    expect(buildPluginConfigMap([{ name: 'basic-tools' }], [])).toEqual({});
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
