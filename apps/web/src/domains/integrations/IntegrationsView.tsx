/**
 * Integrations 容器：页面头、tab 导航与路由级滚动容器；面板在各自模块。
 *
 * S2：从原单文件拆出 ToolsPanel / McpPanel / ChannelsPanel；
 * `mcpServerOf` 仍从此路径导出，tab 切换的 scrollTop 重置保留在本容器。
 */

import { useRef } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedTabs } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { ChannelsPanel } from './ChannelsPanel';
import { McpPanel } from './McpPanel';
import { ToolsPanel } from './ToolsPanel';

export { mcpServerOf } from './mcp-server';

type IntegrationsRoute = Extract<Route, { domain: 'integrations' }>;
type Tab = IntegrationsRoute['tab'];

const TABS: readonly { id: Tab; labelKey: string }[] = [
  { id: 'tools', labelKey: 'integrations.tab.tools' },
  { id: 'mcp', labelKey: 'integrations.tab.mcp' },
  { id: 'channels', labelKey: 'integrations.tab.channels' },
];

export function IntegrationsView({
  route,
  navigate,
}: {
  route: IntegrationsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { tenantId } = useConnection();

  // 本页是路由级滚动容器；切 tab 时重置 scrollTop，避免沿用上一页的位置。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: Tab) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'integrations', tab });
  };

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]"
    >
      <PageHeader
        title={t('integrations.title')}
        description={t('integrations.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('integrations.tabsLabel')}
        tabs={TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }))}
        value={route.tab}
        onChange={changeTab}
        panelId="integrations-panel"
      />
      <div
        className="mt-5 flex flex-col gap-4"
        id="integrations-panel"
        role="tabpanel"
        aria-label={t('integrations.panelLabel')}
      >
        {route.tab === 'tools' && <ToolsPanel />}
        {route.tab === 'mcp' && <McpPanel />}
        {route.tab === 'channels' && <ChannelsPanel />}
      </div>
    </div>
  );
}
