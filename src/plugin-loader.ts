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
 *
 * 0.43：`package.json.vessel` 清单（`src/plugin-manifest.ts`）把体验插件标记为
 * `mode: 'child'`——它们由宿主在子进程运行，**不得**被 in-process loader import。
 * 清单同时存在于旧 `.vessel/plugins/` 与 legacy `.vessel/mods/` 根下。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from '../packages/core/src/index';
import {
  type PluginManifest,
  PluginManifestValidationError,
  validatePluginManifest,
} from './plugin-manifest';

const PLUGINS_DIR = fileURLToPath(new URL('../plugins', import.meta.url));

/** 非插件 workspace 包：即使出现在 `node_modules/@vessel-agent` 也不注册 */
const NON_PLUGIN_PACKAGES: ReadonlySet<string> = new Set([
  'core',
  'agent',
  'config',
  'tui',
  'serve',
  'permission',
]);

/**
 * 默认导出是**工厂函数**而非 Plugin 实例的插件——它们需要装配层注入运行时依赖，
 * 由 bootstrap 自行构造。
 */
export const FACTORY_PLUGINS: ReadonlySet<string> = new Set(['mcp-client', 'evals', 'feishu']);

/** 插件来源 */
export type PluginSource = 'repo' | 'user' | 'project' | 'node_modules';

/** 运行模式：能力插件 in-process；体验插件（vessel 清单 + entry + contributes）child */
export type PluginMode = 'in-process' | 'child';

/** child 模式发现优先级（CONTRACT-0.43 §6：project > user > 内置） */
const SOURCE_PRIORITY: Record<PluginSource, number> = {
  project: 3,
  user: 2,
  repo: 1,
  node_modules: 0,
};

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
  /** 模块入口的绝对路径（child 模式为 `vessel.entry` 解析后的路径） */
  entry: string;
  /** 插件包根目录的绝对路径（child 子进程 cwd / ui.dir 基准） */
  dir: string;
  /** 0.6.1：插件来源 */
  source: PluginSource;
  /** 0.43：in-process = 能力插件；child = 体验插件（由宿主 spawn，不经 loader import） */
  mode: PluginMode;
  /** 0.43：child 模式的 `package.json.vessel` 清单 */
  manifest?: PluginManifest;
  /** 0.43：in-process 插件覆盖同 id 内置插件时，package.json 的 `vessel.override` */
  override?: boolean;
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

const warnedManifestFailures = new Set<string>();

/** 清单校验失败：告警一次，且不加载代码（fail-closed） */
function warnManifestFailure(base: string, error: PluginManifestValidationError): void {
  const key = `${error.code}:${base}`;
  if (warnedManifestFailures.has(key)) return;
  warnedManifestFailures.add(key);
  console.warn(`[${error.code}] ${base}: ${error.message}`);
}

/** 读取单个插件目录；不合格返回 null */
function readPlugin(base: string, category: string, source: PluginSource): PluginDescriptor | null {
  const pkgPath = path.join(base, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // 坏的 package.json，跳过
    return null;
  }
  if (!isRecord(pkg)) return null;

  const rawName = typeof pkg.name === 'string' ? pkg.name : '';
  const shortName = rawName.replace(/^@[^/]+\//, '') || path.basename(base);
  if (source === 'node_modules' && NON_PLUGIN_PACKAGES.has(shortName)) return null;

  // 体验插件：vessel.entry + contributes 同时存在时才走 child 模式。
  const vessel = isRecord(pkg.vessel) ? pkg.vessel : undefined;
  const hasChildEntry = typeof vessel?.entry === 'string' && vessel.entry.trim() !== '';
  if (vessel !== undefined && hasChildEntry) {
    if (vessel.contributes !== undefined && !isRecord(vessel.contributes)) {
      warnManifestFailure(
        base,
        new PluginManifestValidationError(
          'plugin_manifest_invalid',
          'contributes must be an object',
        ),
      );
      return null;
    }
    if (isRecord(vessel.contributes)) {
      const result = validatePluginManifest(vessel, { baseDir: base });
      if (!result.ok) {
        warnManifestFailure(base, result.error);
        return null;
      }
      const manifest = result.manifest;
      const description =
        manifest.description ?? (typeof pkg.description === 'string' ? pkg.description : undefined);
      return {
        name: manifest.id,
        category,
        version: manifest.version,
        ...(description !== undefined ? { description } : {}),
        entry: path.resolve(base, manifest.entry),
        dir: path.resolve(base),
        source,
        mode: 'child',
        manifest,
      };
    }
  }

  const entry = resolveEntry(base, pkg);
  if (!entry) return null;
  const override = vessel?.override === true;
  return {
    name: shortName,
    category,
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
    entry,
    dir: path.resolve(base),
    source,
    mode: 'in-process',
    ...(override ? { override: true } : {}),
  };
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
    // legacy / optional：旧 mod 目录仍可发现（CONTRACT-0.43 §6）；对外统一叫 plugin。
    { dir: path.join(process.cwd(), '.vessel', 'mods'), source: 'project', layout: 'auto' },
    { dir: path.join(os.homedir(), '.vessel', 'mods'), source: 'user', layout: 'auto' },
    {
      dir: path.join(repoRoot, 'node_modules', '@vessel-agent'),
      source: 'node_modules',
      layout: 'flat',
    },
    {
      dir: path.join(process.cwd(), 'node_modules', '@vessel-agent'),
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

  /**
   * 重新扫描所有发现根并返回新描述符（不重启进程）。
   * 先丢弃缓存，保证不会拿到旧结果；已加载的插件实例不受影响。
   */
  rescan(): PluginDescriptor[] {
    this.refresh();
    return this.list();
  }

  /** 全部插件（含 provider 与工厂式），按名字排序；同名先出现者胜出 */
  list(): PluginDescriptor[] {
    this.cached ??= this.scan();
    return this.cached;
  }

  /** 0.43：child 模式（体验插件）描述符；由宿主 spawn，不经 in-process import */
  getChildMods(): PluginDescriptor[] {
    return this.list().filter((descriptor) => descriptor.mode === 'child');
  }

  /** 0.43：in-process（能力插件）描述符 */
  getInProcessPlugins(): PluginDescriptor[] {
    return this.list().filter((descriptor) => descriptor.mode === 'in-process');
  }

  /** LLM provider 插件名 */
  getProviders(): string[] {
    return this.list()
      .filter(
        (descriptor) => descriptor.mode === 'in-process' && descriptor.category === 'provider',
      )
      .map((descriptor) => descriptor.name);
  }

  /** 可直接 `load()` 的插件名：排除 provider（单独装配）、工厂式与 child 插件 */
  getAvailablePlugins(): string[] {
    return this.list()
      .filter(
        (descriptor) =>
          descriptor.mode === 'in-process' &&
          descriptor.category !== 'provider' &&
          !FACTORY_PLUGINS.has(descriptor.name),
      )
      .map((descriptor) => descriptor.name);
  }

  /**
   * 原样加载插件模块（不要求 default 是 Plugin）。
   * 工厂式插件（如 `@vessel-agent/mcp-client` 的 `createMcpPlugin`）由装配层自行构造。
   * child 插件（体验插件）不得 import；未知插件或 import 失败返回 null。
   */
  async loadModule(name: string): Promise<unknown | null> {
    const descriptor = this.list().find((d) => d.name === name);
    if (!descriptor || descriptor.mode === 'child') return null;

    try {
      return await import(pathToFileURL(descriptor.entry).href);
    } catch (e) {
      console.warn(`Failed to load plugin module "${name}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * 加载 in-process 插件；未知插件、child 插件、或默认导出不是 Plugin 时返回
   * null / undefined（child 插件返回 undefined，表示「不是 in-process 模块」）。
   */
  async load(name: string): Promise<Plugin | null | undefined> {
    const descriptor = this.list().find((d) => d.name === name);
    if (!descriptor) return null;
    if (descriptor.mode === 'child') return undefined;

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
    const inProcessCandidates = new Map<string, PluginDescriptor[]>();
    const childCandidates = new Map<string, PluginDescriptor[]>();

    const collect = (
      target: Map<string, PluginDescriptor[]>,
      descriptor: PluginDescriptor,
    ): void => {
      const list = target.get(descriptor.name) ?? [];
      list.push(descriptor);
      target.set(descriptor.name, list);
    };

    for (const root of this.roots) {
      for (const descriptor of scanRoot(root)) {
        collect(descriptor.mode === 'child' ? childCandidates : inProcessCandidates, descriptor);
      }
    }

    // 两种模式统一优先级（CONTRACT-0.43 §6）：project > user > 内置 > node_modules。
    // 同 id 高优先级胜出；覆盖内置插件必须在 package.json 声明 `vessel.override: true`。
    for (const [id, candidates] of inProcessCandidates) {
      byName.set(id, resolveSourceConflict(id, candidates));
    }

    // 同 id 同时是 in-process 与 child 时保持确定性：保留 in-process 并告警。
    for (const [id, candidates] of childCandidates) {
      const winner = resolveSourceConflict(id, candidates);
      const existing = byName.get(id);
      if (existing !== undefined) {
        console.warn(
          `[plugin_id_conflict] "${id}" is both an in-process plugin (${existing.source}) and a child plugin (${winner.source}); keeping the in-process plugin.`,
        );
        continue;
      }
      byName.set(id, winner);
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** 同 id 冲突：高优先级胜出；覆盖内置插件必须显式 override */
function resolveSourceConflict(id: string, candidates: PluginDescriptor[]): PluginDescriptor {
  const sorted = [...candidates].sort(
    (a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0),
  );
  const first = sorted[0];
  if (first === undefined) throw new Error(`no candidates for plugin "${id}"`);
  let winner = first;
  const builtin = sorted.find((descriptor) => descriptor.source === 'repo');
  const overrides = winner.manifest?.override === true || winner.override === true;
  if (builtin !== undefined && winner.source !== 'repo' && !overrides) {
    console.warn(
      `[plugin_id_conflict] plugin "${id}" from ${winner.source} overrides a built-in without "vessel.override": true; keeping the built-in.`,
    );
    winner = builtin;
  } else if (sorted.length > 1) {
    const shadowed = sorted
      .filter((descriptor) => descriptor !== winner)
      .map((descriptor) => descriptor.source)
      .join(', ');
    console.warn(`[plugin_id_conflict] plugin "${id}" from ${winner.source} shadows ${shadowed}.`);
  }
  return winner;
}
