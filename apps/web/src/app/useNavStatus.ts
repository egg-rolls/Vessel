/** Status 导航组的 React 绑定：config 只用于 gateway 版本；Hub 状态与版本来自 Hub 页直连快照。 */
import { useSyncExternalStore } from 'react';
import { useConnection } from '../gateway/ConnectionProvider';
import { getHubNavStatus, subscribeHubNavStatus } from '../gateway/platform/hub-storage';
import type { PluginListItem } from '../gateway/types';
import { resourceData } from '../state/useResource';
import { useConfigStoreApi } from '../stores/useConfigStoreApi';
import {
  gatewayNavStatus,
  hubNavStatus,
  type NavStatuses,
  pluginHostNavStatus,
} from './nav-status';

/** `plugins` 来自 `usePluginContributions()`，避免重复拉取 `plugins.list`。 */
export function useNavStatus(plugins: readonly PluginListItem[]): NavStatuses {
  const { connectionState, hasToken } = useConnection();
  const { config } = useConfigStoreApi({ pollMs: 60_000 });
  const hub = useSyncExternalStore(subscribeHubNavStatus, getHubNavStatus, getHubNavStatus);

  const data = resourceData(config);
  const gateway = gatewayNavStatus(connectionState, hasToken);
  const version = data?.version;
  const marketplace = plugins.find((plugin) => plugin.name === 'marketplace');
  const hubMeta = hubNavStatus(hub.status);
  return {
    hub: hub.version !== undefined ? { ...hubMeta, version: hub.version } : hubMeta,
    gateway: version !== undefined ? { ...gateway, version } : gateway,
    pluginHost: pluginHostNavStatus(marketplace),
  };
}
