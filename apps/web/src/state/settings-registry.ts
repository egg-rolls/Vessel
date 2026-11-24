/**
 * 设置注册表（VSCode 式设置重构 S1，docs/dev/plans/vscode-settings-design.md §2.2）。
 *
 * 单一事实源：核心定义（DISPLAY_SETTINGS 全量 + 本地偏好 + view 项）+ 插件设置域
 * （S3 起由 buildPluginInventory 归一化合并）。纯数据 + 纯函数，不 import React。
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

/** 核心定义（S1 第3步填充：DISPLAY_SETTINGS 派生 + 本地偏好 + view 项）。 */
export const CORE_SETTINGS: readonly SettingDef[] = [];

/** 注册表合并：核心 + 插件域（S3）。插件项 category 固定 extensions，不能注入核心分类。 */
export function mergeSettings(pluginDefs: readonly SettingDef[] = []): readonly SettingDef[] {
  return [...CORE_SETTINGS, ...pluginDefs];
}

export function settingDefFor(defs: readonly SettingDef[], id: string): SettingDef | undefined {
  return defs.find((def) => def.id === id);
}
