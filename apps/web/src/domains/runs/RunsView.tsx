/**
 * Runs 容器：列表页与运行详情页两条互斥的整页分支。
 *
 * 详情是独立子页面（#/runs/<runId>），不再作为列表行下方的内联面板 ——
 * 内联面板会把列表页整体拉高，日志一多就没法在同一屏里比对。
 *
 * S3：数据/副作用在 useRunsPage；过滤栏与表格拆到 RunsFilters / RunsTable。
 */

import { PageScaffold } from '@vessel-agent/plugin-ui';
import { useRef } from 'react';
import type { Route } from '../../app/router';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { Button } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { RunDetailPage } from './RunDetailPage';
import { RunsFilters } from './RunsFilters';
import { RunsTable } from './RunsTable';
import { useRunsPage } from './useRunsPage';

type RunsRoute = Extract<Route, { domain: 'runs' }>;

/** 两个分支共用的路由级滚动容器：切页时重置 scrollTop，不沿用上一页的位置。 */
const SCROLL_CLASS =
  'flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain';

export function RunsView({
  route,
  navigate,
}: {
  route: RunsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const {
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
    sessionNames,
    agentNames,
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const changeTab = (tab: RunsRoute['tab']) => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({ domain: 'runs', tab });
  };
  // 详情页的返回固定落回同 tab 的运行列表（带上来时的会话过滤），不读 history。
  const backToList = () => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    navigate({
      domain: 'runs',
      tab: route.tab,
      ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    });
  };

  const runId = route.runId;
  if (runId) {
    return (
      <div ref={scrollRef} className={SCROLL_CLASS}>
        <RunDetailPage
          runId={runId}
          tab={route.tab}
          run={detailRun}
          durable={knownDurable ?? null}
          active={activeDetail}
          canWrite={connected}
          connected={connected}
          loading={detailLoading}
          missing={detailMissing}
          detailError={detailResource.state.status === 'error' ? detailResource.state.error : null}
          busy={busy.has(runId)}
          onBack={backToList}
          onCancel={cancel}
          onResume={resume}
          onRetry={detailResource.reload}
        />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={SCROLL_CLASS}>
      <PageScaffold title={t('runs.title')} subtitle={t('runs.subtitle')}>
        <RunsFilters
          query={query}
          onQueryChange={setQuery}
          tab={route.tab}
          onTabChange={changeTab}
        />

        <div
          className="flex flex-col gap-4"
          id="runs-panel"
          role="tabpanel"
          aria-label={t('runs.title')}
        >
          {!hasToken ? (
            <EmptyState
              title={t('runs.noTokenTitle')}
              action={
                <Button onClick={() => navigate({ domain: 'gateway' })}>
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
                  status={status}
                  onStatusChange={setStatus}
                  filterList={filterList}
                  agentId={agentId}
                  onAgentIdChange={setAgentId}
                  agentOptions={agentOptions}
                  sessionNames={sessionNames}
                  agentNames={agentNames}
                  onCancel={cancel}
                  onResume={resume}
                  onOpenRun={(id, sessionId) => navigateRoute({ runId: id, sessionId })}
                  onOpenSession={(sessionId) => navigate({ domain: 'chat', sessionId })}
                  onSelectAgent={setAgentId}
                  onShowMore={() => setLimit((value) => value + 100)}
                />
              )}
            </>
          )}
        </div>
      </PageScaffold>
    </div>
  );
}
