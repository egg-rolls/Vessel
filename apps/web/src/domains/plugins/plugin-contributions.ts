/**
 * `plugins.list` 贡献点的纯函数归一化（CONTRACT-0.43 §2.1 / §2.6 / §2.7）。
 *
 * Web 只消费 wire 字段：不扫描目录、不读 plugin 包。旧 gateway / 能力插件
 * 没有 `contributions` 时返回空数组，导航与挂载点自然消失。
 */
import type {
  PluginContributionPage,
  PluginContributionPanel,
  PluginListItem,
  PluginPanelSlot,
} from '../../gateway/types';

/** 图标白名单（与 DomainIcon 的领域名一致；不接受任意 SVG / 任意名字）。 */
export const PLUGIN_NAV_ICONS = [
  'chat',
  'hub',
  'gateway',
  'nodes',
  'teams',
  'agents',
  'runs',
  'tools',
  'mcp',
  'channels',
  'plugins',
  'observe',
  'settings',
] as const;

export type PluginNavIcon = (typeof PLUGIN_NAV_ICONS)[number];

export interface PluginPageItem {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  /** 可选 i18n key；NavModel 优先用它。 */
  titleKey?: string;
  /** 内置分组 id 或本 plugin 的 `plugin:<pluginId>`。 */
  nav: string;
  /** 不含未通过白名单的值。 */
  icon?: PluginNavIcon;
  order: number;
  entry: string;
}

/** CONTRACT-0.43 §2.9 E5：已校验的自定义导航分组。 */
export interface PluginNavGroupItem {
  pluginId: string;
  pluginName: string;
  /** `plugin:<pluginId>` */
  id: string;
  title: string;
  icon?: PluginNavIcon;
  order: number;
}

export interface PluginPanelItem {
  pluginId: string;
  pluginName: string;
  slot: PluginPanelSlot;
  id: string;
  title?: string;
  order: number;
  entry: string;
}

/**
 * 内置/核心分组 key（CONTRACT-0.43 §2.10 E6）；自定义分组必须严格等于
 * `plugin:<pluginId>`。核心 key 不能被 plugin 覆盖或重命名。
 */
const BUILTIN_NAV_SLOTS: ReadonlySet<string> = new Set([
  'top',
  'plugins',
  'observe',
  'settings',
  'chat',
  'network',
  'runs',
  'integrations',
  'core',
  // 0.45 旧 key：IA 已把 status 改名为 core，读侧继续接受旧值。
  'status',
]);
const NAV_ICONS: ReadonlySet<string> = new Set(PLUGIN_NAV_ICONS);
const PANEL_SLOTS: ReadonlySet<string> = new Set(['run-detail', 'session-detail', 'nav']);
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RPC_METHOD = /^[a-z][a-z0-9_-]*$/;

/**
 * 图标校验：缺失返回 `undefined`；非法返回 `null`（调用方丢弃该 page/group）。
 * 只接受白名单，不把任意字符串传给渲染层。
 */
function navIconOf(value: unknown): PluginNavIcon | null | undefined {
  const name = text(value);
  if (name === '') return undefined;
  return NAV_ICONS.has(name) ? (name as PluginNavIcon) : null;
}

export function isEnabledPlugin(plugin: PluginListItem): boolean {
  return plugin.enabled;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function orderOf(value: unknown, fallback = 100): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** entry 相对 `ui.dir`；缺失时优先从 `route` 末段推导，再回退 index.html。 */
export function pageEntry(page: PluginContributionPage): string {
  const entry = text(page.entry);
  if (entry !== '') return entry;
  const route = text(page.route).split('?', 1)[0] ?? '';
  const last = route.split('/').filter(Boolean).pop();
  return last !== undefined && last !== '' ? last : 'index.html';
}

export function isValidPluginId(pluginId: string): boolean {
  return PLUGIN_ID.test(pluginId);
}

/** 只允许相对路径；拒绝绝对路径、反斜杠、`.`/`..` 段（iframe 不得越界）。 */
export function safeEntryPath(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('\\')) return null;
  if (trimmed.includes('\0')) return null;
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

/** `#/plugins/<id>/<entry>` 的 iframe 目标；非法输入返回 null（由调用方渲染错误态）。 */
export function pluginFrameUrl(
  gatewayUrl: string,
  pluginId: string,
  entry: string,
  context?: { run?: string; session?: string; lang?: string },
): string | null {
  if (!isValidPluginId(pluginId)) return null;
  const safeEntry = safeEntryPath(entry);
  if (safeEntry === null) return null;
  const origin =
    gatewayUrl.trim() !== ''
      ? gatewayUrl.trim().replace(/\/+$/, '')
      : typeof window === 'undefined'
        ? ''
        : window.location.origin;
  if (origin === '') return null;
  const url = new URL(`/plugins/${encodeURIComponent(pluginId)}/${safeEntry}`, origin);
  if (context?.run) url.searchParams.set('run', context.run);
  if (context?.session) url.searchParams.set('session', context.session);
  if (context?.lang) url.searchParams.set('lang', context.lang);
  return url.toString();
}

/**
 * 自定义分组：只接受 `plugin:<pluginId>` 且每个 plugin 最多一个。
 * 非法 id / 非法 icon 返回 null（整组丢弃，不影响其它 plugin）。
 */
function navGroupOf(plugin: PluginListItem): PluginNavGroupItem | null {
  const ownId = `plugin:${plugin.name}`;
  const groups = plugin.contributions?.navGroups ?? [];
  const raw = groups.find((group) => text(group.id) === ownId);
  if (!raw) return null;
  const title = text(raw.title) || ownId;
  const icon = navIconOf(raw.icon);
  if (icon === null) return null;
  return {
    pluginId: plugin.name,
    pluginName: plugin.name,
    id: ownId,
    title,
    ...(icon !== undefined ? { icon } : {}),
    order: orderOf(raw.order),
  };
}

function pageOf(
  plugin: PluginListItem,
  page: PluginContributionPage,
  ownNav: string | undefined,
): PluginPageItem | null {
  const id = text(page.id);
  const title = text(page.title) || id;
  if (id === '' || title === '') return null;
  const nav = text(page.nav) || 'top';
  // 只允许内置分组或本 plugin 已声明的 `plugin:<pluginId>`；跨 plugin 引用丢弃。
  if (!BUILTIN_NAV_SLOTS.has(nav) && nav !== ownNav) return null;
  const icon = navIconOf(page.icon);
  if (icon === null) return null;
  const titleKey = text(page.titleKey);
  return {
    pluginId: plugin.name,
    pluginName: plugin.name,
    id,
    title,
    ...(titleKey !== '' ? { titleKey } : {}),
    nav,
    ...(icon !== undefined ? { icon } : {}),
    order: orderOf(page.order),
    entry: pageEntry(page),
  };
}

function panelOf(plugin: PluginListItem, panel: PluginContributionPanel): PluginPanelItem | null {
  const slot = text(panel.slot);
  const id = text(panel.id);
  if (!PANEL_SLOTS.has(slot) || id === '') return null;
  const title = text(panel.title);
  return {
    pluginId: plugin.name,
    pluginName: plugin.name,
    slot: slot as PluginPanelSlot,
    id,
    ...(title !== '' ? { title } : {}),
    order: orderOf(panel.order),
    entry: text(panel.entry) || 'index.html',
  };
}

function byOrder(a: { order: number; title?: string; id: string }, b: typeof a): number {
  return a.order - b.order || (a.title ?? a.id).localeCompare(b.title ?? b.id);
}

function isPluginListItem(value: unknown): value is PluginListItem {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.enabled === 'boolean';
}

/**
 * `plugin.changed` 的 payload（CONTRACT-0.43 §2.8）：gateway 广播的是
 * `plugins.list` 形状的贡献快照 `{ plugins: [...] }`。
 * 结构不可用时返回 null，调用方应回退到 `plugins.list`。
 */
export function pluginsFromChangedPayload(data: unknown): PluginListItem[] | null {
  if (Array.isArray(data)) return data.filter(isPluginListItem);
  if (data === null || typeof data !== 'object') return null;
  const plugins = (data as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) return null;
  return plugins.filter(isPluginListItem);
}

export interface PluginInventory {
  pages: PluginPageItem[];
  navGroups: PluginNavGroupItem[];
  panels: PluginPanelItem[];
  /** plugin id → 允许 iframe 调用的 RPC 方法名（rpc ∪ commands）。 */
  methodsByPlugin: ReadonlyMap<string, ReadonlySet<string>>;
}

/** 启用插件的贡献点平铺；零插件 / 旧 gateway 返回空集合。 */
export function buildPluginInventory(plugins: readonly PluginListItem[]): PluginInventory {
  const pages: PluginPageItem[] = [];
  const navGroups: PluginNavGroupItem[] = [];
  const panels: PluginPanelItem[] = [];
  const methodsByPlugin = new Map<string, Set<string>>();

  for (const plugin of plugins) {
    if (!isEnabledPlugin(plugin) || !isValidPluginId(plugin.name)) continue;
    const contributions = plugin.contributions;
    if (!contributions) continue;

    const group = navGroupOf(plugin);
    if (group !== null) navGroups.push(group);
    for (const page of contributions.pages ?? []) {
      const item = pageOf(plugin, page, group?.id);
      if (item !== null) pages.push(item);
    }
    for (const panel of contributions.panels ?? []) {
      const item = panelOf(plugin, panel);
      if (item !== null) panels.push(item);
    }

    const methods = new Set<string>();
    for (const rpc of contributions.rpc ?? []) {
      // E1 canonical: bare method name string; legacy `{name}` objects tolerated.
      const name = typeof rpc === 'string' ? text(rpc) : text(rpc.name);
      if (RPC_METHOD.test(name)) methods.add(name);
    }
    // CONTRACT-0.43 §2.2：命令必须声明同名 rpc，因此命令名也是合法的桥方法名。
    for (const command of contributions.commands ?? []) {
      const name = text(command.name);
      if (RPC_METHOD.test(name)) methods.add(name);
    }
    if (methods.size > 0) methodsByPlugin.set(plugin.name, methods);
  }

  pages.sort(byOrder);
  navGroups.sort(byOrder);
  panels.sort(byOrder);
  return { pages, navGroups, panels, methodsByPlugin };
}
