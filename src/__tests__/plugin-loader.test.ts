import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPluginRoots, FACTORY_PLUGINS, PluginLoader } from '../plugin-loader';

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
  // package.json 名是 @vessel-agent/hook-logging，descriptor 去掉 scope
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

it('refresh() 清空扫描缓存，下一次 list() 重新扫描（0.12）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugin-refresh-'));
  const writePlugin = (name: string): void => {
    const dir = path.join(root, 'cat', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@test/${name}`, version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default {};');
  };

  try {
    writePlugin('one');
    const loader = new PluginLoader({
      roots: [{ dir: root, source: 'user', layout: 'category' }],
    });
    expect(loader.list().map((d) => d.name)).toEqual(['one']);

    writePlugin('two');
    // 缓存仍然生效：不 refresh 看不到新插件目录
    expect(loader.list().map((d) => d.name)).toEqual(['one']);

    loader.refresh();
    expect(loader.list().map((d) => d.name)).toEqual(['one', 'two']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('defaultPluginRoots 顺序为 repo → project → user → node_modules（0.7.1）', () => {
  const roots = defaultPluginRoots();
  const sources = roots.map((root) => root.source);

  expect(sources.slice(0, 3)).toEqual(['repo', 'project', 'user']);
  expect(sources.slice(3).every((source) => source === 'node_modules')).toBe(true);
});

describe('插件目录扩展（0.6.1）', () => {
  function writePlugin(dir: string, name: string): void {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.2.3', main: 'src/index.ts' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      'export default { name: "x", install() {} };\n',
      'utf-8',
    );
  }

  it('扫描用户/项目目录的扁平与分类布局', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugins-'));
    try {
      const repo = path.join(root, 'repo');
      const user = path.join(root, 'user');
      const project = path.join(root, 'project');
      writePlugin(path.join(repo, 'tools', 'basic-tools'), '@vessel-agent/basic-tools');
      writePlugin(path.join(user, 'my-plugin'), '@scope/my-plugin');
      writePlugin(path.join(project, 'security', 'project-policy'), 'project-policy');

      const loader = new PluginLoader({
        roots: [
          { dir: repo, source: 'repo', layout: 'category' },
          { dir: user, source: 'user', layout: 'auto' },
          { dir: project, source: 'project', layout: 'auto' },
        ],
      });

      const byName = new Map(loader.list().map((d) => [d.name, d]));
      expect(byName.get('basic-tools')?.source).toBe('repo');
      expect(byName.get('my-plugin')?.source).toBe('user');
      expect(byName.get('project-policy')?.source).toBe('project');
      expect(byName.get('project-policy')?.category).toBe('security');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同名插件以仓库内为准', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugins-'));
    try {
      const repo = path.join(root, 'repo');
      const user = path.join(root, 'user');
      writePlugin(path.join(repo, 'tools', 'basic-tools'), '@vessel-agent/basic-tools');
      writePlugin(path.join(user, 'basic-tools'), '@vessel-agent/basic-tools');

      const loader = new PluginLoader({
        roots: [
          { dir: repo, source: 'repo', layout: 'category' },
          { dir: user, source: 'user', layout: 'auto' },
        ],
      });

      const hits = loader.list().filter((d) => d.name === 'basic-tools');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.source).toBe('repo');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('node_modules/@vessel-agent 扫描跳过 workspace 包 core/agent/config/tui/serve/permission', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugins-'));
    try {
      const modules = path.join(root, 'node_modules', '@vessel-agent');
      writePlugin(path.join(modules, 'core'), '@vessel-agent/core');
      writePlugin(path.join(modules, 'agent'), '@vessel-agent/agent');
      writePlugin(path.join(modules, 'some-plugin'), '@vessel-agent/some-plugin');

      const loader = new PluginLoader({
        roots: [{ dir: modules, source: 'node_modules', layout: 'flat' }],
      });

      expect(loader.list().map((d) => d.name)).toEqual(['some-plugin']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaultPluginRoots 扫描 @vessel-agent scope（ADR-073），不扫旧 @vessel', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugins-'));
    try {
      const repoDir = path.join(root, 'repo', 'plugins');
      writePlugin(
        path.join(root, 'repo', 'node_modules', '@vessel-agent', 'scope-probe-plugin'),
        '@vessel-agent/scope-probe-plugin',
      );

      const nodeModuleRoots = defaultPluginRoots(repoDir)
        .filter((root2) => root2.source === 'node_modules')
        .map((root2) => path.resolve(root2.dir));

      expect(nodeModuleRoots).toContain(
        path.resolve(root, 'repo', 'node_modules', '@vessel-agent'),
      );
      expect(nodeModuleRoots).toContain(
        path.resolve(process.cwd(), 'node_modules', '@vessel-agent'),
      );
      expect(nodeModuleRoots.some((dir) => path.basename(dir) === '@vessel')).toBe(false);

      // 默认扫描根真的能从 @vessel-agent 发现外部插件
      const loader = new PluginLoader({ repoDir });
      expect(loader.list().find((d) => d.name === 'scope-probe-plugin')?.source).toBe(
        'node_modules',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
