/**
 * 输入框工具栏的扩展槽接线（会话 / 团队共用）。
 *
 * 插件侧只有 declarative 声明（`contributes.toolbar[]`：slot / id / label），
 * 点击由宿主映射成宿主回调：
 * - 宿主没给 handler 的条目**直接丢弃**，不渲染点了没反应的死按钮；
 * - 插件拿不到宿主回调（拿不到文件选择、拿不到路由），因此 v1 不做插件内联执行；
 *   需要「打开文件选择」这类宿主动作时，在 {@link COMPOSER_TOOLBAR_HOST_ACTIONS}
 *   里按 id 登记，插件只声明同一个 id + 文案。
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
 * 当前宿主已接的动作。
 *
 * 空表是**有意**的：本轮只搭壳，真实文件 / 图片选择与上下文引用尚未接入；
 * 接的时候在这里登记 id → 回调，插件声明的同名条目就会出现在工具栏左侧。
 */
export const COMPOSER_TOOLBAR_HOST_ACTIONS: ComposerToolbarHostActions = {};

/** 插件贡献项 + 宿主回调表 → toolbar 组件认识的 declarative 动作。 */
export function composerToolbarActions(
  items: readonly PluginToolbarItem[],
  handlers: ComposerToolbarHostActions = COMPOSER_TOOLBAR_HOST_ACTIONS,
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
  handlers: ComposerToolbarHostActions = COMPOSER_TOOLBAR_HOST_ACTIONS,
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
