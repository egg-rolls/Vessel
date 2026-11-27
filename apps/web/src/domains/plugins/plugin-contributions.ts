/**
 * `plugins.list` 贡献点的纯函数归一化（CONTRACT-0.43 §2.1 / §2.6 / §2.7）。
 *
 * Web 只消费 wire 字段：不扫描目录、不读 plugin 包。旧 gateway / 能力插件
 * 没有 `contributions` 时返回空数组，导航与挂载点自然消失。
 */
import type {
  PluginContributionComposer,
  PluginContributionPage,
  PluginContributionPanel,
  PluginContributionToolbar,
  PluginI18n,
  PluginListItem,
  PluginPanelSlot,
  PluginSettingSpecWire,
  PluginToolbarSlot,
} from '../../gateway/types';
import { joinBaseUrl, normalizeBaseUrl, pageOrigin } from '../../gateway/url';
import { getLocale, t } from '../../i18n';

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
  /** plugin-embed 契约 §3：embed 具名导出组件；非法形状丢弃（iframe 仍可用）。 */
  component?: string;
}

/** CONTRACT-0.43 §2.9 E5：已校验的自定义导航分组。 */
export interface PluginNavGroupItem {
  pluginId: string;
  pluginName: string;
  /** `plugin:<pluginId>` */
  id: string;
  title: string;
  /** 可选 i18n key；由该 plugin 的 i18n 字典解析。 */
  titleKey?: string;
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
 * 输入框工具栏贡献项（0.51 additive）。
 *
 * 插件只声明「有这么一个按钮」；点击由宿主按 `id` 映射，宿主没有对应回调时
 * 该项被丢弃（不渲染死按钮）。因为拿不到宿主回调，v1 不支持插件内联执行。
 */
export interface PluginToolbarItem {
  pluginId: string;
  pluginName: string;
  slot: PluginToolbarSlot;
  id: string;
  label: string;
  titleKey?: string;
  icon?: PluginNavIcon;
  order: number;
  /** 通用 RPC 绑定菜单（additive，P3）；缺省 = 普通按钮（宿主按 id 映射回调）。 */
  menu?: PluginToolbarMenu;
}

/** 菜单档位项（归一化后）。 */
export interface PluginToolbarMenuItem {
  value: string;
  labelKey?: string;
  label?: string;
}

/**
 * 输入框内嵌贡献项（file-ref-ux additive，归一化后）。
 *
 * refs 槽 = 原子卡片渲染器（scheme + component）；drop 槽 = OS 文件处理器
 * （handler）；link 槽 = 消息 markdown link 增强器（scheme + component）。
 * 宿主只认通用接缝；插件撤离 ⇒ 条目随 plugins.list 消失（A9）。
 */
export interface PluginComposerItem {
  pluginId: string;
  pluginName: string;
  slot: 'refs' | 'drop' | 'link';
  scheme?: string;
  component?: string;
  handler?: string;
  order: number;
}

/** 通用 RPC 绑定菜单（归一化后；read/write 已校验 ∈ 本插件 rpc 白名单且权限匹配）。 */
export interface PluginToolbarMenu {
  read: string;
  write: string;
  valueKey: string;
  sessionScoped?: boolean;
  items: PluginToolbarMenuItem[];
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
/** 工具栏槽位白名单；v1 只有会话 / 团队共用的 `composer`。 */
const TOOLBAR_SLOTS: ReadonlySet<string> = new Set(['composer']);
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RPC_METHOD = /^[a-z][a-z0-9_-]*$/;
/** embed 具名导出组件形状（与 manifest 侧同一规则）。 */
const COMPONENT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const I18N_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const I18N_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const I18N_MAX_ENTRIES = 200;
const I18N_MAX_VALUE = 200;
const PLUGIN_LOCALES = ['en', 'zh-CN'] as const;
type PluginLocale = (typeof PLUGIN_LOCALES)[number];

/**
 * 图标校验：缺失返回 `undefined`；非法返回 `null`（调用方丢弃该 page/group）。
 * 只接受白名单，不把任意字符串传给渲染层。
 */
function navIconOf(value: unknown): PluginNavIcon | null | undefined {
  const name = text(value);
  if (name === '') return undefined;
  return NAV_ICONS.has(name) ? (name as PluginNavIcon) : null;
}

/** 单 locale 字典：只保留合法 key / 非空 value，限制条目数与长度。 */
function sanitizeLocale(record: unknown): Record<string, string> {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(record as Record<string, unknown>)) {
    if (count >= I18N_MAX_ENTRIES) break;
    if (!I18N_KEY.test(key) || I18N_FORBIDDEN.has(key)) continue;
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '' || value.length > I18N_MAX_VALUE) continue;
    out[key] = value;
    count += 1;
  }
  return out;
}

/** 插件私有字典；空字典返回 undefined，不进入 inventory。 */
function i18nOf(plugin: PluginListItem): PluginI18n | undefined {
  const raw = plugin.contributions?.i18n;
  if (raw === null || typeof raw !== 'object') return undefined;
  const en = sanitizeLocale((raw as PluginI18n).en);
  const zh = sanitizeLocale((raw as PluginI18n)['zh-CN']);
  const hasEn = Object.keys(en).length > 0;
  const hasZh = Object.keys(zh).length > 0;
  if (!hasEn && !hasZh) return undefined;
  return {
    ...(hasEn ? { en } : {}),
    ...(hasZh ? { 'zh-CN': zh } : {}),
  };
}

/**
 * 插件标题解析（CONTRACT-0.43 §2.11 E9）：
 * plugin[locale] → plugin.en → host `t(key)` → manifest title → id。
 * 字典按 plugin 作用域保存，不合并进宿主 catalog。
 */
export function pluginT(
  i18nByPlugin: ReadonlyMap<string, PluginI18n>,
  pluginId: string,
  key: string | undefined,
  locale: string,
  title?: string,
  id?: string,
): string {
  const dict = i18nByPlugin.get(pluginId);
  const trimmedKey = key?.trim() ?? '';
  if (trimmedKey !== '' && !I18N_FORBIDDEN.has(trimmedKey)) {
    const localeText = PLUGIN_LOCALES.includes(locale as PluginLocale)
      ? dict?.[locale as PluginLocale]?.[trimmedKey]
      : undefined;
    if (localeText) return localeText;
    const enText = dict?.en?.[trimmedKey];
    if (enText) return enText;
    const hostText = t(trimmedKey);
    if (hostText !== trimmedKey) return hostText;
  }
  return title?.trim() || id || trimmedKey;
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

/**
 * `#/plugins/<id>/<entry>` 的 iframe 目标；非法输入返回 null（由调用方渲染错误态）。
 *
 * 0.49：第一个参数是 **node origin**（`/plugins/*` 由 node 宿主提供），不再使用
 * 平台 origin；空串 = 页面同源（legacy `--serve`）。
 */
/**
 * node origin 归一化：空串 = 页面同源（legacy `--serve`）；无法解析返回 ''。
 * S4 单实现：与 RPC（ProtocolClient）共用 normalizeBaseUrl / pageOrigin。
 */
function resolveNodeOrigin(nodeOrigin: string): string {
  return normalizeBaseUrl(nodeOrigin) || pageOrigin();
}

export function pluginFrameUrl(
  nodeOrigin: string,
  pluginId: string,
  entry: string,
  context?: {
    run?: string;
    session?: string;
    lang?: string;
    theme?: 'light' | 'dark';
  },
): string | null {
  if (!isValidPluginId(pluginId)) return null;
  const safeEntry = safeEntryPath(entry);
  if (safeEntry === null) return null;
  const origin = resolveNodeOrigin(nodeOrigin);
  if (origin === '') return null;
  // S4 单实现 joinBaseUrl（字符串拼接）：代理模式 origin 带路径
  // （<platform>/nodes/<nodeId>），new URL(path, base) 的根绝对路径会替换掉
  // base 整个路径（/nodes/<id> 丢失）→ 落到平台根 /plugins/*（一律 404）。
  // 这里 new URL 只用于追加 query，第一个参数已是完整绝对 URL。
  const url = new URL(joinBaseUrl(origin, `/plugins/${encodeURIComponent(pluginId)}/${safeEntry}`));
  if (context?.run) url.searchParams.set('run', context.run);
  if (context?.session) url.searchParams.set('session', context.session);
  if (context?.lang) url.searchParams.set('lang', context.lang);
  if (context?.theme) url.searchParams.set('theme', context.theme);
  return url.toString();
}

/**
 * plugin-embed 契约 §4：embed 静态资源 URL `${nodeUrl}/plugins/<id>/ui/<path>`。
 * 直连模式 nodeUrl = node origin；代理模式 nodeUrl = `<platform>/nodes/<nodeId>`
 * （ConnectionProvider 已给出）——代理模式下模块经平台同源转发（动态 import
 * 必须同源，不能改指 node origin）。拼接保留 base 路径，理由同 pluginFrameUrl。
 * 非法输入返回 null（调用方渲染错误态）。
 */
export function pluginEmbedAssetUrl(
  nodeOrigin: string,
  pluginId: string,
  relPath: string,
): string | null {
  if (!isValidPluginId(pluginId)) return null;
  const safePath = safeEntryPath(relPath);
  if (safePath === null) return null;
  const origin = resolveNodeOrigin(nodeOrigin);
  if (origin === '') return null;
  return joinBaseUrl(origin, `/plugins/${encodeURIComponent(pluginId)}/ui/${safePath}`);
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
  const titleKey = text(raw.titleKey);
  const icon = navIconOf(raw.icon);
  if (icon === null) return null;
  return {
    pluginId: plugin.name,
    pluginName: plugin.name,
    id: ownId,
    title,
    ...(titleKey !== '' ? { titleKey } : {}),
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
  const component = text(page.component);
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
    ...(component !== '' && COMPONENT_NAME.test(component) ? { component } : {}),
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

/**
 * 工具栏条目归一化：slot 走白名单，`label` 缺失回退 `id`；id 为空整项丢弃。
 * 图标同样只接受领域图标白名单，不把任意字符串传进渲染层。
 */
function toolbarOf(
  plugin: PluginListItem,
  item: PluginContributionToolbar,
): PluginToolbarItem | null {
  const slot = text(item.slot);
  const id = text(item.id);
  if (!TOOLBAR_SLOTS.has(slot) || id === '') return null;
  const icon = navIconOf(item.icon);
  if (icon === null) return null;
  const titleKey = text(item.titleKey);
  const menu = toolbarMenuOf(plugin, item.menu);
  return {
    pluginId: plugin.name,
    pluginName: plugin.name,
    slot: slot as PluginToolbarSlot,
    id,
    label: text(item.label) || id,
    ...(titleKey !== '' ? { titleKey } : {}),
    ...(icon !== undefined ? { icon } : {}),
    order: orderOf(item.order),
    ...(menu !== undefined ? { menu } : {}),
  };
}

/** 菜单档位上限 / 值长度上限（与 manifest loader 同口径）。 */
const TOOLBAR_MENU_MAX_ITEMS = 16;
const TOOLBAR_MENU_MAX_VALUE_LEN = 64;

/**
 * 通用 RPC 绑定菜单归一化（additive，P3）。校验 read/write 须在本插件 rpc 白名单内
 * 且权限匹配（read→read，write→write）；违规 ⇒ 丢 menu 保留普通按钮（单项丢弃口径）。
 * 旧 gateway 无 menu ⇒ undefined ⇒ 条目退化为普通按钮（无 handler 则不渲染）。
 */
function toolbarMenuOf(
  plugin: PluginListItem,
  raw: PluginContributionToolbar['menu'],
): PluginToolbarMenu | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const read = text(raw.read);
  const write = text(raw.write);
  const valueKey = text(raw.valueKey);
  if (read === '' || write === '' || valueKey === '') return undefined;

  // rpc 白名单 + 权限（string 条目缺省 read；对象条目读 permission）。
  const permissions = new Map<string, 'read' | 'write'>();
  for (const rpc of plugin.contributions?.rpc ?? []) {
    if (typeof rpc === 'string') {
      const name = text(rpc);
      if (name !== '') permissions.set(name, 'read');
    } else if (rpc !== null && typeof rpc === 'object') {
      const name = text(rpc.name);
      if (name !== '') permissions.set(name, rpc.permission === 'write' ? 'write' : 'read');
    }
  }
  if (permissions.get(read) !== 'read') return undefined;
  if (permissions.get(write) !== 'write') return undefined;

  if (!Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  const items: PluginToolbarMenuItem[] = [];
  for (const entry of raw.items) {
    if (items.length >= TOOLBAR_MENU_MAX_ITEMS) break;
    if (entry === null || typeof entry !== 'object') continue;
    const value = text(entry.value);
    if (value === '' || value.length > TOOLBAR_MENU_MAX_VALUE_LEN) continue;
    const labelKey = text(entry.labelKey);
    const label = text(entry.label);
    items.push({
      value,
      ...(labelKey !== '' ? { labelKey } : {}),
      ...(label !== '' ? { label } : {}),
    });
  }
  if (items.length === 0) return undefined;
  return {
    read,
    write,
    valueKey,
    ...(raw.sessionScoped === true ? { sessionScoped: true } : {}),
    items,
  };
}

/** composer 内嵌贡献归一化：refs/link 要 scheme+component，drop 要 handler；违规整项丢弃。 */
function composerOf(
  plugin: PluginListItem,
  item: PluginContributionComposer,
): PluginComposerItem | null {
  const slot = item.slot;
  if (slot !== 'refs' && slot !== 'drop' && slot !== 'link') return null;
  const order = orderOf(item.order);
  if (slot === 'drop') {
    const handler = text(item.handler);
    if (handler === '' || !COMPONENT_NAME.test(handler)) return null;
    return { pluginId: plugin.name, pluginName: plugin.name, slot, handler, order };
  }
  const scheme = text(item.scheme);
  const component = text(item.component);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(scheme)) return null;
  if (component === '' || !COMPONENT_NAME.test(component)) return null;
  return { pluginId: plugin.name, pluginName: plugin.name, slot, scheme, component, order };
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
  /** 输入框工具栏声明（0.51 additive）；旧 gateway 不返回时为空数组。 */
  toolbar: PluginToolbarItem[];
  /** 输入框内嵌贡献（file-ref-ux additive）；旧 gateway 不返回时为空数组。 */
  composer: PluginComposerItem[];
  /** S3 additive：插件设置域（vscode-settings-design §4.3）；旧 gateway 为空数组。 */
  settings: PluginSettingsDomain[];
  /** plugin id → 私有 i18n 字典（不合并进宿主 catalog）。 */
  i18nByPlugin: ReadonlyMap<string, PluginI18n>;
  /** plugin id → 允许 iframe 调用的 RPC 方法名（rpc ∪ commands）。 */
  methodsByPlugin: ReadonlyMap<string, ReadonlySet<string>>;
}

/** S3：已校验、已排序的插件设置项（§4.3）。 */
export interface PluginSettingItem {
  /** 插件私有键（snake_case 惯例，不带插件前缀）。 */
  key: string;
  /** `${pluginId}.${key}`（注册表 / 搜索 / 深链用）。 */
  id: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  /** pluginT(titleKey) → title → key。 */
  title: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  keywords?: string[];
  order: number;
  minimum?: number;
  maximum?: number;
}

export interface PluginSettingsDomain {
  pluginId: string;
  /** pluginT 解析后的显示名（回退 manifest name → id）。 */
  pluginName: string;
  items: PluginSettingItem[];
}

const SETTING_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SETTING_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
]);
const SETTING_MAX_ITEMS = 64;
const SETTING_MAX_ENUM = 32;
const SETTING_MAX_ENUM_LEN = 64;
const SETTING_MAX_TEXT = 200;
const SETTING_MAX_KEYWORDS = 16;

function settingTypeMatches(type: PluginSettingItem['type'], value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

function boundedText(value: unknown): string {
  return text(value).slice(0, SETTING_MAX_TEXT);
}

/**
 * 单插件设置域归一化（§4.3 校验规则，延续现有 normalizer 风格）：
 * 单项丢弃不整域丢弃；enum 非法丢 enum 保留项；default 类型不符忽略 default。
 */
function settingsDomainOf(
  plugin: PluginListItem,
  raw: Record<string, PluginSettingSpecWire>,
  i18nByPlugin: ReadonlyMap<string, PluginI18n>,
  locale: string,
  pluginName: string,
): PluginSettingsDomain | null {
  const items: PluginSettingItem[] = [];
  for (const [key, spec] of Object.entries(raw)) {
    if (items.length >= SETTING_MAX_ITEMS) break;
    if (!SETTING_KEY.test(key) || I18N_FORBIDDEN.has(key)) continue;
    if (spec === null || typeof spec !== 'object') continue;
    const type = text(spec.type);
    if (!SETTING_TYPES.has(type)) continue;
    const itemType = type as PluginSettingItem['type'];

    const title =
      pluginT(
        i18nByPlugin,
        plugin.name,
        text(spec.titleKey) || undefined,
        locale,
        boundedText(spec.title),
        key,
      ).slice(0, SETTING_MAX_TEXT) || key;
    const descriptionRaw = boundedText(spec.description);
    const descKey = text(spec.descriptionKey);
    let description = descriptionRaw;
    if (descKey !== '') {
      const resolved = pluginT(
        i18nByPlugin,
        plugin.name,
        descKey,
        locale,
        descriptionRaw || undefined,
      );
      description = resolved === descKey ? descriptionRaw : resolved.slice(0, SETTING_MAX_TEXT);
    }

    let enumValues: string[] | undefined;
    if (itemType === 'string' && Array.isArray(spec.enum)) {
      const cleaned = spec.enum
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && entry.length <= SETTING_MAX_ENUM_LEN)
        .slice(0, SETTING_MAX_ENUM);
      if (cleaned.length > 0) enumValues = cleaned;
    }

    let keywords: string[] | undefined;
    if (Array.isArray(spec.keywords)) {
      const cleaned = spec.keywords
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && entry.length <= SETTING_MAX_ENUM_LEN)
        .slice(0, SETTING_MAX_KEYWORDS);
      if (cleaned.length > 0) keywords = cleaned;
    }

    const minimum =
      (itemType === 'number' || itemType === 'integer') &&
      typeof spec.minimum === 'number' &&
      Number.isFinite(spec.minimum)
        ? spec.minimum
        : undefined;
    const maximum =
      (itemType === 'number' || itemType === 'integer') &&
      typeof spec.maximum === 'number' &&
      Number.isFinite(spec.maximum)
        ? spec.maximum
        : undefined;

    items.push({
      key,
      id: `${plugin.name}.${key}`,
      type: itemType,
      title,
      ...(description !== '' ? { description } : {}),
      ...(enumValues !== undefined ? { enum: enumValues } : {}),
      ...(settingTypeMatches(itemType, spec.default) ? { default: spec.default } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      order: orderOf(spec.order),
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    });
  }
  if (items.length === 0) return null;
  items.sort(byOrder);
  return { pluginId: plugin.name, pluginName, items };
}

/** 启用插件的贡献点平铺；零插件 / 旧 gateway 返回空集合。 */
export function buildPluginInventory(plugins: readonly PluginListItem[]): PluginInventory {
  const pages: PluginPageItem[] = [];
  const navGroups: PluginNavGroupItem[] = [];
  const panels: PluginPanelItem[] = [];
  const toolbar: PluginToolbarItem[] = [];
  const composer: PluginComposerItem[] = [];
  const settings: PluginSettingsDomain[] = [];
  const i18nByPlugin = new Map<string, PluginI18n>();
  const methodsByPlugin = new Map<string, Set<string>>();
  const locale = getLocale();

  for (const plugin of plugins) {
    if (!isEnabledPlugin(plugin) || !isValidPluginId(plugin.name)) continue;
    const contributions = plugin.contributions;
    if (!contributions) continue;

    const i18n = i18nOf(plugin);
    if (i18n !== undefined) i18nByPlugin.set(plugin.name, i18n);
    const group = navGroupOf(plugin);
    if (group !== null) navGroups.push(group);
    // S3：设置域（enabled 插件才收，同 pages）。显示名 = 分组标题解析 → id。
    const rawSettings = contributions.settings;
    if (rawSettings !== null && typeof rawSettings === 'object') {
      const pluginName = group
        ? pluginT(i18nByPlugin, plugin.name, group.titleKey, locale, group.title, plugin.name)
        : plugin.name;
      const domain = settingsDomainOf(
        plugin,
        rawSettings as Record<string, PluginSettingSpecWire>,
        i18nByPlugin,
        locale,
        pluginName,
      );
      if (domain !== null) settings.push(domain);
    }
    for (const page of contributions.pages ?? []) {
      const item = pageOf(plugin, page, group?.id);
      if (item !== null) pages.push(item);
    }
    for (const panel of contributions.panels ?? []) {
      const item = panelOf(plugin, panel);
      if (item !== null) panels.push(item);
    }
    for (const entry of contributions.toolbar ?? []) {
      const item = toolbarOf(plugin, entry);
      if (item !== null) toolbar.push(item);
    }
    for (const entry of contributions.composer ?? []) {
      const item = composerOf(plugin, entry);
      if (item !== null) composer.push(item);
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
  toolbar.sort(byOrder);
  composer.sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId));
  settings.sort((a, b) => a.pluginName.localeCompare(b.pluginName));
  return { pages, navGroups, panels, toolbar, composer, settings, i18nByPlugin, methodsByPlugin };
}
