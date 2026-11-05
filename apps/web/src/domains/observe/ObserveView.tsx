/**
 * Observe 容器：页面头、tab 导航与路由级滚动容器；面板在各自模块。
 *
 * S2：从原单文件拆出 MetricsPanel / EvalsPanel / EvalReportView；
 * tab 切换时的 scrollTop 重置保留在本容器。
 */

import { PageScaffold, TableToolbar } from '@vessel-agent/plugin-ui';
import { useRef } from 'react';
import type { Route } from '../../app/router';
import { SegmentedTabs } from '../../components/Tabs';
import { t, useLocale } from '../../i18n';
import { AttentionPanel } from './AttentionPanel';
import { DiagnosticsView } from './DiagnosticsView';
import { EvalsPanel } from './EvalsPanel';
import { MetricsPanel } from './MetricsPanel';

type ObserveRoute = Extract<Route, { domain: 'observe' }>;
type Tab = ObserveRoute['tab'];

function observeTabs(): readonly { id: Tab; label: string }[] {
  return [
    { id: 'metrics', label: t('observe.tab.metrics') },
    { id: 'evals', label: t('observe.tab.evals') },
    { id: 'diagnostics', label: t('observe.tab.diagnostics') },
    { id: 'attention', label: t('observe.tab.attention') },
  ];
}

export function ObserveView({
  route,
  navigate,
}: {
  route: ObserveRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  // 本页是 Observe 唯一的滚动容器（`main` 是 `overflow-hidden`，路由变化的
  // `window.scrollTo` 重置不到它）。切 tab 时重置 scrollTop，避免沿用上一页的位置。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: ObserveRoute['tab']) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'observe', tab });
  };
  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain"
    >
      <PageScaffold title={t('observe.title')} subtitle={t('observe.description')}>
        <TableToolbar label={t('observe.tabsLabel')}>
          <SegmentedTabs
            label={t('observe.tabsLabel')}
            tabs={observeTabs()}
            value={route.tab}
            onChange={changeTab}
            panelId="observe-panel"
          />
        </TableToolbar>
        <div
          className="flex flex-col gap-4"
          id="observe-panel"
          role="tabpanel"
          aria-label={t('observe.panelLabel')}
        >
          {route.tab === 'metrics' && <MetricsPanel />}
          {route.tab === 'evals' && <EvalsPanel />}
          {route.tab === 'diagnostics' && <DiagnosticsView />}
          {route.tab === 'attention' && <AttentionPanel navigate={navigate} />}
        </div>
      </PageScaffold>
    </div>
  );
}
