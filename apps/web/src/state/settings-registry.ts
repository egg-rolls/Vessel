/**
 * 设置注册表（VSCode 式设置重构 S1，docs/dev/plans/vscode-settings-design.md §2.2）。
 *
 * 单一事实源：核心定义（DISPLAY_SETTINGS 全量 + 本地偏好 + view 项）+ 插件设置域
 * （S3 起由 buildPluginInventory 归一化合并）。纯数据 + 纯函数，不 import React。
 *
 * id 规则：核心 = config 键（ui.showReasoning）；本地 = local.<id>；插件 = <pluginId>.<key>。
 * 核心键白名单不含插件 id 段，核心与插件键永不冲突。
 */

/** 核心定义：从 DISPLAY_SETTINGS 派生（单一清单，不另立第二份；§2.2）。 */
import {
  DISPLAY_SETTINGS,
  EMPTY_RESPONSE_SETTING_PREFIX,
  LOG_SETTING_PREFIX,
} from './display-settings';

export type SettingScope = 'user' | 'project' | 'local';
export type SettingType = 'boolean' | 'enum' | 'string' | 'number' | 'object' | 'array' | 'view';
export type SettingSource = 'core' | `plugin:${string}`;

export interface SettingDef {
  /** 点分键：核心 = config 键；本地 = local.<id>；插件 = <pluginId>.<key>。 */
  id: string;
  scope: SettingScope;
  type: SettingType;
  /** 宿主 i18n key（核心/本地）；插件项由 pluginT 解析后直接给 title 文本。 */
  titleKey?: string;
  title?: string;
  descriptionKey?: string;
  description?: string;
  /** 额外搜索词（中英别名、旧称）。 */
  keywords?: readonly string[];
  /** §6 分类 id。 */
  category: string;
  /** true → 进「常用」curated 视图。 */
  common?: boolean;
  order?: number;
  /** enum 可选值。 */
  options?: readonly string[];
  /** enum 选项 → 宿主 i18n key（缺省渲染原值 mono，与现 Display 页一致）。 */
  optionLabelKeys?: Readonly<Record<string, string>>;
  /** number 边界（spec minimum/maximum）。 */
  min?: number;
  max?: number;
  /** 契约默认值（@modified 判定 + 恢复默认）；缺省 = 无默认可回，不显示 ↺。 */
  default?: string;
  /** 未配置时的显示值（真实缺省行为）。 */
  fallback?: string;
  source: SettingSource;
  /** view 型：渲染自定义子视图而非控件。 */
  view?: 'designLab' | 'connection' | 'advancedConfig';
  /** 只读（环境变量覆盖 / 旧 gateway 无写面 / map 型键 / 说明行）。 */
  readOnly?: boolean;
  /** 只读但可重置（local.nav.groups：[全部展开]）。 */
  resettable?: boolean;
  /** 服务端键 = config 键路径；本地键 = localStorage 键；插件键 = 插件私有键。 */
  key: string;
  /** 插件项归属插件 id（source = plugin:<id> 时必有）。 */
  pluginId?: string;
  /** child 插件写后需重载才生效（S4）。 */
  restartRequired?: boolean;
}

/** §6 分类 id / 固定排序 / 标题 i18n key。插件域只能追加到 extensions 下。 */
export interface SettingsCategory {
  id: string;
  titleKey: string;
  order: number;
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'visual', titleKey: 'settings.category.visual', order: 10 },
  { id: 'display', titleKey: 'settings.category.display', order: 20 },
  { id: 'runtime', titleKey: 'settings.category.runtime', order: 30 },
  { id: 'logs', titleKey: 'settings.category.logs', order: 40 },
  { id: 'connection', titleKey: 'settings.category.connection', order: 50 },
  { id: 'advancedConfig', titleKey: 'settings.category.advancedConfig', order: 60 },
  { id: 'extensions', titleKey: 'settings.category.extensions', order: 70 },
];

/** 「常用」是 curated 过滤视图（common:true），不是独立分类。 */
export const COMMON_CATEGORY_ID = 'common';

/**
 * 契约默认值（@modified 判定 + 恢复默认）。来源：packages/config/src/types.ts
 * UiConfig/ObservabilityConfig 注释 + defaults.ts DEFAULT_LOG_OPTIONS +
 * empty-response 缺省（§7.3）。statusBars 默认由消费方决定、nudge 无缺省 → 不登记
 * （无默认可回，不显示 ↺）。askUser 在 gateway 入口缺省 true（UiConfig 注释）。
 */
const CORE_DEFAULTS: Readonly<Record<string, string>> = {
  'ui.verbosity': 'normal',
  'ui.showInternalEvents': 'false',
  'ui.showArchived': 'false',
  'ui.errorLevel': 'user',
  'ui.showReasoning': 'false',
  'ui.expandCards': 'false',
  'ui.askUser': 'true',
  'ui.language': 'zh-CN',
  'observability.showProcessErrors': 'false',
  'observability.log.level': 'info',
  'observability.log.color': 'auto',
  'observability.log.format': 'pretty',
  'observability.log.time': 'auto',
  'emptyResponse.enabled': 'true',
  'emptyResponse.seamless': 'true',
  'emptyResponse.maxRetries': '2',
};

/** 「常用」curated 清单（§6 + 裁定③：showInternalEvents 是默认视觉旗舰键）。 */
const CORE_COMMON: ReadonlySet<string> = new Set([
  'ui.verbosity',
  'ui.language',
  'ui.askUser',
  'ui.showReasoning',
  'ui.showInternalEvents',
]);

function coreCategory(key: string): string {
  if (key === 'ui.language' || key === 'ui.statusBars') return 'visual';
  if (key.startsWith(LOG_SETTING_PREFIX)) return 'logs';
  if (key.startsWith(EMPTY_RESPONSE_SETTING_PREFIX)) return 'runtime';
  return 'display';
}

function snakeCase(id: string): string {
  return id.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * 核心服务端设置（scope=user，S5 起 project 可覆盖）。
 * descriptionKey 指向 .hint（可能不存在）——渲染侧必须经 i18n hasMessage 判定，
 * 缺失时不渲染描述行（t() 对缺失键回退键名本身）。
 */
export const CORE_SETTINGS: readonly SettingDef[] = DISPLAY_SETTINGS.map((setting) => ({
  id: setting.key,
  key: setting.key,
  scope: 'user' as const,
  type: setting.type,
  source: 'core' as const,
  titleKey: `settings.display.field.${setting.id}`,
  descriptionKey: `settings.display.field.${setting.id}.hint`,
  category: coreCategory(setting.key),
  common: CORE_COMMON.has(setting.key) ? true : undefined,
  options: setting.options,
  min: setting.min,
  max: setting.max,
  default: CORE_DEFAULTS[setting.key],
  fallback: setting.fallback,
  keywords: [setting.id, snakeCase(setting.id)],
}));

/**
 * 本地呈现偏好（scope=local，浏览器 localStorage；§7.1 键名全部原名保留）。
 * 写路径只转调既有唯一写者（storeTheme / writeNavPreference / setLocale），
 * 绝不直接写 DOM（0.52 主题唯一写者 invariant，R10）。
 */
export const LOCAL_SETTINGS: readonly SettingDef[] = [
  {
    id: 'local.theme',
    key: 'vessel.theme',
    scope: 'local',
    type: 'enum',
    source: 'core',
    titleKey: 'appearance.theme.title',
    descriptionKey: 'appearance.theme.desc',
    category: 'visual',
    common: true,
    options: ['system', 'light', 'dark'],
    optionLabelKeys: {
      system: 'appearance.theme.system',
      light: 'appearance.theme.light',
      dark: 'appearance.theme.dark',
    },
    // initialTheme 缺省 dark（无存储偏好/非法值时）。
    default: 'dark',
    keywords: ['theme', '主题', 'dark', 'light', '配色'],
  },
  {
    id: 'local.motion',
    key: 'local.motion',
    scope: 'local',
    type: 'string',
    source: 'core',
    titleKey: 'appearance.motion.title',
    descriptionKey: 'appearance.motion.desc',
    category: 'visual',
    // 说明行：跟随系统 reduced-motion，无开关（§5.1）。
    readOnly: true,
    keywords: ['motion', '动效', 'animation', 'reduced-motion'],
  },
  {
    id: 'local.nav.collapsed',
    key: 'vessel.nav.collapsed',
    scope: 'local',
    type: 'boolean',
    source: 'core',
    titleKey: 'settings.item.local.navCollapsed.title',
    descriptionKey: 'settings.item.local.navCollapsed.desc',
    category: 'visual',
    default: 'false',
    keywords: ['nav', 'sidebar', '侧栏', '折叠', 'collapse'],
  },
  {
    id: 'local.nav.groups',
    key: 'vessel.nav.collapsed-groups',
    scope: 'local',
    type: 'object',
    source: 'core',
    titleKey: 'settings.item.local.navGroups.title',
    descriptionKey: 'settings.item.local.navGroups.desc',
    category: 'visual',
    // 只读展示 + [全部展开] 重置（§5.3）；v1 经通用 local 重置清空存储键。
    readOnly: true,
    resettable: true,
    keywords: ['nav', 'groups', '分组', '折叠'],
  },
  {
    id: 'local.settings.tree.collapsed',
    key: 'vessel.settings.tree.collapsed',
    scope: 'local',
    type: 'object',
    source: 'core',
    titleKey: 'settings.item.local.settingsTree.title',
    descriptionKey: 'settings.item.local.settingsTree.desc',
    category: 'advancedConfig',
    keywords: ['settings', 'tree', '分类树', '折叠'],
  },
  {
    id: 'local.settings.tab',
    key: 'vessel.settings.tab',
    scope: 'local',
    type: 'enum',
    source: 'core',
    titleKey: 'settings.item.local.settingsTab.title',
    descriptionKey: 'settings.item.local.settingsTab.desc',
    category: 'advancedConfig',
    options: ['user', 'project', 'local'],
    default: 'user',
    keywords: ['settings', 'tab', '层级', 'scope'],
  },
];

/** view 型项：渲染自定义子视图而非控件（§5.2 / §6；懒加载）。 */
export const VIEW_SETTINGS: readonly SettingDef[] = [
  {
    id: 'local.designLab',
    key: 'local.designLab',
    scope: 'local',
    type: 'view',
    view: 'designLab',
    source: 'core',
    titleKey: 'settings.item.view.designLab.title',
    descriptionKey: 'settings.item.view.designLab.desc',
    category: 'visual',
    keywords: ['design', '设计实验室', 'token', 'preview', 'lab'],
  },
  {
    id: 'view.connection',
    key: 'view.connection',
    scope: 'user',
    type: 'view',
    view: 'connection',
    source: 'core',
    titleKey: 'settings.item.view.connection.title',
    descriptionKey: 'settings.item.view.connection.desc',
    category: 'connection',
    keywords: ['gateway', '连接', 'connection', '节点', '版本'],
  },
  {
    id: 'view.advancedConfig',
    key: 'view.advancedConfig',
    scope: 'user',
    type: 'view',
    view: 'advancedConfig',
    source: 'core',
    titleKey: 'settings.item.view.advancedConfig.title',
    descriptionKey: 'settings.item.view.advancedConfig.desc',
    category: 'advancedConfig',
    keywords: ['config', 'yaml', 'json', '高级', '来源', 'sources'],
  },
];

/** 注册表合并：核心 + 本地 + view + 插件域（S3）。插件项 category 固定 extensions。 */
export function mergeSettings(pluginDefs: readonly SettingDef[] = []): readonly SettingDef[] {
  return [...CORE_SETTINGS, ...LOCAL_SETTINGS, ...VIEW_SETTINGS, ...pluginDefs];
}

export function settingDefFor(defs: readonly SettingDef[], id: string): SettingDef | undefined {
  return defs.find((def) => def.id === id);
}
