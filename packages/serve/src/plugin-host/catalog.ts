/**
 * Plugin catalog —— 宿主统一插件视图（CONTRACT-0.47 §3）。
 *
 * 纯函数：只读 `entries`（tenant 作用域的 plugins.list 数据源）、`descriptors`
 * （loader 发现结果）与 `statuses`（plugin host manager），推导 catalog 字段。
 * 不写 config、不访问网络、不读盘；缺 descriptor 的 entry 跳过，不伪造。
 *
 * serve **不** import `src/`：descriptor 用结构镜像（与 plugin-host 既有做法一致）。
 *
 * @module @vessel-agent/serve/plugin-host/catalog
 */

import { toPluginListStatus } from './manager.js';
import type { PluginListStatus, PluginMode, PluginRuntimeStatus } from './types.js';

/** 发现来源：内置 / 用户 / 项目 / node_modules */
export type PluginCatalogScope = 'builtin' | 'user' | 'project' | 'node_modules';

/** builtin：随宿主发布；marketplace：外部安装的体验插件；dynamic：外部能力插件 */
export type PluginCatalogKind = 'builtin' | 'marketplace' | 'dynamic';

/** `plugins.list` 的条目（tenant 作用域；catalog 与它同源）。 */
export interface PluginCatalogEntry {
  name: string;
  enabled: boolean;
}

/** loader `PluginDescriptor` 的结构镜像（只取 catalog 需要的字段）。 */
export interface PluginCatalogDescriptor {
  name: string;
  version: string;
  entry?: string;
  /** 插件包根目录的绝对路径（catalog `path`）。 */
  dir: string;
  source: 'repo' | 'user' | 'project' | 'node_modules';
  mode: PluginMode;
  /** child 插件的 `package.json.vessel` 清单（原样透传）。 */
  manifest?: unknown;
}

/** plugin host manager 的状态条目（只取 catalog 需要的字段）。 */
export interface PluginCatalogStatusEntry {
  id: string;
  status: PluginRuntimeStatus;
}

export interface PluginCatalogInput {
  entries: readonly PluginCatalogEntry[];
  descriptors: ReadonlyMap<string, PluginCatalogDescriptor>;
  statuses?: readonly PluginCatalogStatusEntry[];
}

/** 宿主输出的统一插件视图（CONTRACT-0.47 §3）。 */
export interface PluginCatalogItem {
  id: string;
  name: string;
  version: string;
  scope: PluginCatalogScope;
  kind: PluginCatalogKind;
  mode: PluginMode;
  enabled: boolean;
  /** 写 config 后是否允许切换；v1 恒为 true。 */
  supportsToggle: boolean;
  /** in-process 插件切换后需要重启 gateway 才真正卸载。 */
  restartRequired: boolean;
  status?: PluginListStatus;
  /** 插件目录绝对路径（本地控制台展示；不含密钥）。 */
  path: string;
  entry?: string;
  /** child 插件清单；原样透传，不内联 update / registry 信息。 */
  manifest?: unknown;
}

function toCatalogScope(source: PluginCatalogDescriptor['source']): PluginCatalogScope {
  return source === 'repo' ? 'builtin' : source;
}

/** builtin → builtin；child → marketplace；其余非 builtin → dynamic。 */
function toCatalogKind(scope: PluginCatalogScope, mode: PluginMode): PluginCatalogKind {
  if (scope === 'builtin') return 'builtin';
  return mode === 'child' ? 'marketplace' : 'dynamic';
}

/** 展示名：child 清单的 `name` 优先，否则用 loader 的短名。 */
function displayName(descriptor: PluginCatalogDescriptor): string {
  const manifest = descriptor.manifest;
  if (typeof manifest === 'object' && manifest !== null) {
    const name = (manifest as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return descriptor.name;
}

/** 稳定排序：按 id 码点比较，不依赖 locale。 */
function compareId(a: PluginCatalogItem, b: PluginCatalogItem): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * 由 tenant entries 推导 catalog。
 *
 * - entries 顺序不影响输出（按 id 稳定排序）；
 * - 同名 entry 只输出一次；
 * - 缺 descriptor 的 entry 跳过（不伪造 path / version）；
 * - status 只在该 tenant entry 名下查找；缺失时省略。
 */
export function buildPluginCatalog(input: PluginCatalogInput): PluginCatalogItem[] {
  const statusById = new Map<string, PluginRuntimeStatus>();
  for (const status of input.statuses ?? []) {
    statusById.set(status.id, status.status);
  }

  const items: PluginCatalogItem[] = [];
  const seen = new Set<string>();

  for (const entry of input.entries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);

    const descriptor = input.descriptors.get(entry.name);
    if (descriptor === undefined) continue;

    const scope = toCatalogScope(descriptor.source);
    const rawStatus = statusById.get(entry.name);

    items.push({
      id: descriptor.name,
      name: displayName(descriptor),
      version: descriptor.version,
      scope,
      kind: toCatalogKind(scope, descriptor.mode),
      mode: descriptor.mode,
      enabled: entry.enabled,
      supportsToggle: true,
      restartRequired: descriptor.mode === 'in-process',
      ...(rawStatus !== undefined ? { status: toPluginListStatus(rawStatus) } : {}),
      path: descriptor.dir,
      ...(descriptor.entry !== undefined ? { entry: descriptor.entry } : {}),
      ...(descriptor.manifest !== undefined ? { manifest: descriptor.manifest } : {}),
    });
  }

  return items.sort(compareId);
}
