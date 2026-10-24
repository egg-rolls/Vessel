import { settingsTabLabel } from '../../app/nav';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedTabs, type TabOption } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { AppearanceView } from './AppearanceView';
import { CapabilitiesView } from './CapabilitiesView';
import { ConfigView } from './ConfigView';
import { ConnectionForm } from './ConnectionForm';
import { DisplaySettingsView } from './DisplaySettingsView';
import { TenantsView } from './TenantsView';

type SettingsRoute = Extract<Route, { domain: 'settings' }>;
type SettingsTab = SettingsRoute['tab'];

const TAB_IDS: readonly SettingsTab[] = [
  'connection',
  'config',
  'capabilities',
  'tenants',
  'appearance',
  'display',
];

export function SettingsView({
  route,
  navigate,
}: {
  route: SettingsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { tenantId } = useConnection();
  const tabs: readonly TabOption<SettingsTab>[] = TAB_IDS.map((id) => ({
    id,
    label: settingsTabLabel(id),
  }));

  return (
    <div className="domain-view">
      <PageHeader
        title={t('settings.title')}
        description={t('settings.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('settings.tabsLabel')}
        tabs={tabs}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'settings', tab })}
        panelId="settings-panel"
      />
      <div
        className="domain-content"
        id="settings-panel"
        role="tabpanel"
        aria-label={t('settings.panelLabel')}
      >
        {route.tab === 'connection' && <ConnectionForm />}
        {route.tab === 'config' && <ConfigView />}
        {route.tab === 'capabilities' && <CapabilitiesView />}
        {route.tab === 'tenants' && <TenantsView />}
        {route.tab === 'appearance' && <AppearanceView />}
        {route.tab === 'display' && <DisplaySettingsView />}
      </div>
    </div>
  );
}
