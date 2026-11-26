/**
 * 输入框工具栏的扩展槽接线（会话 / 团队共用）。
 *
 * 插件侧只有 declarative 声明（`contributes.toolbar[]`：slot / id / label），
 * 点击由宿主映射成宿主回调：
 * - 宿主没给 handler 的条目**直接丢弃**，不渲染点了没反应的死按钮；
 * - 插件拿不到宿主回调（拿不到文件选择、拿不到路由），因此 v1 不做插件内联执行；
 *   需要「打开文件选择」这类宿主动作时，在 {@link COMPOSER_TOOLBAR_HOST_ACTIONS}
 *   里按 id 登记，插件只声明同一个 id + 文案。0.52 已登记 `attach-file`：
 *   宿主按钮与插件条目共用同一个「引用文件」弹层（回调由 composer 注入，
 *   见 {@link composerHostActions}）。
 */
import type { ComposerToolbarAction } from '@vessel-agent/plugin-ui';
import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginI18n } from '../../gateway/types';
import { getLocale, t, useLocale } from '../../i18n';
import { type PluginToolbarItem, pluginT } from '../plugins/plugin-contributions';
import { toolbarForSlot, usePluginContributions } from '../plugins/usePluginContributions';

/** 宿主回调表：条目 id → 动作（点击时调用）。 */
export type ComposerToolbarHostActions = Readonly<Record<string, (() => void) | undefined>>;

/**
 * 「引用文件」的宿主动作 id（打开浏览 / 粘贴弹层）。
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
 * 都打开同一个弹层（浏览 / 粘贴）。表里只有 **id**，没有回调 —— 弹层的开关状态在
 * 各页 composer 里（per-实例），回调由 {@link composerHostActions} 组装后传给工具栏；
 * 没给回调的 id 条目会被丢弃，不渲染点了没反应的死按钮。
 */
export const COMPOSER_TOOLBAR_HOST_ACTIONS: readonly ComposerToolbarHostActionId[] = [
  COMPOSER_TOOLBAR_ATTACH_FILE,
];

/** composer 侧要提供的宿主动作回调（每个页面自己持有状态）。 */
export interface ComposerHostActionHandlers {
  /** 开关「引用文件」弹层；缺省时该动作（含插件同名条目）不渲染。 */
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

/** 单个菜单按钮的 read RPC 状态（通用形状，设计 §4.7.2）。 */
interface ToolbarMenuReadState {
  current?: string;
  enabled?: boolean;
  options?: string[];
  hint?: string;
}

/**
 * 通用 RPC 绑定菜单动作（additive，q-thinking-plugin P3）。
 *
 * 菜单条目不走 hostActions 表：宿主经 read RPC 取当前值 / 能力过滤 / 说明，经 write
 * RPC 落选中值（sessionScoped 时注入当前 session_id）。宿主零插件专属代码——任何
 * 声明了 menu 的插件都走这一条。read 时机：挂载 + 会话切换 + write 成功后重拉。
 * 旧 gateway 无 menu 透传 ⇒ menuItems 为空 ⇒ 返回空数组（既有按钮规则不变）。
 */
export function useComposerToolbarMenuActions(sessionId?: string): ComposerToolbarAction[] {
  const { toolbar, i18nByPlugin } = usePluginContributions();
  const locale = useLocale();
  const { client, hasToken, connectionState } = useConnection();
  const menuItems = useMemo(
    () => toolbarForSlot(toolbar, 'composer').filter((item) => item.menu !== undefined),
    [toolbar],
  );
  const [states, setStates] = useState<Record<string, ToolbarMenuReadState>>({});

  const connected = hasToken && connectionState === 'open';

  // read RPC：挂载 / 会话切换 / 连接恢复 / 菜单声明变化时重拉。
  useEffect(() => {
    if (!connected || menuItems.length === 0) return;
    let cancelled = false;
    for (const item of menuItems) {
      const menu = item.menu;
      if (menu === undefined) continue;
      const key = `${item.pluginId}:${item.id}`;
      const params =
        menu.sessionScoped === true && sessionId !== undefined ? { session_id: sessionId } : {};
      client
        .rpc<Record<string, unknown>>(`plugin.${item.pluginId}.${menu.read}`, params)
        .then((result) => {
          if (cancelled || result === null || typeof result !== 'object') return;
          const current = result[menu.valueKey];
          const options = result.options;
          const hint = result.hint;
          setStates((prev) => ({
            ...prev,
            [key]: {
              ...(typeof current === 'string' ? { current } : {}),
              ...(typeof result.enabled === 'boolean' ? { enabled: result.enabled } : {}),
              ...(Array.isArray(options)
                ? { options: options.filter((v): v is string => typeof v === 'string') }
                : {}),
              ...(typeof hint === 'string' ? { hint } : {}),
            },
          }));
        })
        .catch(() => {
          // read 失败不阻断渲染：按钮保持全档可选（诚实降级）。
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, connected, sessionId, menuItems]);

  return useMemo(() => {
    const actions: ComposerToolbarAction[] = [];
    for (const item of menuItems) {
      const menu = item.menu;
      if (menu === undefined) continue;
      const key = `${item.pluginId}:${item.id}`;
      const readState = states[key];
      const label = pluginT(
        i18nByPlugin,
        item.pluginId,
        item.titleKey,
        locale,
        item.label,
        item.id,
      );
      // 能力过滤：options 存在时只渲染其中的具体档位；auto 项恒保留——auto=清 override /
      // 跟随全局默认，对任何模型都合法（含不支持思考的模型，此时菜单仅 auto 可选）。
      // 豁免在宿主归一层，插件 getState 的 options 语义不变（设计 §6.3，插件零改）。
      const options = readState?.options;
      const filtered =
        options !== undefined
          ? menu.items.filter((entry) => entry.value === 'auto' || options.includes(entry.value))
          : menu.items;
      const items = filtered.map((entry) => ({
        value: entry.value,
        label: pluginT(
          i18nByPlugin,
          item.pluginId,
          entry.labelKey,
          locale,
          entry.label,
          entry.value,
        ),
      }));
      // 置灰只看过滤后是否还有可选项：不支持的模型仍可经 auto 清 override；
      // 无 auto 项的菜单在 options 为空时照旧整体置灰。
      const disabled =
        !connected ||
        readState?.enabled === false ||
        (options !== undefined && filtered.length === 0);
      actions.push({
        id: key,
        label,
        disabled,
        onSelect: () => {},
        menu: {
          items,
          ...(readState?.current !== undefined ? { current: readState.current } : {}),
          ...(readState?.hint !== undefined ? { hint: readState.hint } : {}),
          onSelect: (value: string) => {
            // 乐观更新按钮文案；write 成功后重拉 read（失败回落由下一轮 read 收敛）。
            setStates((prev) => ({ ...prev, [key]: { ...prev[key], current: value } }));
            const params: Record<string, unknown> = { [menu.valueKey]: value };
            if (menu.sessionScoped === true && sessionId !== undefined) {
              params.session_id = sessionId;
            }
            client
              .rpc(`plugin.${item.pluginId}.${menu.write}`, params)
              .then(() => {
                const readParams =
                  menu.sessionScoped === true && sessionId !== undefined
                    ? { session_id: sessionId }
                    : {};
                return client.rpc<Record<string, unknown>>(
                  `plugin.${item.pluginId}.${menu.read}`,
                  readParams,
                );
              })
              .then((result) => {
                if (result === null || typeof result !== 'object') return;
                const current = result[menu.valueKey];
                if (typeof current === 'string') {
                  setStates((prev) => ({ ...prev, [key]: { ...prev[key], current } }));
                }
              })
              .catch(() => {
                // write 失败：乐观值已由后续 read 收敛；不阻断 UI。
              });
          },
        },
      });
    }
    return actions;
  }, [menuItems, states, i18nByPlugin, locale, connected, client, sessionId]);
}
