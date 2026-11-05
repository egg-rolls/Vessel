/** Status 导航组的 React 绑定：轮询 config 以刷新版本与 hub 三态。 */
import { hubInfoFromConfig } from '../domains/hub/hub-state';
import { useConnection } from '../gateway/ConnectionProvider';
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

  const data = resourceData(config);
  const gateway = gatewayNavStatus(connectionState, hasToken);
  const version = data?.version;
  const hub = hubNavStatus(
    data ? hubInfoFromConfig(data.config) : undefined,
    gateway,
    hasToken,
    version,
  );
  const marketplace = plugins.find((plugin) => plugin.name === 'marketplace');
  return {
    hub,
    gateway: version !== undefined ? { ...gateway, version } : gateway,
    pluginHost: pluginHostNavStatus(marketplace),
  };
}
