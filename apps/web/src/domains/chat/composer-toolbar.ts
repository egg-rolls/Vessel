/**
 * 输入框工具栏的扩展槽接线（会话 / 团队共用）。
 *
 * 插件侧 declarative 声明（`contributes.toolbar[]`），点击三档：
 * - action 档（file-ref P3 additive）：插件 embed 具名导出，宿主注入编辑端口
 *   调用（composer-extensions bridge 注册）——插件自持点击动作，宿主零功能名；
 * - menu 档：RPC 绑定菜单（{@link useComposerToolbarMenuActions}）；
 * - 缺省档：宿主按 id 映射成宿主回调，没给 handler 的条目**直接丢弃**，
 *   不渲染点了没反应的死按钮。宿主当前无自绘动作 id（0.52 的 `attach-file`
 *   已随 file-ref P3 D4 退役，入口归插件 action 档）。
 */
import type { ComposerEditorPort } from '@vessel-agent/plugin-sdk';
import type { ComposerToolbarAction } from '@vessel-agent/plugin-ui';
import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginI18n } from '../../gateway/types';
import { getLocale, t, useLocale } from '../../i18n';
import {
  type ComposerToolbarActionRegistration,
  useComposerExtensions,
} from '../plugins/composer-extensions';
import { type PluginToolbarItem, pluginT } from '../plugins/plugin-contributions';
import { toolbarForSlot, usePluginContributions } from '../plugins/usePluginContributions';

/** 宿主回调表：条目 id → 动作（点击时调用）。 */
export type ComposerToolbarHostActions = Readonly<Record<string, (() => void) | undefined>>;

/**
 * 插件贡献项 + 宿主回调表 → toolbar 组件认识的 declarative 动作。
 *
 * 点击三档（file-ref P3 additive 后）：
 * - action 档：插件 embed 具名导出（经 composer-extensions bridge 注册），
 *   宿主注入编辑端口调用；无注册导出 / 无端口 ⇒ 条目丢弃（不渲染死按钮）；
 * - 缺省档：宿主回调表按 id 映射，没给回调的 id 直接丢弃（含插件条目）。
 */
export function composerToolbarActions(
  items: readonly PluginToolbarItem[],
  handlers: ComposerToolbarHostActions,
  i18nByPlugin: ReadonlyMap<string, PluginI18n> = new Map(),
  locale: string = getLocale(),
  toolbarActions: readonly ComposerToolbarActionRegistration[] = [],
  port?: ComposerEditorPort,
): ComposerToolbarAction[] {
  const actions: ComposerToolbarAction[] = [];
  for (const item of items) {
    const fullId = `${item.pluginId}:${item.id}`;
    const label = pluginT(i18nByPlugin, item.pluginId, item.titleKey, locale, item.label, item.id);
    if (item.action !== undefined) {
      const registration = toolbarActions.find((entry) => entry.id === fullId);
      if (registration === undefined || port === undefined) continue;
      const handler = registration.handler;
      const editorPort = port;
      const host = registration.host;
      actions.push({
        id: fullId,
        label,
        text: label,
        onSelect: () => {
          void handler(editorPort, host);
        },
      });
      continue;
    }
    const onSelect = handlers[item.id];
    if (onSelect === undefined) continue;
    actions.push({
      id: fullId,
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
 * port（file-ref P3 additive）：页面侧编辑端口；缺省 ⇒ action 档条目不渲染。
 */
export function useComposerToolbarActions(
  handlers: ComposerToolbarHostActions,
  port?: ComposerEditorPort,
): ComposerToolbarAction[] {
  const { toolbar, i18nByPlugin } = usePluginContributions();
  const { toolbarActions } = useComposerExtensions();
  const locale = useLocale();
  return useMemo(
    () =>
      composerToolbarActions(
        toolbarForSlot(toolbar, 'composer'),
        handlers,
        i18nByPlugin,
        locale,
        toolbarActions,
        port,
      ),
    [toolbar, handlers, i18nByPlugin, locale, toolbarActions, port],
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
          // pill 前缀标签（用户验收①）：宿主 catalog 提供「思考:」/「Thinking:」，
          // 与 auto 豁免同在宿主归一层；工具栏 / Select 只认通用 prefix 字段。
          prefix: t('chat.thinking.label'),
          ...(readState?.current !== undefined ? { current: readState.current } : {}),
          // hint 通用解析（q-ti-hint）：契约允许 i18n key 或短文案——先按插件
          // catalog 解析（plugin[locale]→plugin.en→宿主 t），未命中回落原文。
          // 宿主零插件专属代码：任何插件的 hint key 都走这一条。
          ...(readState?.hint !== undefined
            ? { hint: pluginT(i18nByPlugin, item.pluginId, readState.hint, locale, readState.hint) }
            : {}),
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
