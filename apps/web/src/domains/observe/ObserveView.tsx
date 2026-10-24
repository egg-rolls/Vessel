import { useEffect, useMemo, useState } from 'react';
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
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { EvalReport } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AttentionPanel } from './AttentionPanel';
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
  return (
    <div className="domain-view">
      <PageHeader
        title={t('observe.title')}
        description={t('observe.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('observe.tabsLabel')}
        tabs={observeTabs()}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'observe', tab })}
        panelId="observe-panel"
      />
      <div
        className="domain-content"
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
          <button type="button" className="btn" onClick={() => setSource('live')}>
            {t('observe.metrics.switchLive')}
          </button>
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
    <div className="settings-section">
      <div className="filter-bar">
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
        <button type="button" className="btn btn-small" onClick={resource.reload}>
          {t('observe.metrics.refresh')}
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger-ghost"
          onClick={() => setConfirmReset(true)}
          disabled={!connected || !metrics}
          title={!connected ? t('common.writesDisabled') : undefined}
        >
          {t('observe.metrics.reset')}
        </button>
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
            <div className="stats-grid">
              <div className="stat">
                <span className="stat-value">{metrics.runs.started}</span>
                <span className="stat-label">{t('observe.metrics.stat.runsStarted')}</span>
              </div>
              <div className="stat">
                <span className="stat-value">{metrics.runs.completed}</span>
                <span className="stat-label">{t('observe.metrics.stat.completed')}</span>
              </div>
              <div className="stat">
                <span className="stat-value">{metrics.runs.failed}</span>
                <span className="stat-label">{t('observe.metrics.stat.failed')}</span>
              </div>
              <div className="stat">
                <span className="stat-value">{metrics.runs.cancelled}</span>
                <span className="stat-label">{t('observe.metrics.stat.cancelled')}</span>
              </div>
              <div className="stat">
                <span className="stat-value">{metrics.tool_calls.total}</span>
                <span className="stat-label">
                  {t('observe.metrics.stat.toolCalls', { failed: metrics.tool_calls.failed })}
                </span>
              </div>
              <div className="stat">
                <span className="stat-value">{metrics.llm.total_tokens}</span>
                <span className="stat-label">
                  {t('observe.metrics.stat.tokens', {
                    prompt: metrics.llm.prompt_tokens,
                    completion: metrics.llm.completion_tokens,
                  })}
                </span>
              </div>
              <div className="stat">
                <span className="stat-value">{Math.round(metrics.duration_ms.avg)}ms</span>
                <span className="stat-label">
                  {t('observe.metrics.stat.avgDuration', {
                    max: Math.round(metrics.duration_ms.max),
                  })}
                </span>
              </div>
              <div className="stat">
                <span className="stat-value">{formatTimestamp(metrics.updated_at)}</span>
                <span className="stat-label">{t('observe.metrics.stat.updatedAt')}</span>
              </div>
            </div>
            <p className="section-desc">
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
              <p className="dim">{t('observe.metrics.resetBodyHint')}</p>
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
    <div className="settings-section">
      <p className="section-desc">{t('observe.evals.intro')}</p>
      <div className="filter-bar">
        <input
          className="input"
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
        <button
          type="button"
          className="btn btn-small"
          onClick={loadLatest}
          disabled={!suite.trim() || latest.state.status === 'loading'}
        >
          {t('observe.evals.loadLatest')}
        </button>
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => void run()}
          disabled={!connected || !suite.trim() || runBusy}
          title={!connected ? t('common.writesDisabled') : undefined}
        >
          {runBusy ? t('observe.evals.running') : t('observe.evals.run')}
        </button>
      </div>
      {suites.length > 0 && (
        <div className="chip-row">
          <span className="dim">{t('observe.evals.recent')}</span>
          {suites.map((item) => (
            <button
              key={item}
              type="button"
              className={`filter-chip ${item === suite ? 'active' : ''}`.trim()}
              aria-pressed={item === suite}
              onClick={() => setSuite(item)}
            >
              {item}
            </button>
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
      <div className="stats-grid">
        <div className="stat">
          <span className="stat-value">{report.total}</span>
          <span className="stat-label">{t('observe.evals.stat.total')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.passed}</span>
          <span className="stat-label">{t('observe.evals.stat.passed')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.failed}</span>
          <span className="stat-label">{t('observe.evals.stat.failed')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.errors}</span>
          <span className="stat-label">{t('observe.evals.stat.errors')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.skipped}</span>
          <span className="stat-label">{t('observe.evals.stat.skipped')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.duration_ms}ms</span>
          <span className="stat-label">{t('observe.evals.stat.duration')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.network ? 'on' : 'off'}</span>
          <span className="stat-label">{t('observe.evals.stat.network')}</span>
        </div>
      </div>
      <p className="section-desc">
        {t('observe.evals.generatedAt', {
          time: formatTimestamp(report.finished_at),
          network: report.network ? t('observe.evals.networkOn') : t('observe.evals.offline'),
        })}
      </p>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('observe.evals.casesTitle')}</h2>
          <button
            type="button"
            className={`filter-chip ${caseFilter === 'failed' ? 'active' : ''}`.trim()}
            aria-pressed={caseFilter === 'failed'}
            onClick={() => onCaseFilter(caseFilter === 'failed' ? 'all' : 'failed')}
          >
            {t('observe.evals.failedOnly')}
          </button>
          <span className="count-pill">
            {filteredCases.length}/{report.cases.length}
          </span>
        </div>
        {filteredCases.length === 0 ? (
          <EmptyState
            title={t(
              caseFilter === 'failed' ? 'observe.evals.emptyFailed' : 'observe.evals.emptyCases',
            )}
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('observe.evals.col.status')}</th>
                <th scope="col">{t('observe.evals.col.case')}</th>
                <th scope="col" className="col-optional">
                  {t('observe.evals.col.duration')}
                </th>
                <th scope="col" className="col-optional">
                  {t('observe.evals.col.assertions')}
                </th>
                <th scope="col">{t('observe.evals.col.output')}</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.id}>
                  <td>
                    <StatusChip status={item.status} />
                  </td>
                  <td className="mono">{item.id}</td>
                  <td className="mono col-optional">{item.duration_ms}ms</td>
                  <td className="mono col-optional">
                    {item.assertions.filter((assertion) => assertion.ok).length}/
                    {item.assertions.length}
                  </td>
                  <td>
                    {item.error ? (
                      <span className="err">{item.error}</span>
                    ) : (
                      <span className="dim">{item.output ?? '—'}</span>
                    )}
                    {item.assertions.length > 0 && (
                      <details className="case-assertions" open={item.status === 'failed'}>
                        <summary>{t('observe.evals.assertions')}</summary>
                        <ul className="plain-list">
                          {item.assertions.map((assertion, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 断言顺序稳定
                            <li key={`${assertion.type}-${index}`}>
                              <span className={assertion.ok ? 'ok' : 'err'}>
                                {assertion.ok ? '✓' : '✗'} {assertion.type}
                              </span>
                              {assertion.detail && (
                                <span className="dim"> — {assertion.detail}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cases.length < filteredCases.length && (
          <button type="button" className="load-more" onClick={onShowMore}>
            {t('observe.evals.showMore', { count: filteredCases.length - cases.length })}
          </button>
        )}
      </section>
    </>
  );
}
