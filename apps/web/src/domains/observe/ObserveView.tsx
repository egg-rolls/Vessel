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
import { resourceData, useResource } from '../../state/useResource';

type ObserveRoute = Extract<Route, { domain: 'observe' }>;
type Tab = ObserveRoute['tab'];

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'metrics', label: '指标' },
  { id: 'evals', label: '评测' },
];

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
  const { tenantId } = useConnection();
  return (
    <div className="domain-view">
      <PageHeader
        title="可观测"
        description="指标（计数）与评测（离线质量）。事件记录在运行详情中查看。"
        tenantId={tenantId}
      />
      <SegmentedTabs
        label="可观测分区"
        tabs={TABS}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'observe', tab })}
      />
      <div className="domain-content">
        {route.tab === 'metrics' && <MetricsPanel />}
        {route.tab === 'evals' && <EvalsPanel />}
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
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取指标。" />;
  }
  if (!features.includes('metrics')) {
    return (
      <NotEnabledState
        title="指标未启用"
        reason="该 gateway 没有注入 metrics provider。"
        hint="需要启用 metrics 后重启 gateway。"
      />
    );
  }
  if (source === 'trace' && resource.state.status === 'error') {
    return (
      <NotEnabledState
        title="Trace 指标重建不可用"
        reason={resource.state.error}
        hint="需要 gateway 注入 metrics.rebuild（trace）后重启。"
        action={
          <button type="button" className="btn" onClick={() => setSource('live')}>
            切回 Live
          </button>
        }
      />
    );
  }

  const reset = async () => {
    if (!connected) {
      toast.error('连接断开，无法重置指标');
      return;
    }
    setResetting(true);
    try {
      await client.resetMetrics();
      toast.success('指标已重置');
      resource.reload();
    } catch (error) {
      toast.error(
        isForbidden(error)
          ? '当前 token 没有 metrics.reset 权限（需要 write/admin）。'
          : errorMessage(error),
      );
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
          label="指标来源"
          tabs={[
            { id: 'live', label: 'Live' },
            { id: 'trace', label: 'Trace 重建' },
          ]}
          value={source}
          onChange={setSource}
        />
        <button type="button" className="btn btn-small" onClick={resource.reload}>
          刷新
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger-ghost"
          onClick={() => setConfirmReset(true)}
          disabled={!connected || !metrics}
          title={!connected ? '连接断开，写操作已禁用' : undefined}
        >
          重置指标
        </button>
      </div>

      {!connected && metrics && (
        <StaleNotice
          message="连接已断开；显示最近一次读取的指标快照。写操作已禁用。"
          onRetry={resource.reload}
        />
      )}
      {error && metrics && (
        <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={resource.reload} />
      )}
      {!metrics ? (
        error ? (
          <ErrorState message={error} onRetry={resource.reload} />
        ) : (
          <LoadingState label="正在读取指标…" />
        )
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat">
              <span className="stat-value">{metrics.runs.started}</span>
              <span className="stat-label">Runs 已启动</span>
            </div>
            <div className="stat">
              <span className="stat-value">{metrics.runs.completed}</span>
              <span className="stat-label">已完成</span>
            </div>
            <div className="stat">
              <span className="stat-value">{metrics.runs.failed}</span>
              <span className="stat-label">失败</span>
            </div>
            <div className="stat">
              <span className="stat-value">{metrics.runs.cancelled}</span>
              <span className="stat-label">已取消</span>
            </div>
            <div className="stat">
              <span className="stat-value">{metrics.tool_calls.total}</span>
              <span className="stat-label">工具调用（失败 {metrics.tool_calls.failed}）</span>
            </div>
            <div className="stat">
              <span className="stat-value">{metrics.llm.total_tokens}</span>
              <span className="stat-label">
                Tokens（{metrics.llm.prompt_tokens}+{metrics.llm.completion_tokens}）
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">{Math.round(metrics.duration_ms.avg)}ms</span>
              <span className="stat-label">
                平均耗时（最大 {Math.round(metrics.duration_ms.max)}ms）
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatTimestamp(metrics.updated_at)}</span>
              <span className="stat-label">更新于</span>
            </div>
          </div>
          <p className="section-desc">
            当前来源：{data?.source === 'trace' ? 'Trace 重建' : 'Live'}
            。指标是进程内计数器，不是时间序列。重置需要 write/admin 权限。
          </p>
        </>
      )}

      {confirmReset && (
        <ConfirmDialog
          title="重置指标？"
          body={
            <>
              <p>将清空当前 gateway 进程内的计数；不影响 trace 与运行记录。</p>
              <p className="dim">该操作需要 write/admin 权限，非授权 token 会返回 forbidden。</p>
            </>
          }
          confirmLabel="重置"
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
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取评测报告。" />;
  }
  if (!features.includes('evals')) {
    return (
      <NotEnabledState
        title="评测未启用"
        reason="该 gateway 没有注入 evals runner。"
        hint="需要启用 evals 插件后重启 gateway。"
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
      toast.error('连接断开，无法运行评测');
      return;
    }
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await client.runEval(suite);
      setRunReport(result);
      rememberSuite(suite);
      toast.success(`评测完成：${result.suite}`);
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
      <p className="section-desc">
        评测默认离线运行；网络模式由服务端 `evals.allowNetwork` 与 CLI `--allow-network` 双门控，
        客户端不提供开关。运行评测可能需要较长时间，可以离开此页。
      </p>
      <div className="filter-bar">
        <input
          className="input"
          value={suite}
          onChange={(event) => setSuite(event.target.value)}
          placeholder="suite（默认 smoke）"
          aria-label="评测 suite"
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
          加载最近报告
        </button>
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => void run()}
          disabled={!connected || !suite.trim() || runBusy}
          title={!connected ? '连接断开，写操作已禁用' : undefined}
        >
          {runBusy ? '运行中…（可离开页面）' : '运行评测'}
        </button>
      </div>
      {suites.length > 0 && (
        <div className="chip-row">
          <span className="dim">最近使用：</span>
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

      {runError && <ErrorState message={runError} onRetry={() => void run()} retryLabel="重试" />}
      {!connected && report && <StaleNotice message="连接已断开；显示最近一次读取的评测报告。" />}
      {!runReport && notFound && (
        <NotEnabledState
          title="Evals 未启用或没有该 suite 的报告"
          reason={latestError ?? undefined}
          hint="确认 suite 名称；运行评测可生成新报告。"
        />
      )}
      {!runReport && !notFound && latestError && (
        <ErrorState message={latestError} onRetry={latest.reload} />
      )}
      {!report && !runError && !notFound ? (
        latest.state.status === 'loading' ? (
          <LoadingState label="正在读取评测报告…" />
        ) : (
          <EmptyState
            title="加载一个评测报告。"
            description="后端没有 suite 列表接口；输入 suite 名称或从最近使用中选择。"
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
          <span className="stat-label">用例总数</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.passed}</span>
          <span className="stat-label">通过</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.failed}</span>
          <span className="stat-label">失败</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.errors}</span>
          <span className="stat-label">错误</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.skipped}</span>
          <span className="stat-label">跳过</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.duration_ms}ms</span>
          <span className="stat-label">耗时</span>
        </div>
        <div className="stat">
          <span className="stat-value">{report.network ? 'on' : 'off'}</span>
          <span className="stat-label">网络模式</span>
        </div>
      </div>
      <p className="section-desc">
        报告生成于 {formatTimestamp(report.finished_at)}。
        {report.network ? '本次启用了网络模式。' : '本次为离线评测。'}
      </p>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">用例</h2>
          <button
            type="button"
            className={`filter-chip ${caseFilter === 'failed' ? 'active' : ''}`.trim()}
            aria-pressed={caseFilter === 'failed'}
            onClick={() => onCaseFilter(caseFilter === 'failed' ? 'all' : 'failed')}
          >
            只看失败
          </button>
          <span className="count-pill">
            {filteredCases.length}/{report.cases.length}
          </span>
        </div>
        {filteredCases.length === 0 ? (
          <EmptyState title={caseFilter === 'failed' ? '没有失败用例。' : '没有用例。'} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">用例</th>
                <th scope="col" className="col-optional">
                  耗时
                </th>
                <th scope="col" className="col-optional">
                  断言
                </th>
                <th scope="col">输出 / 错误</th>
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
                        <summary>断言详情</summary>
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
            显示更多用例（还有 {filteredCases.length - cases.length} 条）
          </button>
        )}
      </section>
    </>
  );
}
