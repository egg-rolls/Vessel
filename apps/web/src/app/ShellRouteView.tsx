import { AgentsView } from '../domains/agents/AgentsView';
import { ChatView } from '../domains/chat/ChatView';
import { ToolCatalogProvider } from '../domains/chat/tool-catalog';
import { GatewayView } from '../domains/gateway/GatewayView';
import { HubView } from '../domains/hub/HubView';
import { IntegrationsView } from '../domains/integrations/IntegrationsView';
import { NodePanelView } from '../domains/nodes/NodePanelView';
import { ObserveView } from '../domains/observe/ObserveView';
import { RunsView } from '../domains/runs/RunsView';
import { SettingsView } from '../domains/settings/SettingsView';
import { TeamsView } from '../domains/teams/TeamsView';
import type { ConnectionState, GatewayClient } from '../gateway/client';
import type { Route } from './router';
import type { PaneResizeApi } from './usePaneResize';

/** 按路由渲染主域视图；外壳的 `<main>` 容器、key 与焦点管理留在 AppShell。 */
export function ShellRouteView({
  route,
  navigate,
  chatSessionsOpen,
  onCloseSessions,
  panes,
  client,
  hasToken,
  connectionState,
  epoch,
}: {
  route: Route;
  navigate: (route: Route) => void;
  chatSessionsOpen: boolean;
  onCloseSessions: () => void;
  panes: PaneResizeApi;
  client: GatewayClient;
  hasToken: boolean;
  connectionState: ConnectionState;
  epoch: number;
}) {
  return (
    <>
      {route.domain === 'chat' && (
        <ToolCatalogProvider
          client={client}
          enabled={hasToken && connectionState === 'open'}
          epoch={epoch}
        >
          <ChatView
            route={route}
            navigate={navigate}
            sessionsOpen={chatSessionsOpen}
            onCloseSessions={onCloseSessions}
            panes={panes}
          />
        </ToolCatalogProvider>
      )}
      {route.domain === 'hub' && <HubView />}
      {route.domain === 'gateway' && <GatewayView />}
      {route.domain === 'nodes' && <NodePanelView route={route} navigate={navigate} />}
      {route.domain === 'teams' && <TeamsView route={route} navigate={navigate} />}
      {route.domain === 'agents' && <AgentsView route={route} navigate={navigate} />}
      {route.domain === 'runs' && <RunsView route={route} navigate={navigate} />}
      {route.domain === 'integrations' && <IntegrationsView route={route} navigate={navigate} />}
      {route.domain === 'observe' && <ObserveView route={route} navigate={navigate} />}
      {route.domain === 'settings' && <SettingsView route={route} navigate={navigate} />}
    </>
  );
}
