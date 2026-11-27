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
  /** 分类内子分组 id（q-msg-visibility：「消息显示」组；渲染侧出组头，i18n settings.group.<id>）。 */
  group?: string;
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
  /** number 键接受浮点（depth-color D7；缺省 false = 整数，旧键行为不变）。 */
  float?: boolean;
  /** max 为开区间上界（depth-color rootHue ∈ [0,360)；与 serve config.set 同口径）。 */
  maxExclusive?: boolean;
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

/** 树深度配色键前缀（depth-color；视觉分类）。 */
export const DEPTH_COLOR_SETTING_PREFIX = 'ui.depthColor.';

/**
 * 核心键的 legacy 短 id（旧 DISPLAY_SETTINGS.id / i18n 后缀）：
 * ui.* / observability.showProcessErrors 取末段；log.* → log<Level>；
 * emptyResponse.* → emptyResponse<Enabled>。搜索别名与派生层共用此规则。
 */
export function coreShortId(key: string): string {
  for (const [prefix, stem] of [
    [LOG_SETTING_PREFIX, 'log'],
    [EMPTY_RESPONSE_SETTING_PREFIX, 'emptyResponse'],
    // depth-color：depthColor<Enabled/RootHue/…>，避免末段 'enabled' 这类泛化 id 碰撞。
    [DEPTH_COLOR_SETTING_PREFIX, 'depthColor'],
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
  /** q-tool-result-whitelist 起含 'array'（只读 JSON 展示，照 plugin object/array 先例）。 */
  type: 'boolean' | 'enum' | 'number' | 'string' | 'array';
  options?: readonly string[];
  min?: number;
  max?: number;
  /** number 键接受浮点（depth-color D7；缺省 false = 整数）。 */
  float?: boolean;
  /** max 开区间上界（与 serve config.set maxExclusive 同口径）。 */
  maxExclusive?: boolean;
  default?: string;
  fallback?: string;
  /** 分类内子分组（SettingDef.group）。 */
  group?: string;
  /** 额外搜索别名（中英旧称），与自动 shortId/snake 关键词合并。 */
  keywords?: readonly string[];
}

const CORE_SETTING_SPECS: readonly CoreSettingSpec[] = [
  { key: 'ui.verbosity', type: 'enum', options: ['minimal', 'normal', 'debug'], default: 'normal' },
  // q-msg-visibility（用户裁定）：消息显示五 toggle，归显示分类的「消息显示」子分组。
  // 默认视觉契约不变：系统信息**默认隐藏**（fallback 'false' 是缺省值的显式 codify）；
  // 其余四类默认开 = 现行观感。旧 ui.showInternalEvents 从 UI 撤下（兼容映射：
  // system 未配置时读旧键，见 display-settings.readDisplayValue / state/message-visibility），
  // 键本身保留在 schema 与 gateway/CLI 白名单，存量配置与脚本不破坏。
  {
    key: 'ui.messageVisibility.reasoning',
    type: 'boolean',
    default: 'true',
    fallback: 'true',
    group: 'messageVisibility',
    keywords: ['思考', 'thinking', '消息显示', 'message display'],
  },
  {
    key: 'ui.messageVisibility.tools',
    type: 'boolean',
    default: 'true',
    fallback: 'true',
    group: 'messageVisibility',
    keywords: ['工具', 'tool', '消息显示', 'message display'],
  },
  {
    key: 'ui.messageVisibility.environment',
    type: 'boolean',
    default: 'true',
    fallback: 'true',
    group: 'messageVisibility',
    keywords: ['环境', 'notice', '消息显示', 'message display'],
  },
  {
    key: 'ui.messageVisibility.source',
    type: 'boolean',
    default: 'true',
    fallback: 'true',
    group: 'messageVisibility',
    keywords: ['来源', 'from', '消息显示', 'message display'],
  },
  {
    key: 'ui.messageVisibility.system',
    type: 'boolean',
    default: 'false',
    fallback: 'false',
    group: 'messageVisibility',
    keywords: ['系统', 'internal', 'showInternalEvents', '内部事件', '消息显示', 'message display'],
  },
  // 0.51：已归档 Team / 已停用 agent 的默认隐藏开关。与 showInternalEvents 同一层
  // （同一个 ui 块、同一条 config.set 写路径），入口也在同一个「显示与可见性」分组。
  { key: 'ui.showArchived', type: 'boolean', default: 'false' },
  { key: 'ui.errorLevel', type: 'enum', options: ['user', 'all'], default: 'user' },
  { key: 'observability.showProcessErrors', type: 'boolean', default: 'false' },
  { key: 'ui.askUser', type: 'boolean', default: 'true' },
  { key: 'ui.showReasoning', type: 'boolean', default: 'false' },
  { key: 'ui.expandCards', type: 'boolean', default: 'false' },
  // q-addr-display（用户裁定）：地址显示三档，缺省 name 优先（轻量有质感）。
  // fallback 让「未配置」回显真实缺省档；只影响显示层，路由地址恒 canonical full-id。
  {
    key: 'ui.addressStyle',
    type: 'enum',
    options: ['name', 'compact', 'full'],
    default: 'name',
    fallback: 'name',
    keywords: ['地址', 'address', '显示格式', '节点名', 'short-id', 'uuid'],
  },
  { key: 'ui.statusBars', type: 'enum', options: ['top', 'bottom', 'both', 'none'] },
  { key: 'ui.language', type: 'enum', options: ['zh-CN', 'en'], default: 'zh-CN' },
  // 日志中枢（gateway）：modules 是 map，一期只读（不走 config.set）。
  // fallback = 未配置时的真实缺省行为（DEFAULT_LOG_OPTIONS）。config.get 下发的是
  // 用户原始配置（未填默认），缺 observability.log 时 readDisplayValue 回落到 fallback，
  // 档位 radio 才有勾选态可回显——否则 value='' 四个档全不勾，用户看不到当前生效档。
  {
    key: 'observability.log.level',
    type: 'enum',
    options: ['debug', 'info', 'warn', 'error'],
    default: 'info',
    fallback: 'info',
  },
  {
    key: 'observability.log.color',
    type: 'enum',
    options: ['auto', 'always', 'never'],
    default: 'auto',
    fallback: 'auto',
  },
  {
    key: 'observability.log.format',
    type: 'enum',
    options: ['pretty', 'json'],
    default: 'pretty',
    fallback: 'pretty',
  },
  {
    key: 'observability.log.time',
    type: 'enum',
    options: ['auto', 'none', 'clock', 'iso'],
    default: 'auto',
    fallback: 'auto',
  },
  // q-empty-response：空响应兜底（core 运行期设置，非插件域）。缺省 = 启用、重试 2 次、
  // 内置 nudge 文案；fallback 让「未配置」显示真实缺省行为而不是空。
  { key: 'emptyResponse.enabled', type: 'boolean', default: 'true', fallback: 'true' },
  { key: 'emptyResponse.seamless', type: 'boolean', default: 'true', fallback: 'true' },
  { key: 'emptyResponse.maxRetries', type: 'number', min: 0, max: 10, default: '2', fallback: '2' },
  { key: 'emptyResponse.nudge', type: 'string' },
  // depth-color（用户裁定 D1-D7）：会话卡地址子标题树深度配色七键，归视觉分类的
  // 「深度配色」子分组（与 messageVisibility 子分组同构）。缺省即现状锚点：
  // light depth0 逐字节 = 现 accent-ink（零回归）；L 值域 = WCAG 对比度护栏
  // （dark 下界 0.73 由全 C 值域压力实证锁定，见 state/depth-color.ts）。
  {
    key: 'ui.depthColor.enabled',
    type: 'boolean',
    default: 'true',
    fallback: 'true',
    group: 'depthColor',
    keywords: ['深度', '层级', 'depth', '配色', 'color', '色相'],
  },
  {
    key: 'ui.depthColor.rootHue',
    type: 'number',
    float: true,
    min: 0,
    max: 360,
    maxExclusive: true,
    default: '172.6',
    fallback: '172.6',
    group: 'depthColor',
    keywords: ['根色相', 'root hue', '色相', 'hue', '品牌', '黄金角'],
  },
  {
    key: 'ui.depthColor.hueStep',
    type: 'number',
    float: true,
    min: 0,
    max: 360,
    default: '137.508',
    fallback: '137.508',
    group: 'depthColor',
    keywords: ['步进', '黄金角', 'golden', '轮转', 'step', '色相'],
  },
  {
    key: 'ui.depthColor.lightnessLight',
    type: 'number',
    float: true,
    min: 0.3,
    max: 0.51,
    default: '0.4714',
    fallback: '0.4714',
    group: 'depthColor',
    keywords: ['亮度', 'lightness', 'OKLCH', 'light', '亮色'],
  },
  {
    key: 'ui.depthColor.chromaLight',
    type: 'number',
    float: true,
    min: 0,
    max: 0.37,
    default: '0.0887',
    fallback: '0.0887',
    group: 'depthColor',
    keywords: ['色度', 'chroma', '饱和度', 'light', '亮色'],
  },
  {
    key: 'ui.depthColor.lightnessDark',
    type: 'number',
    float: true,
    min: 0.73,
    max: 0.95,
    default: '0.85',
    fallback: '0.85',
    group: 'depthColor',
    keywords: ['亮度', 'lightness', 'OKLCH', 'dark', '暗色'],
  },
  {
    key: 'ui.depthColor.chromaDark',
    type: 'number',
    float: true,
    min: 0,
    max: 0.37,
    default: '0.13',
    fallback: '0.13',
    group: 'depthColor',
    keywords: ['色度', 'chroma', '饱和度', 'dark', '暗色'],
  },
  // q-team-limit-config：Team present 成员上限（缺省 100；正整数 ≥1，无人为上限）。
  // 构造期注入 AgentService，写后需重启生效（desc 注明）。
  {
    key: 'agent.teamMemberLimit',
    type: 'number',
    min: 1,
    default: '100',
    fallback: '100',
    keywords: ['成员上限', '团队人数', 'team limit', 'team_full'],
  },
  // q-tool-result-whitelist：工具结果压缩白名单（YAML `context.tool_result_whitelist`）。
  // 一期 YAML-only（照 modules 先例）：WebUI 只读 JSON 展示，不走 config.set；
  // 构造期注入，重启生效（desc 注明）。缺省 = core 内置默认（inbox read + agent read）；
  // 显式 [] = 关闭；显式列表整体替换。抗 trim 不抗 compaction。
  {
    key: 'context.toolResultWhitelist',
    type: 'array',
    default: '[{"tool":"inbox","action":"read"},{"tool":"agent","action":"read"}]',
    fallback: '[{"tool":"inbox","action":"read"},{"tool":"agent","action":"read"}]',
    keywords: ['白名单', 'whitelist', 'trim', '占位', 'placeholder', 'inbox', '压缩', '豁免'],
  },
];

/** 「常用」curated 清单（§6 + 裁定③：系统信息是默认视觉旗舰键；q-msg-visibility 起为 messageVisibility.system）。 */
const CORE_COMMON: ReadonlySet<string> = new Set([
  'ui.verbosity',
  'ui.language',
  'ui.askUser',
  'ui.showReasoning',
  'ui.messageVisibility.system',
]);

function coreCategory(key: string): string {
  if (key === 'ui.language' || key === 'ui.statusBars') return 'visual';
  // depth-color：与 local.theme / designLab 同视觉分类（depthColor 子分组）。
  if (key.startsWith(DEPTH_COLOR_SETTING_PREFIX)) return 'visual';
  if (key.startsWith(LOG_SETTING_PREFIX)) return 'logs';
  if (key.startsWith(EMPTY_RESPONSE_SETTING_PREFIX)) return 'runtime';
  if (key === 'agent.teamMemberLimit') return 'runtime';
  if (key === 'context.toolResultWhitelist') return 'runtime';
  return 'display';
}

function snakeCase(id: string): string {
  return id.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * 核心服务端设置（scope=user，S5 起 project 可覆盖）。
 * descriptionKey 指向 .desc（可能不存在）——渲染侧必须经 i18n hasMessage 判定，
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
    titleKey: `settings.item.${shortId}.title`,
    descriptionKey: `settings.item.${shortId}.desc`,
    category: coreCategory(spec.key),
    ...(spec.group !== undefined ? { group: spec.group } : {}),
    common: CORE_COMMON.has(spec.key) ? true : undefined,
    options: spec.options,
    min: spec.min,
    max: spec.max,
    ...(spec.float !== undefined ? { float: spec.float } : {}),
    ...(spec.maxExclusive !== undefined ? { maxExclusive: spec.maxExclusive } : {}),
    default: spec.default,
    fallback: spec.fallback,
    keywords: [shortId, snakeCase(shortId), ...(spec.keywords ?? [])],
    // array/object：v1 只读 JSON（照 pluginSettingsToDefs 同一口径；YAML-only 键）。
    ...(spec.type === 'array' ? { readOnly: true } : {}),
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
    key: 'vessel.nav.expanded-groups',
    scope: 'local',
    type: 'object',
    source: 'core',
    titleKey: 'settings.item.local.navGroups.title',
    descriptionKey: 'settings.item.local.navGroups.desc',
    category: 'visual',
    // 只读展示 + 重置（§5.3）；v1 经通用 local 重置清空存储键 = 回到默认全收起。
    readOnly: true,
    resettable: true,
    keywords: ['nav', 'groups', '分组', '展开', '折叠'],
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
