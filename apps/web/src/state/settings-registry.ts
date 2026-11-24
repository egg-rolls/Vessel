/**
 * 设置注册表（VSCode 式设置重构 S1，docs/dev/plans/vscode-settings-design.md §2.2）。
 *
 * 单一事实源：核心定义（服务端键全量 + 本地偏好 + view 项）+ 插件设置域
 * （S3 起由 buildPluginInventory 归一化合并）。纯数据 + 纯函数，不 import React。
 * S6 反转：核心键表在本文件登记，display-settings.ts 的 DISPLAY_SETTINGS 反向派生。
 *
 * id 规则：核心 = config 键（ui.showReasoning）；本地 = local.<id>；插件 = <pluginId>.<key>。
 * 核心键白名单不含插件 id 段，核心与插件键永不冲突。
 */

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

/** 日志分组键前缀（日志分类；display-settings 兼容层原样 re-export）。 */
export const LOG_SETTING_PREFIX = 'observability.log.';

/** 空响应兜底键前缀（运行期 core 分类）。 */
export const EMPTY_RESPONSE_SETTING_PREFIX = 'emptyResponse.';

/**
 * 核心键的 legacy 短 id（旧 DISPLAY_SETTINGS.id / i18n 后缀）：
 * ui.* / observability.showProcessErrors 取末段；log.* → log<Level>；
 * emptyResponse.* → emptyResponse<Enabled>。搜索别名与派生层共用此规则。
 */
export function coreShortId(key: string): string {
  for (const [prefix, stem] of [
    [LOG_SETTING_PREFIX, 'log'],
    [EMPTY_RESPONSE_SETTING_PREFIX, 'emptyResponse'],
  ] as const) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      return `${stem}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
    }
  }
  return key.split('.').pop() ?? key;
}

/**
 * 核心服务端键表（单一事实源；DISPLAY_SETTINGS 由 display-settings.ts 反向派生）。
 * default = 契约默认值（@modified 判定 + 恢复默认），来源：packages/config/src/types.ts
 * UiConfig/ObservabilityConfig 注释 + defaults.ts DEFAULT_LOG_OPTIONS +
 * empty-response 缺省（§7.3）。statusBars 默认由消费方决定、nudge 无缺省 → 不登记
 * （无默认可回，不显示 ↺）。askUser 在 gateway 入口缺省 true（UiConfig 注释）。
 * fallback = 未配置时的显示值（真实缺省行为）。
 */
interface CoreSettingSpec {
  key: string;
  type: 'boolean' | 'enum' | 'number' | 'string';
  options?: readonly string[];
  min?: number;
  max?: number;
  default?: string;
  fallback?: string;
}

const CORE_SETTING_SPECS: readonly CoreSettingSpec[] = [
  { key: 'ui.verbosity', type: 'enum', options: ['minimal', 'normal', 'debug'], default: 'normal' },
  // 默认视觉契约（用户裁决：生产 8642 为默认）：系统/内部消息**默认隐藏**。
  // fallback 'false' 是缺省值的显式 codify——未配置时 UI 按 false 渲染/判定，
  // 各舰队继承此默认；验收期的 show_internal_events:true 只是临时 override。
  { key: 'ui.showInternalEvents', type: 'boolean', default: 'false', fallback: 'false' },
  // 0.51：已归档 Team / 已停用 agent 的默认隐藏开关。与 showInternalEvents 同一层
  // （同一个 ui 块、同一条 config.set 写路径），入口也在同一个「显示与可见性」分组。
  { key: 'ui.showArchived', type: 'boolean', default: 'false' },
  { key: 'ui.errorLevel', type: 'enum', options: ['user', 'all'], default: 'user' },
  { key: 'observability.showProcessErrors', type: 'boolean', default: 'false' },
  { key: 'ui.askUser', type: 'boolean', default: 'true' },
  { key: 'ui.showReasoning', type: 'boolean', default: 'false' },
  { key: 'ui.expandCards', type: 'boolean', default: 'false' },
  { key: 'ui.statusBars', type: 'enum', options: ['top', 'bottom', 'both', 'none'] },
  { key: 'ui.language', type: 'enum', options: ['zh-CN', 'en'], default: 'zh-CN' },
  // 日志中枢（gateway）：modules 是 map，一期只读（不走 config.set）。
  {
    key: 'observability.log.level',
    type: 'enum',
    options: ['debug', 'info', 'warn', 'error'],
    default: 'info',
  },
  {
    key: 'observability.log.color',
    type: 'enum',
    options: ['auto', 'always', 'never'],
    default: 'auto',
  },
  { key: 'observability.log.format', type: 'enum', options: ['pretty', 'json'], default: 'pretty' },
  {
    key: 'observability.log.time',
    type: 'enum',
    options: ['auto', 'none', 'clock', 'iso'],
    default: 'auto',
  },
  // q-empty-response：空响应兜底（core 运行期设置，非插件域）。缺省 = 启用、重试 2 次、
  // 内置 nudge 文案；fallback 让「未配置」显示真实缺省行为而不是空。
  { key: 'emptyResponse.enabled', type: 'boolean', default: 'true', fallback: 'true' },
  { key: 'emptyResponse.seamless', type: 'boolean', default: 'true', fallback: 'true' },
  { key: 'emptyResponse.maxRetries', type: 'number', min: 0, max: 10, default: '2', fallback: '2' },
  { key: 'emptyResponse.nudge', type: 'string' },
];

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
export const CORE_SETTINGS: readonly SettingDef[] = CORE_SETTING_SPECS.map((spec) => {
  const shortId = coreShortId(spec.key);
  return {
    id: spec.key,
    key: spec.key,
    scope: 'user' as const,
    type: spec.type,
    source: 'core' as const,
    titleKey: `settings.display.field.${shortId}`,
    descriptionKey: `settings.display.field.${shortId}.hint`,
    category: coreCategory(spec.key),
    common: CORE_COMMON.has(spec.key) ? true : undefined,
    options: spec.options,
    min: spec.min,
    max: spec.max,
    default: spec.default,
    fallback: spec.fallback,
    keywords: [shortId, snakeCase(shortId)],
  };
});

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

/**
 * 插件设置域 → SettingDef（S3，§4.3 归一化后的结构输入）。
 * 结构化类型而非 import plugin-contributions：注册表保持纯数据、不沾 React。
 * 插件项 scope=user（vessel.yaml plugins[].config），category 固定 extensions，
 * 不能注入核心分类（与 navGroups 核心 key 不可覆盖同一安全口径）。
 */
export interface PluginSettingDomainInput {
  pluginId: string;
  pluginName: string;
  items: readonly {
    key: string;
    id: string;
    type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
    title: string;
    description?: string;
    enum?: string[];
    default?: unknown;
    keywords?: string[];
    order: number;
    minimum?: number;
    maximum?: number;
  }[];
}

function scalarDefault(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;
  return undefined;
}

export function pluginSettingsToDefs(domains: readonly PluginSettingDomainInput[]): SettingDef[] {
  const defs: SettingDef[] = [];
  for (const domain of domains) {
    for (const item of domain.items) {
      const type: SettingType = item.type === 'integer' ? 'number' : item.type;
      defs.push({
        id: item.id,
        key: item.key,
        scope: 'user',
        type,
        source: `plugin:${domain.pluginId}`,
        title: item.title,
        ...(item.description !== undefined ? { description: item.description } : {}),
        category: 'extensions',
        order: item.order,
        ...(item.enum !== undefined ? { options: item.enum } : {}),
        ...(item.minimum !== undefined ? { min: item.minimum } : {}),
        ...(item.maximum !== undefined ? { max: item.maximum } : {}),
        ...(scalarDefault(item.default) !== undefined
          ? { default: scalarDefault(item.default) }
          : {}),
        keywords: [domain.pluginId, domain.pluginName, ...(item.keywords ?? [])],
        pluginId: domain.pluginId,
        // object/array：v1 只读 JSON（§3.5）。
        ...(type === 'object' || type === 'array' ? { readOnly: true } : {}),
      });
    }
  }
  return defs;
}

export function settingDefFor(defs: readonly SettingDef[], id: string): SettingDef | undefined {
  return defs.find((def) => def.id === id);
}
