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
  const available = connected && features.includes('metrics');
  const [source, setSource] = useState<'live' | 'trace'>('live');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const resource = useResource({
    load: () => client.getMetrics(source),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch, source],
  });
  const metrics = resourceData(resource.state);
  useRefreshSignal(resource.reload);

  if (!connected) {
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
        action={
          <button type="button" className="btn" onClick={() => setSource('live')}>
            切回 Live
          </button>
        }
      />
    );
  }

  const reset = async () => {
    setResetting(true);
    try {
      await client.resetMetrics();
      toast.success('指标已重置');
      resource.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

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
          disabled={!metrics}
        >
          重置指标
        </button>
      </div>

      {resource.state.status === 'error' && metrics && (
        <StaleNotice
          message={`更新失败，显示旧数据：${resource.state.error}`}
          onRetry={resource.reload}
        />
      )}
      {!metrics ? (
        resource.state.status === 'error' ? (
          <ErrorState message={resource.state.error} onRetry={resource.reload} />
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
            当前来源：{source === 'trace' ? 'Trace 重建' : 'Live'}
            。指标是进程内计数器，不是时间序列。
          </p>
        </>
      )}

      {confirmReset && (
        <ConfirmDialog
          title="重置指标？"
          body={<p>将清空当前 gateway 进程内的计数；不影响 trace 与运行记录。</p>}
          confirmLabel="重置"
          danger
          busy={resetting}
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
  const available = connected && features.includes('evals');
  const [suite, setSuite] = useState('smoke');
  const [requested, setRequested] = useState(0);
  const [runReport, setRunReport] = useState<EvalReport | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [suites, setSuites] = useState<string[]>(readSuites);

  const latest = useResource({
    load: () => client.getLatestEval(suite),
    enabled: available && requested > 0,
    deps: [epoch, suite, requested],
  });
  const report = runReport ?? resourceData(latest.state) ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: suite change resets the previous run report
  useEffect(() => {
    setRunReport(null);
    setRunError(null);
  }, [suite]);

  const rememberSuite = (value: string) => {
    const next = [value, ...suites.filter((item) => item !== value)].slice(0, 8);
    setSuites(next);
    localStorage.setItem(EVAL_SUITES_KEY, JSON.stringify(next));
  };

  if (!connected) {
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
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await client.runEval(suite);
      setRunReport(result);
      rememberSuite(suite);
      toast.success(`评测完成：${result.suite}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunBusy(false);
    }
  };

  const notFound =
    latest.state.status === 'error' &&
    (latest.state.error.includes('not_found') ||
      latest.state.error.includes('eval_not_found') ||
      latest.state.error.includes('Eval report not found'));

  return (
    <div className="settings-section">
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
          disabled={!suite.trim() || runBusy}
        >
          {runBusy ? '运行中…（可离开页面）' : '运行评测'}
        </button>
      </div>

      {runError && <ErrorState message={runError} onRetry={() => void run()} retryLabel="重试" />}
      {!runReport && notFound && (
        <NotEnabledState
          title="Evals 未启用或没有该 suite 的报告"
          reason={latest.state.status === 'error' ? latest.state.error : undefined}
          hint="确认 suite 名称；运行评测可生成新报告。"
        />
      )}
      {!runReport && !notFound && latest.state.status === 'error' && (
        <ErrorState message={latest.state.error} onRetry={latest.reload} />
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
        <EvalReportView report={report} />
      ) : null}
    </div>
  );
}

function EvalReportView({ report }: { report: EvalReport }) {
  const cases = useMemo(() => report.cases.slice(0, 100), [report.cases]);
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
          <span className="stat-label">耗时 · network {report.network ? 'on' : 'off'}</span>
        </div>
      </div>

      <section className="panel">
        <h2 className="section-title">用例</h2>
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
                    <details className="case-assertions">
                      <summary>断言详情</summary>
                      <ul className="plain-list">
                        {item.assertions.map((assertion, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 断言顺序稳定
                          <li key={`${assertion.type}-${index}`}>
                            <span className={assertion.ok ? 'ok' : 'err'}>
                              {assertion.ok ? '✓' : '✗'} {assertion.type}
                            </span>
                            {assertion.detail && <span className="dim"> — {assertion.detail}</span>}
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
        {report.cases.length > cases.length && (
          <p className="section-desc">
            显示前 {cases.length} 条，共 {report.cases.length} 条。
          </p>
        )}
      </section>
      <p className="section-desc">
        报告生成于 {formatTimestamp(report.finished_at)}。评测默认离线，网络模式由服务端门控。
      </p>
    </>
  );
}
