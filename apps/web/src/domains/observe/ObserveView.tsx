/**
 * Observe 容器：页面头、tab 导航与路由级滚动容器；面板在各自模块。
 *
 * S2：从原单文件拆出 MetricsPanel / EvalsPanel / EvalReportView；
 * tab 切换时的 scrollTop 重置保留在本容器。
 */

import { useRef } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedTabs } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
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
  const { tenantId } = useConnection();
  // 本页是 Observe 唯一的滚动容器（`main` 是 `overflow-hidden`，路由变化的
  // `window.scrollTo` 重置不到它）。切 tab 时若沿用上一页的 scrollTop，长内容
  // （如诊断表格）的 sticky 表头会立刻钉在视口上沿，看起来像压住了 tab 栏。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: ObserveRoute['tab']) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'observe', tab });
  };
  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]"
    >
      <PageHeader
        title={t('observe.title')}
        description={t('observe.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('observe.tabsLabel')}
        tabs={observeTabs()}
        value={route.tab}
        onChange={changeTab}
        panelId="observe-panel"
      />
      <div
        className="mt-5 flex flex-col gap-4"
        id="observe-panel"
        role="tabpanel"
        aria-label={t('observe.panelLabel')}
      >
        {route.tab === 'metrics' && <MetricsPanel />}
        {route.tab === 'evals' && <EvalsPanel />}
        {route.tab === 'diagnostics' && <DiagnosticsView />}
        {route.tab === 'attention' && <AttentionPanel navigate={navigate} />}
      </div>
    </div>
  );
}
