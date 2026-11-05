/**
 * 读 `plugins.list` 并平铺贡献点。所有消费者共用同一 wire 方法；零插件 /
 * 旧 gateway 返回空集合，调用方不需要特判。
 */
import { useMemo } from 'react';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginListItem } from '../../gateway/types';
import { type ResourceState, resourceData, useResource } from '../../state/useResource';
import {
  buildPluginInventory,
  type PluginInventory,
  type PluginPageItem,
  type PluginPanelItem,
} from './plugin-contributions';

const EMPTY_PLUGINS: readonly PluginListItem[] = [];

export interface PluginContributionsState extends PluginInventory {
  plugins: readonly PluginListItem[];
  state: ResourceState<PluginListItem[]>;
  reload: () => void;
}

export function usePluginContributions(): PluginContributionsState {
  const { client, connectionState, hasToken, epoch, tenantId } = useConnection();
  const resource = useResource({
    load: () => client.listPlugins(),
    enabled: hasToken && connectionState === 'open',
    deps: [epoch, tenantId],
  });
  const plugins = resourceData(resource.state) ?? EMPTY_PLUGINS;
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
