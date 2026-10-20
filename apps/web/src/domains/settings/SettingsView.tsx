import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedTabs, type TabOption } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
import { AppearanceView } from './AppearanceView';
import { CapabilitiesView } from './CapabilitiesView';
import { ConfigView } from './ConfigView';
import { ConnectionForm } from './ConnectionForm';
import { NodesPanel } from './NodesPanel';
import { TenantsView } from './TenantsView';

type SettingsRoute = Extract<Route, { domain: 'settings' }>;
type SettingsTab = SettingsRoute['tab'];

const TABS: readonly TabOption<SettingsTab>[] = [
  { id: 'connection', label: '连接' },
  { id: 'nodes', label: '节点' },
  { id: 'config', label: '配置' },
  { id: 'capabilities', label: '能力清单' },
  { id: 'tenants', label: '租户' },
  { id: 'appearance', label: '外观' },
];

export function SettingsView({
  route,
  navigate,
}: {
  route: SettingsRoute;
  navigate: (route: Route) => void;
}) {
  const { tenantId } = useConnection();

  return (
    <div className="domain-view">
      <PageHeader
        title="设置"
        description="连接、节点、配置、能力与租户。连接表单只在这里出现。"
        tenantId={tenantId}
      />
      <SegmentedTabs
        label="设置分区"
        tabs={TABS}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'settings', tab })}
        panelId="settings-panel"
      />
      <div className="domain-content" id="settings-panel" role="tabpanel" aria-label="设置内容">
        {route.tab === 'connection' && <ConnectionForm />}
        {route.tab === 'nodes' && <NodesPanel />}
        {route.tab === 'config' && <ConfigView />}
        {route.tab === 'capabilities' && <CapabilitiesView />}
        {route.tab === 'tenants' && <TenantsView />}
        {route.tab === 'appearance' && <AppearanceView />}
      </div>
    </div>
  );
}
