import { useRef } from 'react';
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

  // 本页是路由级滚动容器；切 tab 时重置 scrollTop，避免沿用上一页的位置。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: SettingsTab) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'settings', tab });
  };

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]"
    >
      <PageHeader
        title={t('settings.title')}
        description={t('settings.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('settings.tabsLabel')}
        tabs={tabs}
        value={route.tab}
        onChange={changeTab}
        panelId="settings-panel"
      />
      <div
        className="mt-5 flex flex-col gap-4"
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
