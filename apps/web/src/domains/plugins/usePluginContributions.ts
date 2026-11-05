/**
 * 读 `plugins.list` 并平铺贡献点。所有消费者共用同一 wire 方法；零插件 /
 * 旧 gateway 返回空集合，调用方不需要特判。
 *
 * CONTRACT-0.43 §2.8（E3）：收到 `plugin.changed` 时先用事件里的
 * `plugins.list` 形状快照立即更新，再在 200ms 去抖后重新拉取 `plugins.list`
 * 做对账；被删除 / 禁用的 plugin 因此会立即从导航与页面上下文消失。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginListItem } from '../../gateway/types';
import { type ResourceState, resourceData, useResource } from '../../state/useResource';
import {
  buildPluginInventory,
  type PluginInventory,
  type PluginPageItem,
  type PluginPanelItem,
  pluginsFromChangedPayload,
} from './plugin-contributions';

const EMPTY_PLUGINS: readonly PluginListItem[] = [];

/** gateway 自身 reload 已去抖 300ms；Web 端再合并批量事件即可。 */
export const PLUGIN_CHANGED_DEBOUNCE_MS = 200;

export interface PluginContributionsState extends PluginInventory {
  plugins: readonly PluginListItem[];
  state: ResourceState<PluginListItem[]>;
  reload: () => void;
}

export function usePluginContributions(): PluginContributionsState {
  const { client, connectionState, hasToken, epoch, tenantId, eventStore } = useConnection();
  const resource = useResource({
    load: () => client.listPlugins(),
    enabled: hasToken && connectionState === 'open',
    deps: [epoch, tenantId],
  });
  const reloadRef = useRef(resource.reload);
  reloadRef.current = resource.reload;
  /** E3 快照；plugins.list 成功返回一次后清空，以 wire 结果为准。 */
  const [changedSnapshot, setChangedSnapshot] = useState<readonly PluginListItem[] | null>(null);
  const awaitingReconcile = useRef(false);

  useEffect(() => {
    let lastVersion = eventStore.getSnapshot().version;
    let timer: number | undefined;
    const unsubscribe = eventStore.subscribe(() => {
      const snapshot = eventStore.getSnapshot();
      if (snapshot.version === lastVersion) return;
      lastVersion = snapshot.version;
      const recent = snapshot.entries.slice(-20);
      let changed = false;
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        const event = recent[index]?.event;
        if (event?.type !== 'plugin.changed') continue;
        changed = true;
        const parsed = pluginsFromChangedPayload(event.data);
        if (parsed !== null) setChangedSnapshot(parsed);
        break;
      }
      if (!changed) return;
      awaitingReconcile.current = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => reloadRef.current(), PLUGIN_CHANGED_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [eventStore]);

  useEffect(() => {
    if (!awaitingReconcile.current) return;
    if (resource.state.status !== 'success') return;
    awaitingReconcile.current = false;
    setChangedSnapshot(null);
  }, [resource.state]);

  const plugins: readonly PluginListItem[] =
    changedSnapshot ?? resourceData(resource.state) ?? EMPTY_PLUGINS;
  const inventory = useMemo(() => buildPluginInventory(plugins), [plugins]);
  return {
    plugins,
    ...inventory,
    state: resource.state,
    reload: resource.reload,
  };
}

export function pagesForNav(
  pages: readonly PluginPageItem[],
  nav: PluginPageItem['nav'],
): PluginPageItem[] {
  return pages.filter((page) => page.nav === nav);
}

export function panelsForSlot(
  panels: readonly PluginPanelItem[],
  slot: PluginPanelItem['slot'],
): PluginPanelItem[] {
  return panels.filter((panel) => panel.slot === slot);
}
