/**
 * 输入框工具栏的扩展槽接线（会话 / 团队共用）。
 *
 * 插件侧只有 declarative 声明（`contributes.toolbar[]`：slot / id / label），
 * 点击由宿主映射成宿主回调：
 * - 宿主没给 handler 的条目**直接丢弃**，不渲染点了没反应的死按钮；
 * - 插件拿不到宿主回调（拿不到文件选择、拿不到路由），因此 v1 不做插件内联执行；
 *   需要「打开文件选择」这类宿主动作时，在 {@link COMPOSER_TOOLBAR_HOST_ACTIONS}
 *   里按 id 登记，插件只声明同一个 id + 文案。0.52 已登记 `attach-file`：
 *   宿主按钮与插件条目共用同一个「引用文件」popover（回调由 composer 注入，
 *   见 {@link composerHostActions}）。
 */
import type { ComposerToolbarAction } from '@vessel-agent/plugin-ui';
import { useMemo } from 'react';
import type { PluginI18n } from '../../gateway/types';
import { getLocale, t, useLocale } from '../../i18n';
import { type PluginToolbarItem, pluginT } from '../plugins/plugin-contributions';
import { toolbarForSlot, usePluginContributions } from '../plugins/usePluginContributions';

/** 宿主回调表：条目 id → 动作（点击时调用）。 */
export type ComposerToolbarHostActions = Readonly<Record<string, (() => void) | undefined>>;

/**
 * 「引用文件」的宿主动作 id（粘贴路径 popover）。
 *
 * 插件要复用宿主行为时只声明这个 id：`contributes.toolbar: [{ slot: 'composer',
 * id: 'attach-file', label/titleKey }]`，宿主按钮与插件条目共用同一个开关回调 ——
 * 不新增 RPC、不让插件自己碰文件选择 / 草稿槽。
 */
export const COMPOSER_TOOLBAR_ATTACH_FILE = 'attach-file';

/** 宿主认识的工具栏动作 id（插件可声明同名 id 复用之）。 */
export type ComposerToolbarHostActionId = typeof COMPOSER_TOOLBAR_ATTACH_FILE;

/**
 * 当前宿主已接的动作 id。
 *
 * 0.52 起有 `attach-file`：宿主自己的按钮（图标 + aria-label）与插件贡献的同名条目
 * 都打开同一个粘贴路径 popover。表里只有 **id**，没有回调 —— popover 的开关状态在
 * 各页 composer 里（per-实例），回调由 {@link composerHostActions} 组装后传给工具栏；
 * 没给回调的 id 条目会被丢弃，不渲染点了没反应的死按钮。
 */
export const COMPOSER_TOOLBAR_HOST_ACTIONS: readonly ComposerToolbarHostActionId[] = [
  COMPOSER_TOOLBAR_ATTACH_FILE,
];

/** composer 侧要提供的宿主动作回调（每个页面自己持有状态）。 */
export interface ComposerHostActionHandlers {
  /** 开关「引用文件」popover；缺省时该动作（含插件同名条目）不渲染。 */
  attachFile?: () => void;
}

/** 宿主动作回调 → 工具栏认识的 id 表；只登记有回调的 id。 */
export function composerHostActions(
  handlers: ComposerHostActionHandlers,
): ComposerToolbarHostActions {
  const actions: Record<string, (() => void) | undefined> = {};
  if (handlers.attachFile !== undefined) {
    actions[COMPOSER_TOOLBAR_ATTACH_FILE] = handlers.attachFile;
  }
  return actions;
}

/**
 * 插件贡献项 + 宿主回调表 → toolbar 组件认识的 declarative 动作。
 *
 * 回调表是唯一开关：宿主没给回调的 id 直接丢弃（含插件条目），不渲染死按钮。
 */
export function composerToolbarActions(
  items: readonly PluginToolbarItem[],
  handlers: ComposerToolbarHostActions,
  i18nByPlugin: ReadonlyMap<string, PluginI18n> = new Map(),
  locale: string = getLocale(),
): ComposerToolbarAction[] {
  const actions: ComposerToolbarAction[] = [];
  for (const item of items) {
    const onSelect = handlers[item.id];
    if (onSelect === undefined) continue;
    const label = pluginT(i18nByPlugin, item.pluginId, item.titleKey, locale, item.label, item.id);
    actions.push({
      id: `${item.pluginId}:${item.id}`,
      label,
      text: label,
      onSelect,
    });
  }
  return actions;
}

/**
 * 读插件贡献并映射成工具栏动作。内部读的是与导航 / panel 同一份
 * `plugins.list` 结果（`usePluginContributions`），不新开轮询 / 新 RPC。
 */
export function useComposerToolbarActions(
  handlers: ComposerToolbarHostActions,
): ComposerToolbarAction[] {
  const { toolbar, i18nByPlugin } = usePluginContributions();
  const locale = useLocale();
  return useMemo(
    () =>
      composerToolbarActions(toolbarForSlot(toolbar, 'composer'), handlers, i18nByPlugin, locale),
    [toolbar, handlers, i18nByPlugin, locale],
  );
}

/** 工具栏扩展槽的无障碍名称（会话 / 团队同一份文案）。 */
export function composerToolbarLabel(): string {
  return t('composer.toolbar.label');
}
