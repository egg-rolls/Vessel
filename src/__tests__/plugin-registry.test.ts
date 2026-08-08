import { expect, it } from 'bun:test';
import { StaticRegistry } from '../plugin-registry';

it('getProviders() 只返回 provider 插件', () => {
  const registry = new StaticRegistry();
  const providers = registry.getProviders();
  expect(providers).toContain('provider-openai');
  expect(providers).toContain('provider-anthropic');
  for (const name of providers) {
    expect(name.startsWith('provider-')).toBe(true);
  }
});

it('getAvailablePlugins() 排除 provider-*', () => {
  const registry = new StaticRegistry();
  const available = registry.getAvailablePlugins();
  expect(available).toContain('meta-tools');
  expect(available).toContain('skills-loader');
  expect(available).toContain('hook-logging');
  for (const name of available) {
    expect(name.startsWith('provider-')).toBe(false);
  }
});

it('loadPlugin() 加载已知内置插件', async () => {
  const registry = new StaticRegistry();
  const plugin = await registry.loadPlugin('meta-tools');
  expect(plugin).not.toBeNull();
  expect(typeof plugin?.install).toBe('function');
});

it('loadPlugin() 未知插件返回 null', async () => {
  const registry = new StaticRegistry();
  expect(await registry.loadPlugin('does-not-exist')).toBeNull();
});
