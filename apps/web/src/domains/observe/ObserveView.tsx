import { useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { SegmentedTabs } from '../../components/Tabs';
import { useToast } from '../../components/ToastProvider';
import { Badge, Button, DataTable, Input, Section, Stat } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { EvalCaseResult, EvalReport } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AttentionPanel } from './AttentionPanel';
import { cacheStatTexts } from './cache-metrics';
import { DiagnosticsView } from './DiagnosticsView';
import { TasksView } from './TasksView';

type ObserveRoute = Extract<Route, { domain: 'observe' }>;
type Tab = ObserveRoute['tab'];

function observeTabs(): readonly { id: Tab; label: string }[] {
  return [
    { id: 'metrics', label: t('observe.tab.metrics') },
    { id: 'evals', label: t('observe.tab.evals') },
    { id: 'diagnostics', label: t('observe.tab.diagnostics') },
    { id: 'tasks', label: t('observe.tab.tasks') },
    { id: 'attention', label: t('observe.tab.attention') },
  ];
}

const EVAL_SUITES_KEY = 'vessel.eval-suites';
const EVAL_CASE_PAGE = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = errorMessage(error);
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
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
        {route.tab === 'tasks' && <TasksView />}
        {route.tab === 'attention' && <AttentionPanel navigate={navigate} />}
      </div>
    </div>
  );
}

function MetricsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('metrics');
  const [source, setSource] = useState<'live' | 'trace'>('live');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const resource = useResource({
    load: () => client.getMetricsSnapshot(source),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch, source],
  });
  const data = resourceData(resource.state);
  const metrics = data?.metrics;
  useRefreshSignal(resource.reload);

  // CONTRACT-0.29 §2.2：比率是展示层派生量，不进 wire。
  const cache = useMemo(() => (metrics ? cacheStatTexts(metrics.llm) : undefined), [metrics]);
  // 全部事件都没有缓存数据 → 「不可用」，绝不渲染 0%。
  // 单侧缺失时该侧画 `—`（`cacheStatTexts` 已处理），不在这里兜底成 0。
  const cacheHint = cache?.available
    ? t('observe.metrics.stat.cacheHint', {
        read: cache.cacheReadText,
        write: cache.cacheCreationText,
        prompt: cache.promptTokensText,
      })
    : t('observe.metrics.stat.cacheUnavailableHint');

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('observe.metrics.noTokenReason')}
      />
    );
  }
  if (!features.includes('metrics')) {
    return (
      <NotEnabledState
        title={t('observe.metrics.disabledTitle')}
        reason={t('observe.metrics.disabledReason')}
        hint={t('observe.metrics.disabledHint')}
      />
    );
  }
  if (source === 'trace' && resource.state.status === 'error') {
    return (
      <NotEnabledState
        title={t('observe.metrics.traceDisabledTitle')}
        reason={resource.state.error}
        hint={t('observe.metrics.traceDisabledHint')}
        action={
          <Button onClick={() => setSource('live')}>{t('observe.metrics.switchLive')}</Button>
        }
      />
    );
  }

  const reset = async () => {
    if (!connected) {
      toast.error(t('observe.metrics.resetDisconnected'));
      return;
    }
    setResetting(true);
    try {
      await client.resetMetrics();
      toast.success(t('observe.metrics.resetSuccess'));
      resource.reload();
    } catch (error) {
      toast.error(isForbidden(error) ? t('observe.metrics.resetForbidden') : errorMessage(error));
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <SegmentedTabs
          label={t('observe.metrics.sourceLabel')}
          tabs={[
            { id: 'live', label: t('observe.metrics.source.live') },
            { id: 'trace', label: t('observe.metrics.source.trace') },
          ]}
          value={source}
          onChange={setSource}
          panelId="metrics-source-panel"
        />
        <Button size="small" onClick={resource.reload}>
          {t('observe.metrics.refresh')}
        </Button>
        <Button
          size="small"
          variant="dangerGhost"
          onClick={() => setConfirmReset(true)}
          disabled={!connected || !metrics}
          title={!connected ? t('common.writesDisabled') : undefined}
        >
          {t('observe.metrics.reset')}
        </Button>
      </div>

      <div id="metrics-source-panel" role="tabpanel" aria-label={t('observe.metrics.panelLabel')}>
        {!connected && metrics && (
          <StaleNotice message={t('observe.metrics.stale')} onRetry={resource.reload} />
        )}
        {error && metrics && (
          <StaleNotice
            message={t('common.staleData', { detail: error })}
            onRetry={resource.reload}
          />
        )}
        {!metrics ? (
          error ? (
            <ErrorState message={error} onRetry={resource.reload} />
          ) : (
            <LoadingState label={t('observe.metrics.loading')} />
          )
        ) : (
          <>
            <div className="my-3 flex flex-wrap gap-2.5">
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.started}
                label={t('observe.metrics.stat.runsStarted')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.completed}
                label={t('observe.metrics.stat.completed')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.failed}
                label={t('observe.metrics.stat.failed')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.cancelled}
                label={t('observe.metrics.stat.cancelled')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.tool_calls.total}
                label={t('observe.metrics.stat.toolCalls', { failed: metrics.tool_calls.failed })}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.llm.total_tokens}
                label={t('observe.metrics.stat.tokens', {
                  prompt: metrics.llm.prompt_tokens,
                  completion: metrics.llm.completion_tokens,
                })}
              />
              <Stat
                className="min-w-40 flex-1"
                value={cache?.inputShareText ?? t('observe.metrics.stat.cacheUnavailable')}
                label={t('observe.metrics.stat.cacheInputShare')}
                hint={cacheHint}
              />
              <Stat
                className="min-w-40 flex-1"
                value={cache?.prefixHealthText ?? t('observe.metrics.stat.cacheUnavailable')}
                label={t('observe.metrics.stat.cachePrefixHealth')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={`${Math.round(metrics.duration_ms.avg)}ms`}
                label={t('observe.metrics.stat.avgDuration', {
                  max: Math.round(metrics.duration_ms.max),
                })}
              />
              <Stat
                className="min-w-40 flex-1"
                value={formatTimestamp(metrics.updated_at)}
                label={t('observe.metrics.stat.updatedAt')}
              />
            </div>
            <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
              {t('observe.metrics.sourceDesc', {
                source:
                  data?.source === 'trace'
                    ? t('observe.metrics.source.trace')
                    : t('observe.metrics.source.live'),
              })}
            </p>
          </>
        )}
      </div>

      {confirmReset && (
        <ConfirmDialog
          title={t('observe.metrics.resetTitle')}
          body={
            <>
              <p>{t('observe.metrics.resetBody')}</p>
              <p className="text-muted">{t('observe.metrics.resetBodyHint')}</p>
            </>
          }
          confirmLabel={t('observe.metrics.resetConfirm')}
          danger
          busy={resetting}
          confirmDisabled={!connected}
          onConfirm={() => void reset()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}

function readSuites(): string[] {
  try {
    const raw = localStorage.getItem(EVAL_SUITES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function EvalsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('evals');
  const [suite, setSuite] = useState('smoke');
  const [requested, setRequested] = useState(0);
  const [runReport, setRunReport] = useState<EvalReport | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [suites, setSuites] = useState<string[]>(readSuites);
  const [caseLimit, setCaseLimit] = useState(EVAL_CASE_PAGE);
  const [caseFilter, setCaseFilter] = useState<'all' | 'failed'>('all');

  const latest = useResource({
    load: () => client.getLatestEval(suite),
    enabled: available && requested > 0,
    deps: [epoch, suite, requested],
  });
  useRefreshSignal(latest.reload);
  // suite 切换后旧响应仍可能留在 resource 里：只接受当前 suite 的报告。
  const latestData = resourceData(latest.state);
  const latestReport = latestData && latestData.suite === suite ? latestData : undefined;
  const report = runReport ?? latestReport ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: suite 变化时清空上一次报告
  useEffect(() => {
    setRunReport(null);
    setRunError(null);
    setCaseLimit(EVAL_CASE_PAGE);
    setCaseFilter('all');
  }, [suite, requested]);

  const rememberSuite = (value: string) => {
    const next = [value, ...suites.filter((item) => item !== value)].slice(0, 8);
    setSuites(next);
    try {
      localStorage.setItem(EVAL_SUITES_KEY, JSON.stringify(next));
    } catch {
      // 最近使用存不下不影响评测。
    }
  };

  if (!hasToken) {
    return (
      <NotEnabledState title={t('common.notConnected')} reason={t('observe.evals.noTokenReason')} />
    );
  }
  if (!features.includes('evals')) {
    return (
      <NotEnabledState
        title={t('observe.evals.disabledTitle')}
        reason={t('observe.evals.disabledReason')}
        hint={t('observe.evals.disabledHint')}
      />
    );
  }

  const loadLatest = () => {
    setRunReport(null);
    setRunError(null);
    rememberSuite(suite);
    setRequested((value) => value + 1);
  };

  const run = async () => {
    if (!connected) {
      toast.error(t('observe.evals.disconnectedRun'));
      return;
    }
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await client.runEval(suite);
      setRunReport(result);
      rememberSuite(suite);
      toast.success(t('observe.evals.completed', { suite: result.suite }));
    } catch (error) {
      setRunError(errorMessage(error));
    } finally {
      setRunBusy(false);
    }
  };

  const notFound =
    latest.state.status === 'error' &&
    (latest.state.error.includes('not_found') ||
      latest.state.error.includes('eval_not_found') ||
      latest.state.error.includes('Eval report not found'));
  const latestError = latest.state.status === 'error' ? latest.state.error : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.evals.intro')}
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Input
          className="grow basis-60 max-w-search"
          value={suite}
          onChange={(event) => setSuite(event.target.value)}
          placeholder={t('observe.evals.suitePlaceholder')}
          aria-label={t('observe.evals.suiteLabel')}
          list="eval-suites"
          spellCheck={false}
        />
        <datalist id="eval-suites">
          {suites.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <Button
          size="small"
          onClick={loadLatest}
          disabled={!suite.trim() || latest.state.status === 'loading'}
        >
          {t('observe.evals.loadLatest')}
        </Button>
        <Button
          size="small"
          variant="primary"
          onClick={() => void run()}
          disabled={!connected || !suite.trim() || runBusy}
          title={!connected ? t('common.writesDisabled') : undefined}
        >
          {runBusy ? t('observe.evals.running') : t('observe.evals.run')}
        </Button>
      </div>
      {suites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">{t('observe.evals.recent')}</span>
          {suites.map((item) => (
            <Button
              key={item}
              variant="chip"
              size="small"
              aria-pressed={item === suite}
              onClick={() => setSuite(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      )}

      {runError && (
        <ErrorState
          message={runError}
          onRetry={() => void run()}
          retryLabel={t('observe.evals.retry')}
        />
      )}
      {!connected && report && <StaleNotice message={t('observe.evals.disconnectedReport')} />}
      {!runReport && notFound && (
        <NotEnabledState
          title={t('observe.evals.notFoundTitle')}
          reason={latestError ?? undefined}
          hint={t('observe.evals.notFoundHint')}
        />
      )}
      {!runReport && !notFound && latestError && (
        <ErrorState message={latestError} onRetry={latest.reload} />
      )}
      {!report && !runError && !notFound ? (
        latest.state.status === 'loading' ? (
          <LoadingState label={t('observe.evals.loadingReport')} />
        ) : (
          <EmptyState
            title={t('observe.evals.emptyTitle')}
            description={t('observe.evals.emptyDesc')}
          />
        )
      ) : report ? (
        <EvalReportView
          report={report}
          caseLimit={caseLimit}
          caseFilter={caseFilter}
          onCaseFilter={setCaseFilter}
          onShowMore={() => setCaseLimit((value) => value + EVAL_CASE_PAGE)}
        />
      ) : null}
    </div>
  );
}

function EvalReportView({
  report,
  caseLimit,
  caseFilter,
  onCaseFilter,
  onShowMore,
}: {
  report: EvalReport;
  caseLimit: number;
  caseFilter: 'all' | 'failed';
  onCaseFilter: (value: 'all' | 'failed') => void;
  onShowMore: () => void;
}) {
  const filteredCases = useMemo(
    () =>
      caseFilter === 'failed'
        ? report.cases.filter((item) => item.status === 'failed' || item.status === 'error')
        : report.cases,
    [report.cases, caseFilter],
  );
  const cases = filteredCases.slice(0, caseLimit);

  return (
    <>
      <div className="my-3 flex flex-wrap gap-2.5">
        <Stat
          className="min-w-40 flex-1"
          value={report.total}
          label={t('observe.evals.stat.total')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.passed}
          label={t('observe.evals.stat.passed')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.failed}
          label={t('observe.evals.stat.failed')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.errors}
          label={t('observe.evals.stat.errors')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.skipped}
          label={t('observe.evals.stat.skipped')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={`${report.duration_ms}ms`}
          label={t('observe.evals.stat.duration')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.network ? 'on' : 'off'}
          label={t('observe.evals.stat.network')}
        />
      </div>
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.evals.generatedAt', {
          time: formatTimestamp(report.finished_at),
          network: report.network ? t('observe.evals.networkOn') : t('observe.evals.offline'),
        })}
      </p>

      <Section
        title={t('observe.evals.casesTitle')}
        actions={
          <>
            <Button
              variant="chip"
              size="small"
              aria-pressed={caseFilter === 'failed'}
              onClick={() => onCaseFilter(caseFilter === 'failed' ? 'all' : 'failed')}
            >
              {t('observe.evals.failedOnly')}
            </Button>
            <Badge>
              {filteredCases.length}/{report.cases.length}
            </Badge>
          </>
        }
      >
        {filteredCases.length === 0 ? (
          <EmptyState
            title={t(
              caseFilter === 'failed' ? 'observe.evals.emptyFailed' : 'observe.evals.emptyCases',
            )}
          />
        ) : (
          <DataTable<EvalCaseResult>
            columns={[
              {
                key: 'status',
                header: t('observe.evals.col.status'),
                cell: (item) => <StatusChip status={item.status} />,
              },
              {
                key: 'case',
                header: t('observe.evals.col.case'),
                cellClassName: 'font-mono',
                cell: (item) => item.id,
              },
              {
                key: 'duration',
                header: t('observe.evals.col.duration'),
                hide: 'wide',
                cellClassName: 'font-mono tabular-nums',
                cell: (item) => `${item.duration_ms}ms`,
              },
              {
                key: 'assertions',
                header: t('observe.evals.col.assertions'),
                hide: 'wide',
                cellClassName: 'font-mono tabular-nums',
                cell: (item) =>
                  `${item.assertions.filter((assertion) => assertion.ok).length}/${item.assertions.length}`,
              },
              {
                key: 'output',
                header: t('observe.evals.col.output'),
                cell: (item) => (
                  <>
                    {item.error ? (
                      <span className="text-danger">{item.error}</span>
                    ) : (
                      <span className="text-muted">{item.output ?? '—'}</span>
                    )}
                    {item.assertions.length > 0 && (
                      <details className="mt-1" open={item.status === 'failed'}>
                        <summary className="cursor-pointer font-mono text-xs text-muted">
                          {t('observe.evals.assertions')}
                        </summary>
                        <ul className="plain-list">
                          {item.assertions.map((assertion, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 断言顺序稳定
                            <li key={`${assertion.type}-${index}`}>
                              <span className={assertion.ok ? 'text-success' : 'text-danger'}>
                                {assertion.ok ? '✓' : '✗'} {assertion.type}
                              </span>
                              {assertion.detail && (
                                <span className="text-muted"> — {assertion.detail}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ),
              },
            ]}
            rows={cases}
            rowKey={(item) => item.id}
          />
        )}
        {cases.length < filteredCases.length && (
          <Button
            variant="plain"
            className="mx-auto mt-2 rounded-full px-3.5 py-2 text-xs text-muted"
            onClick={onShowMore}
          >
            {t('observe.evals.showMore', { count: filteredCases.length - cases.length })}
          </Button>
        )}
      </Section>
    </>
  );
}
