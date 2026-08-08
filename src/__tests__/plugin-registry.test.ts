import { expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { ConfigDeclared } from '../config-declared';
import { CompositeProvider, StaticRegistry } from '../plugin-registry';

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

it('CompositeProvider 组合内置 + 用户 Provider', async () => {
  const config: VesselConfig = {
    tools: [{ name: 'declared-tool', command: 'echo hi' }],
  };
  const composite = new CompositeProvider([new StaticRegistry(), new ConfigDeclared(config)]);

  // 内置插件 + 声明工具合并
  expect(composite.getAvailablePlugins()).toContain('meta-tools');
  expect(composite.getAvailablePlugins()).toContain('declared-tool');
  // provider 透传
  expect(composite.getProviders()).toContain('provider-openai');
  // 加载：内置优先
  const builtin = await composite.loadPlugin('meta-tools');
  expect(builtin?.name).toBe('meta-tools');
  // 加载：用户声明
  const declared = await composite.loadPlugin('declared-tool');
  expect(declared?.name).toBe('declared-tool');
  // 未知插件不产生告警、返回 null
  expect(await composite.loadPlugin('does-not-exist')).toBeNull();
});
