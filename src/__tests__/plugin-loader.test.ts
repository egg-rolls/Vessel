import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FACTORY_PLUGINS, PluginLoader } from '../plugin-loader';

/** 读取插件真实 package.json（用于核对 list() 没有臆造元数据） */
function readPkg(category: string, name: string): { name: string; version: string } {
  const path = fileURLToPath(
    new URL(`../../plugins/${category}/${name}/package.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as { name: string; version: string };
}

it('list() 从 package.json 读出 name / category / version / entry', () => {
  const descriptor = new PluginLoader().list().find((d) => d.name === 'hook-logging');

  expect(descriptor).toBeDefined();
  expect(descriptor?.category).toBe('observability');

  const pkg = readPkg('observability', 'hook-logging');
  // package.json 名是 @vessel/hook-logging，descriptor 去掉 scope
  expect(descriptor?.name).toBe(pkg.name.replace(/^@[^/]+\//, ''));
  expect(descriptor?.version).toBe(pkg.version);
  // Windows 下分隔符是 \，比较前统一
  const entry = (descriptor?.entry ?? '').replace(/\\/g, '/');
  expect(entry.endsWith('plugins/observability/hook-logging/src/index.ts')).toBe(true);
});

it('getProviders() 只返回 provider 类插件', () => {
  const loader = new PluginLoader();
  const providers = loader.getProviders();

  expect(providers).toContain('provider-openai');
  expect(providers).toContain('provider-anthropic');
  const providerCategories = new Set(
    loader
      .list()
      .filter((d) => d.category === 'provider')
      .map((d) => d.name),
  );
  expect(new Set(providers)).toEqual(providerCategories);
});

it('getAvailablePlugins() 排除 provider 与工厂式插件', () => {
  const loader = new PluginLoader();
  const available = loader.getAvailablePlugins();

  expect(available).toContain('basic-tools');
  expect(available).toContain('hook-logging');
  expect(available).toContain('guardrail-pii');
  // provider 单独装配，不进 plugins 列表
  for (const name of available) {
    expect(name.startsWith('provider-')).toBe(false);
  }
  // 工厂式插件（default export 是工厂函数）由装配层显式构造
  for (const name of FACTORY_PLUGINS) {
    expect(available).not.toContain(name);
  }
});

it('load() 加载已知插件', async () => {
  const plugin = await new PluginLoader().load('hook-logging');

  expect(plugin).not.toBeNull();
  expect(plugin?.name).toBe('hook-logging');
  expect(typeof plugin?.install).toBe('function');
});

it('load() 未知插件返回 null', async () => {
  expect(await new PluginLoader().load('does-not-exist')).toBeNull();
});
