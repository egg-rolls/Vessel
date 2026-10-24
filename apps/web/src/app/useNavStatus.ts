/** Status 导航组的 React 绑定：轮询 config 以刷新版本与 hub 三态。 */
import { hubInfoFromConfig } from '../domains/hub/hub-state';
import { useConnection } from '../gateway/ConnectionProvider';
import { resourceData, useResource } from '../state/useResource';
import { gatewayNavStatus, hubNavStatus, type NavStatuses } from './nav-status';

export function useNavStatus(): NavStatuses {
  const { client, connectionState, hasToken, epoch, tenantId } = useConnection();
  const config = useResource({
    load: () => client.getConfig(),
    enabled: hasToken,
    deps: [epoch, tenantId],
    pollMs: 60_000,
  });

  const data = resourceData(config.state);
  const gateway = gatewayNavStatus(connectionState, hasToken);
  const version = data?.version;
  const hub = hubNavStatus(
    data ? hubInfoFromConfig(data.config) : undefined,
    gateway,
    hasToken,
    version,
  );
  return {
    hub,
    gateway: version !== undefined ? { ...gateway, version } : gateway,
  };
}
