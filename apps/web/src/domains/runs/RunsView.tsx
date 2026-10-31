/**
 * Runs 容器：页面头、live/durable tab、路由级滚动容器、列表状态与详情面板。
 *
 * S3：数据/副作用在 useRunsPage；过滤栏与表格拆到 RunsFilters / RunsTable。
 */

import { useRef } from 'react';
import type { Route } from '../../app/router';
import { PageHeader } from '../../components/PageHeader';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Button, cn } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { RunDetail } from './RunDetail';
import { RunsFilters } from './RunsFilters';
import { RunsTable } from './RunsTable';
import { useRunsPage } from './useRunsPage';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

export function RunsView({
  route,
  navigate,
}: {
  route: RunsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const {
    tenantId,
    hasToken,
    connected,
    durableAvailable,
    query,
    setQuery,
    status,
    setStatus,
    setLimit,
    agentId,
    setAgentId,
    busy,
    filterList,
    current,
    filtered,
    windowed,
    reloadResource,
    resourceError,
    loading,
    agentOptions,
    reloadAll,
    detailResource,
    detailRun,
    knownDurable,
    detailMissing,
    detailLoading,
    activeDetail,
    cancel,
    resume,
  } = useRunsPage(route, navigate);

  const navigateRoute = (patch: Partial<RunsRoute>) => {
    navigate({ ...route, ...patch });
  };

  // 本页是路由级滚动容器；切 tab 时重置 scrollTop，避免沿用上一页的位置。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: RunsRoute['tab']) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'runs', tab });
  };

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]"
    >
      <PageHeader title={t('runs.title')} description={t('runs.description')} tenantId={tenantId} />
      <SegmentedTabs
        label={t('runs.sourceLabel')}
        tabs={[
          { id: 'live', label: t('runs.source.live') },
          { id: 'durable', label: t('runs.source.durable') },
        ]}
        value={route.tab}
        onChange={changeTab}
        panelId="runs-panel"
      />

      <RunsFilters
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        filterList={filterList}
        agentId={agentId}
        onAgentIdChange={setAgentId}
        agentOptions={agentOptions}
        sessionId={route.sessionId}
        onClearSession={() => navigateRoute({ sessionId: undefined, runId: undefined })}
        onClearAgent={() => setAgentId('')}
        onRefresh={reloadAll}
        hasToken={hasToken}
        hidden={Boolean(route.runId)}
      />

      <div
        className="mt-5 flex flex-col gap-4"
        id="runs-panel"
        role="tabpanel"
        aria-label={t('runs.title')}
      >
        <div className={cn('flex flex-col gap-4', route.runId && 'max-wide:hidden')}>
          {!hasToken ? (
            <EmptyState
              title={t('runs.noTokenTitle')}
              action={
                <Button onClick={() => navigate({ domain: 'settings', tab: 'connection' })}>
                  {t('common.configureConnection')}
                </Button>
              }
            />
          ) : route.tab === 'durable' && !durableAvailable ? (
            <NotEnabledState
              title={t('runs.durableDisabledTitle')}
              reason={t('runs.durableDisabledReason')}
              hint={t('runs.durableDisabledHint')}
            />
          ) : (
            <>
              {!connected && current.length > 0 && (
                <StaleNotice message={t('runs.disconnected')} onRetry={reloadAll} />
              )}
              {resourceError && current.length > 0 && (
                <StaleNotice
                  message={t('common.staleData', { detail: resourceError })}
                  onRetry={reloadAll}
                />
              )}

              {resourceError && current.length === 0 ? (
                <ErrorState message={resourceError} onRetry={reloadResource} />
              ) : loading ? (
                <LoadingState label={t('runs.loading')} />
              ) : current.length === 0 ? (
                <EmptyState
                  title={t(route.tab === 'live' ? 'runs.emptyLiveTitle' : 'runs.emptyDurableTitle')}
                  description={t(
                    route.tab === 'live' ? 'runs.emptyLiveDesc' : 'runs.emptyDurableDesc',
                  )}
                  action={
                    route.tab === 'live' ? (
                      <Button
                        variant="primary"
                        onClick={() => navigate({ domain: 'chat', sessionId: 'new' })}
                      >
                        {t('common.newSession')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : filtered.length === 0 ? (
                <EmptyState
                  title={t('runs.noMatchTitle')}
                  description={t('runs.noMatchDesc')}
                  action={
                    <Button
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                        setAgentId('');
                        navigateRoute({ sessionId: undefined });
                      }}
                    >
                      {t('common.clearFilters')}
                    </Button>
                  }
                />
              ) : (
                <RunsTable
                  tab={route.tab}
                  windowed={windowed}
                  connected={connected}
                  busy={busy}
                  activeKey={route.runId}
                  onCancel={cancel}
                  onResume={resume}
                  onOpenRun={(runId, sessionId) => navigateRoute({ runId, sessionId: sessionId })}
                  onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
                  onSelectAgent={setAgentId}
                  onShowMore={() => setLimit((value) => value + 100)}
                />
              )}
            </>
          )}
        </div>

        {route.runId &&
          (detailMissing ? (
            <div className="max-wide:hidden">
              <ErrorState
                message={
                  detailResource.state.status === 'error'
                    ? detailResource.state.error
                    : t('runs.notFound')
                }
                onRetry={detailResource.reload}
              />
            </div>
          ) : detailLoading ? (
            <div className="max-wide:hidden">
              <LoadingState label={t('runs.detailLoading')} />
            </div>
          ) : detailRun || knownDurable ? (
            <RunDetail
              runId={route.runId}
              tab={route.tab}
              run={detailRun}
              durable={knownDurable ?? null}
              active={activeDetail}
              canWrite={connected}
              onCancel={cancel}
              onResume={resume}
              onClose={() => navigateRoute({ runId: undefined })}
              busy={busy.has(route.runId)}
            />
          ) : null)}
      </div>
    </div>
  );
}
