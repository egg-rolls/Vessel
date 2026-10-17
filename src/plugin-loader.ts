/**
 * 插件加载器 —— 运行时扫描 `plugins/<category>/<name>/` 并动态 import 入口。
 *
 * 这是唯一的插件发现机制。此前并存四套（构建时生成的注册表 / 手维护的静态映射表 /
 * 用户目录扫描 / vessel.yaml 声明式连接），已合并到这里（ADR-028 的运行时扫描）。
 *
 * 放一个 `plugins/<category>/<name>/package.json` + `src/index.ts` 即注册，
 * 无需改代码、无需构建步骤。默认导出须是 `Plugin`（含 `install()`）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from '../packages/core/src/index';

const PLUGINS_DIR = fileURLToPath(new URL('../plugins', import.meta.url));

/**
 * 默认导出是**工厂函数**而非 Plugin 实例的插件——它们需要装配层注入运行时依赖
 * （如 delegate-task 需要 provider 工厂与 model），由 bootstrap 自行构造。
 */
export const FACTORY_PLUGINS: ReadonlySet<string> = new Set([
  'delegate-task',
  'team',
  'mcp-client',
]);

export interface PluginDescriptor {
  /** 短名（package.json name 去掉 scope），即调用 `load()` 时用的 key */
  name: string;
  /** 分类目录名：`plugins/<category>/<name>/` */
  category: string;
  version: string;
  description?: string;
  /** 模块入口的绝对路径 */
  entry: string;
}

/** 读取目录下的子目录名；目录不存在返回空 */
function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 插件加载器。扫描结果缓存一次——插件目录在进程生命周期内不变。
 */
export class PluginLoader {
  private readonly dir: string;
  private cached?: PluginDescriptor[];

  constructor(dir: string = PLUGINS_DIR) {
    this.dir = dir;
  }

  /** 全部插件（含 provider 与工厂式），按名字排序 */
  list(): PluginDescriptor[] {
    this.cached ??= this.scan();
    return this.cached;
  }

  /** LLM provider 插件名 */
  getProviders(): string[] {
    return this.list()
      .filter((d) => d.category === 'provider')
      .map((d) => d.name);
  }

  /** 可直接 `load()` 的插件名：排除 provider（单独装配）与工厂式插件 */
  getAvailablePlugins(): string[] {
    return this.list()
      .filter((d) => d.category !== 'provider' && !FACTORY_PLUGINS.has(d.name))
      .map((d) => d.name);
  }

  /**
   * 原样加载插件模块（不要求 default 是 Plugin）。
   * 工厂式插件（如 `@vessel/mcp-client` 的 `createMcpPlugin`）由装配层自行构造。
   * 未知插件或 import 失败返回 null。
   */
  async loadModule(name: string): Promise<unknown | null> {
    const descriptor = this.list().find((d) => d.name === name);
    if (!descriptor) return null;

    try {
      return await import(pathToFileURL(descriptor.entry).href);
    } catch (e) {
      console.warn(`Failed to load plugin module "${name}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 加载插件；未知插件、或默认导出不是 Plugin 时返回 null */
  async load(name: string): Promise<Plugin | null> {
    const descriptor = this.list().find((d) => d.name === name);
    if (!descriptor) return null;

    try {
      const mod = (await import(pathToFileURL(descriptor.entry).href)) as { default?: unknown };
      const plugin = mod.default as Plugin | undefined;
      if (!plugin || typeof plugin.install !== 'function') {
        console.warn(`Plugin "${name}" has no default export with install(). Skipping.`);
        return null;
      }
      return plugin;
    } catch (e) {
      console.warn(`Failed to load plugin "${name}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private scan(): PluginDescriptor[] {
    const descriptors: PluginDescriptor[] = [];

    for (const category of readDirs(this.dir)) {
      for (const pluginDir of readDirs(path.join(this.dir, category))) {
        const base = path.join(this.dir, category, pluginDir);
        const pkgPath = path.join(base, 'package.json');
        const entry = path.join(base, 'src', 'index.ts');
        if (!fs.existsSync(pkgPath) || !fs.existsSync(entry)) continue;

        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
            name?: string;
            version?: string;
            description?: string;
          };
          descriptors.push({
            // `@vessel/delegate-task` → `delegate-task`
            name: (pkg.name ?? '').replace(/^@[^/]+\//, '') || pluginDir,
            category,
            version: pkg.version ?? '0.0.0',
            description: pkg.description,
            entry,
          });
        } catch {
          // 坏的 package.json，跳过
        }
      }
    }

    return descriptors.sort((a, b) => a.name.localeCompare(b.name));
  }
}
