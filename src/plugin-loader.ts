/**
 * 插件加载器 —— 运行时扫描插件目录并动态 import 入口。
 *
 * 扫描顺序（同名插件先出现者胜出）：
 *   1. 仓库内 `plugins/<category>/<name>/`（内置插件，权威）；
 *   2. 项目目录 `./.vessel/plugins/`（扁平 `<name>/` 或 `<category>/<name>/`）；
 *   3. 用户目录 `~/.vessel/plugins/`（同上）；
 *   4. `node_modules/@vessel-agent/*`（仓库根与 cwd；跳过 core/config/tui/serve/permission）。
 *
 * 项目优先于用户：项目级插件覆盖同名用户级插件，仓库内插件覆盖两者。
 *
 * 放一个 `package.json` + 入口（`src/index.ts`，或 package.json 的 exports/main）即注册，
 * 无需改代码、无需构建步骤。默认导出须是 `Plugin`（含 `install()`）。
 *
 * 插件目录在进程启动时扫描一次（结果缓存），安装/移除后需重启进程。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from '../packages/core/src/index';

const PLUGINS_DIR = fileURLToPath(new URL('../plugins', import.meta.url));

/** 非插件 workspace 包：即使出现在 `node_modules/@vessel` 也不注册 */
const NON_PLUGIN_PACKAGES: ReadonlySet<string> = new Set([
  'core',
  'config',
  'tui',
  'serve',
  'permission',
]);

/**
 * 默认导出是**工厂函数**而非 Plugin 实例的插件——它们需要装配层注入运行时依赖，
 * 由 bootstrap 自行构造。
 */
export const FACTORY_PLUGINS: ReadonlySet<string> = new Set([
  'mcp-client',
  'workflow',
  'evals',
  'feishu',
]);

/** 插件来源 */
export type PluginSource = 'repo' | 'user' | 'project' | 'node_modules';

/** 扫描根 */
export interface PluginRoot {
  dir: string;
  source: PluginSource;
  /** category = `<category>/<name>`；flat = `<name>`；auto = 两者都试 */
  layout: 'category' | 'flat' | 'auto';
}

/** 加载器选项（测试可注入 roots） */
export interface PluginLoaderOptions {
  repoDir?: string;
  /** 显式扫描根；提供时忽略其它选项 */
  roots?: PluginRoot[];
}

export interface PluginDescriptor {
  /** 短名（package.json name 去掉 scope），即调用 `load()` 时用的 key */
  name: string;
  /** 分类目录名（仓库内）或来源标签（用户/项目/node_modules） */
  category: string;
  version: string;
  description?: string;
  /** 模块入口的绝对路径 */
  entry: string;
  /** 0.6.1：插件来源 */
  source: PluginSource;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 package.json 解析入口；找不到返回 null */
function resolveEntry(base: string, pkg: Record<string, unknown>): string | null {
  const candidates: string[] = [];
  const exportsField = pkg.exports;
  if (typeof exportsField === 'string') {
    candidates.push(exportsField);
  } else if (isRecord(exportsField)) {
    const dot = exportsField['.'];
    if (typeof dot === 'string') {
      candidates.push(dot);
    } else if (isRecord(dot)) {
      for (const key of ['bun', 'import', 'default', 'require']) {
        const value = dot[key];
        if (typeof value === 'string') candidates.push(value);
      }
    }
  }
  if (typeof pkg.module === 'string') candidates.push(pkg.module);
  if (typeof pkg.main === 'string') candidates.push(pkg.main);
  candidates.push('src/index.ts', 'index.ts');

  for (const candidate of candidates) {
    const resolved = path.resolve(base, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

/** 读取单个插件目录；不合格返回 null */
function readPlugin(base: string, category: string, source: PluginSource): PluginDescriptor | null {
  const pkgPath = path.join(base, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const entry = resolveEntry(base, pkg);
    if (!entry) return null;
    const rawName = typeof pkg.name === 'string' ? pkg.name : '';
    const shortName = rawName.replace(/^@[^/]+\//, '') || path.basename(base);
    if (source === 'node_modules' && NON_PLUGIN_PACKAGES.has(shortName)) return null;
    return {
      name: shortName,
      category,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
      entry,
      source,
    };
  } catch {
    // 坏的 package.json，跳过
    return null;
  }
}

/** 扫描一个根；支持 category/flat/auto 三种布局 */
function scanRoot(root: PluginRoot): PluginDescriptor[] {
  const out: PluginDescriptor[] = [];
  const top = readDirs(root.dir);

  for (const child of top) {
    const childDir = path.join(root.dir, child);
    const isPlugin = fs.existsSync(path.join(childDir, 'package.json'));

    if (root.layout === 'flat' || (root.layout === 'auto' && isPlugin)) {
      const descriptor = readPlugin(childDir, root.source, root.source);
      if (descriptor) out.push(descriptor);
      continue;
    }

    if (root.layout === 'category' || root.layout === 'auto') {
      for (const nested of readDirs(childDir)) {
        const descriptor = readPlugin(path.join(childDir, nested), child, root.source);
        if (descriptor) out.push(descriptor);
      }
    }
  }

  return out;
}

/** 默认扫描根；同名去重由 `PluginLoader.scan()` 负责 */
export function defaultPluginRoots(repoDir: string = PLUGINS_DIR): PluginRoot[] {
  const repoRoot = path.dirname(repoDir);
  const roots: PluginRoot[] = [
    { dir: repoDir, source: 'repo', layout: 'category' },
    { dir: path.join(process.cwd(), '.vessel', 'plugins'), source: 'project', layout: 'auto' },
    { dir: path.join(os.homedir(), '.vessel', 'plugins'), source: 'user', layout: 'auto' },
    {
      dir: path.join(repoRoot, 'node_modules', '@vessel'),
      source: 'node_modules',
      layout: 'flat',
    },
    {
      dir: path.join(process.cwd(), 'node_modules', '@vessel'),
      source: 'node_modules',
      layout: 'flat',
    },
  ];

  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 插件加载器。扫描结果默认缓存（插件目录在进程生命周期内通常不变）；
 * `gateway.reload` 可用 `refresh()` 让下一次 `list()` 重新扫描。
 */
export class PluginLoader {
  private readonly roots: PluginRoot[];
  private cached?: PluginDescriptor[];

  constructor(options: PluginLoaderOptions | string = {}) {
    if (typeof options === 'string') {
      this.roots = [{ dir: options, source: 'repo', layout: 'category' }];
    } else if (options.roots !== undefined) {
      this.roots = options.roots;
    } else {
      this.roots = defaultPluginRoots(options.repoDir);
    }
  }

  /**
   * 丢弃扫描缓存，下一次 `list()` 重新扫描插件目录（0.12 DECISION-023 §2.3）。
   * 只影响目录发现：已安装插件、pluginHost 与正在跑的 run 不受影响。
   */
  refresh(): void {
    this.cached = undefined;
  }

  /** 全部插件（含 provider 与工厂式），按名字排序；同名先出现者胜出 */
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
   * 工厂式插件（如 `@vessel-agent/mcp-client` 的 `createMcpPlugin`）由装配层自行构造。
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
    const byName = new Map<string, PluginDescriptor>();

    for (const root of this.roots) {
      for (const descriptor of scanRoot(root)) {
        // 仓库内插件优先；用户/项目/node_modules 同名不覆盖内置插件。
        if (!byName.has(descriptor.name)) byName.set(descriptor.name, descriptor);
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
