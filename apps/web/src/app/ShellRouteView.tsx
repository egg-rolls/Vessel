import { AgentsView } from '../domains/agents/AgentsView';
import { ChatView } from '../domains/chat/ChatView';
import { ToolCatalogProvider } from '../domains/chat/tool-catalog';
import { DesignLabView } from '../domains/design/DesignLabView';
import { GatewayView } from '../domains/gateway/GatewayView';
import { HubView } from '../domains/hub/HubView';
import { CapabilityView } from '../domains/integrations/CapabilityView';
import { NodePanelView } from '../domains/nodes/NodePanelView';
import { ObserveView } from '../domains/observe/ObserveView';
import { PendingView } from '../domains/pending/PendingView';
import { PluginHostView } from '../domains/plugins/PluginHostView';
import { PluginPageView } from '../domains/plugins/PluginPageView';
import { RunsView } from '../domains/runs/RunsView';
import { CapabilitiesPage, VisualPage } from '../domains/settings/NavPages';
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
      {route.domain === 'pending' && (
        <PendingView {...(route.sessionId ? { sessionId: route.sessionId } : {})} />
      )}
      {route.domain === 'gateway' && <GatewayView navigate={navigate} />}
      {route.domain === 'pluginHost' && <PluginHostView />}
      {route.domain === 'nodes' && <NodePanelView route={route} navigate={navigate} />}
      {route.domain === 'teams' && <TeamsView route={route} navigate={navigate} panes={panes} />}
      {route.domain === 'agents' && <AgentsView route={route} navigate={navigate} />}
      {route.domain === 'runs' && <RunsView route={route} navigate={navigate} />}
      {(route.domain === 'tools' || route.domain === 'mcp' || route.domain === 'channels') && (
        <CapabilityView domain={route.domain} />
      )}
      {route.domain === 'observe' && <ObserveView route={route} navigate={navigate} />}
      {route.domain === 'plugins' && <PluginPageView route={route} />}
      {route.domain === 'capabilities' && <CapabilitiesPage />}
      {route.domain === 'visual' && <VisualPage />}
      {route.domain === 'designLab' && <DesignLabView />}
      {route.domain === 'settings' && <SettingsView />}
    </>
  );
}
