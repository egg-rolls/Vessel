import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStartWorkflowSignal } from '../../app/intents';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { usePaletteEntities } from '../../components/PaletteEntities';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { WorkflowStepSummary } from '../../gateway/types';
import { buildWorkflowPaletteActions } from '../../state/palette-actions';
import { resourceData, useResource } from '../../state/useResource';
import {
  filterWorkflows,
  progressPercent,
  type WorkflowStatusFilter,
  workflowStatusActive,
  workflowStatusCancellable,
  workflowStatusResumable,
} from '../../state/workflows';
import { StartWorkflowDialog } from './StartWorkflowDialog';

type WorkflowsRoute = Extract<Route, { domain: 'workflows' }>;

const FILTERS: readonly { id: WorkflowStatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待执行' },
  { id: 'running', label: '运行中' },
  { id: 'completed', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'interrupted', label: '已中断' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stepDuration(step: WorkflowStepSummary): string {
  if (step.started_at === undefined) return '—';
  if (step.finished_at === undefined) return '进行中';
  return `${Math.max(0, step.finished_at - step.started_at)}ms`;
}

function WorkflowSteps({ steps }: { steps: readonly WorkflowStepSummary[] }) {
  if (steps.length === 0) {
    return <p className="section-desc">无步骤信息。</p>;
  }
  return (
    <ol className="step-timeline">
      {steps.map((step, index) => (
        <li className={`step-item step-${step.status}`} key={step.id}>
          <div className="step-rail" aria-hidden="true">
            <span className="step-dot" />
          </div>
          <div className="step-body">
            <div className="step-head">
              <span className="step-index mono">{index + 1}</span>
              <StatusChip status={step.status} />
              <span className="mono step-id">{step.id}</span>
              <span className="dim">{step.type}</span>
              <span className="dim mono">attempts {step.attempts}</span>
              <span className="dim mono">{stepDuration(step)}</span>
            </div>
            <div className="step-times dim mono">
              开始 {formatTimestamp(step.started_at) || '—'} · 结束{' '}
              {formatTimestamp(step.finished_at) || '—'}
            </div>
            {step.error && (
              <pre className="run-output err" role="alert">
                {step.error}
              </pre>
            )}
            {step.output_preview && (
              <details className="step-output" open={step.status === 'failed'}>
                <summary>输出预览</summary>
                <pre className="json-body">{step.output_preview}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function WorkflowsView({
  route,
  navigate,
}: {
  route: WorkflowsRoute;
  navigate: (route: Route) => void;
}) {
  const { client, connectionState, hasToken, features, epoch, tenantId, eventStore } =
    useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('workflow');

  const [status, setStatus] = useState<WorkflowStatusFilter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);

  // 命令面板「启动 workflow」：导航到本域后打开对话框。
  useStartWorkflowSignal(
    useCallback(() => {
      if (!connected) {
        toast.error('连接断开，无法启动 workflow');
        return;
      }
      setStartOpen(true);
    }, [connected, toast]),
  );

  const listResource = useResource({
    load: () => client.listWorkflowsRpc({ limit: 100 }),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  const workflows = useMemo(() => resourceData(listResource.state) ?? [], [listResource.state]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byStatus = filterWorkflows(workflows, status);
    if (!needle) return byStatus;
    return byStatus.filter(
      (run) =>
        run.workflow_name.toLowerCase().includes(needle) ||
        run.workflow_run_id.toLowerCase().includes(needle),
    );
  }, [workflows, status, query]);

  const summary = route.workflowId
    ? workflows.find((run) => run.workflow_run_id === route.workflowId)
    : undefined;
  // 详情轮询：先按 summary 推断，详情加载后按真实状态停止（终态不再 2s 拉取）。
  const [detailPolling, setDetailPolling] = useState(Boolean(route.workflowId));

  const detailResource = useResource({
    load: async () => (route.workflowId ? client.getWorkflowRpc(route.workflowId) : null),
    enabled: available && Boolean(route.workflowId),
    ...(detailPolling && connected ? { pollMs: 2000 } : {}),
    deps: [route.workflowId, epoch],
  });
  // useResource 刷新时保留旧数据；路由切换后过滤掉上一个 workflow 的响应。
  const fetchedDetail = resourceData(detailResource.state);
  const detail =
    fetchedDetail && fetchedDetail.workflow_run_id === route.workflowId ? fetchedDetail : undefined;

  useEffect(() => {
    setDetailPolling(Boolean(route.workflowId));
  }, [route.workflowId]);
  useEffect(() => {
    if (detail) setDetailPolling(workflowStatusActive(detail.status));
  }, [detail]);

  const refreshAll = useCallback(() => {
    listResource.reload();
    detailResource.reload();
  }, [listResource.reload, detailResource.reload]);
  useRefreshSignal(refreshAll);

  // workflow.* 事件后 500ms 合并刷新；10s 轮询兜底。
  const lastVersion = useRef(-1);
  const eventTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = eventStore.subscribe(() => {
      const snapshot = eventStore.getSnapshot();
      if (snapshot.version === lastVersion.current) return;
      lastVersion.current = snapshot.version;
      const recent = snapshot.entries.slice(-100);
      if (!recent.some(({ event }) => event.type.startsWith('workflow.'))) return;
      window.clearTimeout(eventTimer.current);
      eventTimer.current = window.setTimeout(() => {
        listResource.reload();
        detailResource.reload();
      }, 500);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(eventTimer.current);
    };
  }, [eventStore, listResource.reload, detailResource.reload]);

  const runAction = useCallback(async (id: string, action: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await action();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const resume = useCallback(
    (id: string) => {
      if (!connected) {
        toast.error('连接断开，无法恢复工作流');
        return;
      }
      void runAction(id, async () => {
        try {
          await client.resumeWorkflowRpc(id);
          toast.success(`已恢复工作流运行 ${id}`);
          refreshAll();
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes('workflow_already_running') || message.includes('conflict')) {
            toast.info('该工作流运行已在恢复中');
            refreshAll();
          } else {
            toast.error(message);
          }
        }
      });
    },
    [client, connected, refreshAll, runAction, toast],
  );

  const cancel = useCallback(
    (id: string) => {
      setCancelTarget(null);
      if (!connected) {
        toast.error('连接断开，无法取消工作流');
        return;
      }
      void runAction(id, async () => {
        try {
          await client.cancelWorkflowRpc(id);
          toast.success(`已取消工作流运行 ${id}`);
          refreshAll();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      });
    },
    [client, connected, refreshAll, runAction, toast],
  );

  // 命令面板：实体 + 打开/恢复/取消动作。
  const paletteEntities = useMemo(
    () =>
      workflows.slice(0, 15).map((run) => ({
        id: `workflow-${run.workflow_run_id}`,
        group: 'entity' as const,
        label: `工作流 ${run.workflow_name}`,
        keywords: [run.workflow_run_id, run.status],
        hint: '工作流运行',
        run: () => navigate({ domain: 'workflows', workflowId: run.workflow_run_id }),
      })),
    [workflows, navigate],
  );
  const paletteActions = useMemo(
    () =>
      buildWorkflowPaletteActions({
        workflows,
        open: (workflowId) => navigate({ domain: 'workflows', workflowId }),
        resume,
        cancel,
      }),
    [workflows, navigate, resume, cancel],
  );
  usePaletteEntities('workflows', [...paletteEntities, ...paletteActions]);

  if (!hasToken) {
    return (
      <div className="domain-view">
        <PageHeader title="工作流" tenantId={tenantId} />
        <EmptyState
          title="连接 gateway 后显示工作流运行。"
          action={
            <button
              type="button"
              className="btn"
              onClick={() => navigate({ domain: 'settings', tab: 'connection' })}
            >
              配置连接
            </button>
          }
        />
      </div>
    );
  }

  if (!features.includes('workflow')) {
    return (
      <div className="domain-view">
        <PageHeader title="工作流" tenantId={tenantId} />
        <NotEnabledState
          title="工作流未启用"
          reason="此 gateway 没有注入 workflow 控制面。"
          hint="需要启用 workflow 插件后重启 gateway。"
        />
      </div>
    );
  }

  if (route.workflowId) {
    const detailError = detailResource.state.status === 'error' ? detailResource.state.error : null;
    const loadingDetail =
      !detail &&
      (detailResource.state.status === 'idle' || detailResource.state.status === 'loading');
    return (
      <div className="domain-view">
        <PageHeader
          title={detail?.workflow_name ?? summary?.workflow_name ?? '工作流运行'}
          description={<span className="mono">{route.workflowId}</span>}
          tenantId={tenantId}
          scopeNote="default tenant only"
          actions={
            <>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => navigate({ domain: 'workflows' })}
              >
                ← 返回列表
              </button>
              {detail && workflowStatusResumable(detail.status) && (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={!connected || busy.has(detail.workflow_run_id)}
                  title={!connected ? '连接断开，写操作已禁用' : undefined}
                  onClick={() => resume(detail.workflow_run_id)}
                >
                  {busy.has(detail.workflow_run_id) ? '恢复中…' : '恢复运行'}
                </button>
              )}
              {detail && workflowStatusCancellable(detail.status) && (
                <button
                  type="button"
                  className="btn btn-small btn-danger-ghost"
                  disabled={!connected}
                  title={!connected ? '连接断开，写操作已禁用' : undefined}
                  onClick={() => setCancelTarget(detail.workflow_run_id)}
                >
                  取消
                </button>
              )}
            </>
          }
        />

        <div className="domain-content">
          {!connected && detail && (
            <StaleNotice
              message="连接已断开；显示最近一次读取的工作流详情，写操作已禁用。"
              onRetry={detailResource.reload}
            />
          )}
          {detailError && !detail ? (
            <ErrorState message={detailError} onRetry={detailResource.reload} />
          ) : loadingDetail ? (
            <LoadingState label="正在加载工作流运行…" />
          ) : !detail ? (
            <EmptyState
              title="找不到该工作流运行。"
              description="它可能已被清理，或属于其他租户。"
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigate({ domain: 'workflows' })}
                >
                  返回列表
                </button>
              }
            />
          ) : (
            <>
              {detailError && (
                <StaleNotice
                  message={`更新失败，显示旧数据：${detailError}`}
                  onRetry={detailResource.reload}
                />
              )}
              <section className="panel">
                <div className="panel-header">
                  <h2 className="section-title">概览</h2>
                  <StatusChip status={detail.status} />
                </div>
                <dl className="diag-list">
                  <dt>运行 ID</dt>
                  <dd className="mono">{detail.workflow_run_id}</dd>
                  <dt>定义</dt>
                  <dd className="mono">{detail.definition_path || '—'}</dd>
                  <dt>进度</dt>
                  <dd className="mono">
                    {detail.completed_steps}/{detail.step_count}
                  </dd>
                  <dt>开始</dt>
                  <dd className="mono">{formatTimestamp(detail.started_at)}</dd>
                  <dt>更新</dt>
                  <dd className="mono">{formatTimestamp(detail.updated_at)}</dd>
                </dl>
                {detail.error && (
                  <p className="form-error" role="alert">
                    {detail.error}
                  </p>
                )}
                {Object.keys(detail.inputs).length > 0 && (
                  <>
                    <h3 className="section-title">输入</h3>
                    <table className="data-table">
                      <tbody>
                        {Object.entries(detail.inputs).map(([key, value]) => (
                          <tr key={key}>
                            <th scope="row" className="mono">
                              {key}
                            </th>
                            <td className="mono">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>

              <section className="panel">
                <h2 className="section-title">步骤</h2>
                <WorkflowSteps steps={detail.steps} />
              </section>
            </>
          )}
        </div>

        {cancelTarget && (
          <ConfirmDialog
            title="取消工作流运行？"
            body={<p>已完成步骤会保留；取消后无法继续执行该运行。</p>}
            confirmLabel="取消运行"
            danger
            confirmDisabled={!connected}
            onConfirm={() => cancel(cancelTarget)}
            onCancel={() => setCancelTarget(null)}
          />
        )}
      </div>
    );
  }

  const listError = listResource.state.status === 'error' ? listResource.state.error : null;
  const loading =
    listResource.state.status === 'idle' ||
    (listResource.state.status === 'loading' && workflows.length === 0);
  const openStart = () => {
    if (!connected) {
      toast.error('连接断开，无法启动 workflow');
      return;
    }
    setStartOpen(true);
  };

  return (
    <div className="domain-view">
      <PageHeader
        title="工作流"
        description="工作流运行与步骤；启动需要输入定义名（后端没有定义枚举接口）。"
        tenantId={tenantId}
        scopeNote="default tenant only"
        actions={
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={openStart}
            disabled={!connected}
            title={!connected ? '连接断开，写操作已禁用' : undefined}
          >
            启动 workflow
          </button>
        }
      />

      {!connected && workflows.length > 0 && (
        <StaleNotice
          message="连接已断开；显示最近一次读取的工作流列表，写操作已禁用。"
          onRetry={refreshAll}
        />
      )}

      <div className="filter-bar">
        <input
          className="input search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称或运行 ID"
          type="search"
          aria-label="搜索工作流"
        />
        <fieldset className="filter-chips">
          <legend className="sr-only">按状态过滤工作流</legend>
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`filter-chip ${filter.id === status ? 'active' : ''}`.trim()}
              aria-pressed={filter.id === status}
              onClick={() => setStatus(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </fieldset>
        <button type="button" className="btn btn-small" onClick={refreshAll}>
          刷新
        </button>
      </div>

      <div className="domain-content">
        {listError && workflows.length > 0 && (
          <StaleNotice
            message={`更新失败，显示旧数据：${listError}`}
            onRetry={listResource.reload}
          />
        )}
        {listError && workflows.length === 0 ? (
          <ErrorState message={listError} onRetry={listResource.reload} />
        ) : loading ? (
          <LoadingState label="正在加载工作流运行…" />
        ) : workflows.length === 0 ? (
          <EmptyState
            title="还没有 workflow run。"
            description="点击右上角「启动 workflow」运行一个定义。"
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={openStart}
                disabled={!connected}
                title={!connected ? '连接断开，写操作已禁用' : undefined}
              >
                启动 workflow
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的工作流运行。"
            description="切换状态或清除搜索后重试。"
            action={
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery('');
                  setStatus('all');
                }}
              >
                清除过滤
              </button>
            }
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">名称</th>
                <th scope="col" className="col-optional">
                  进度
                </th>
                <th scope="col" className="col-optional">
                  更新
                </th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const percent = progressPercent(run.completed_steps, run.step_count);
                return (
                  <tr key={run.workflow_run_id}>
                    <td>
                      <StatusChip status={run.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          navigate({
                            domain: 'workflows',
                            workflowId: run.workflow_run_id,
                          })
                        }
                      >
                        {run.workflow_name}
                      </button>
                    </td>
                    <td className="mono col-optional">
                      {run.completed_steps}/{run.step_count}
                      <span className="progress" aria-hidden="true">
                        <span className="progress-bar" style={{ width: `${percent}%` }} />
                      </span>
                    </td>
                    <td className="mono col-optional">{formatTimestamp(run.updated_at)}</td>
                    <td>
                      {workflowStatusResumable(run.status) && (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={!connected || busy.has(run.workflow_run_id)}
                          title={!connected ? '连接断开，写操作已禁用' : undefined}
                          onClick={() => resume(run.workflow_run_id)}
                        >
                          {busy.has(run.workflow_run_id) ? '恢复中…' : '恢复'}
                        </button>
                      )}
                      {workflowStatusCancellable(run.status) && (
                        <button
                          type="button"
                          className="btn btn-small btn-danger-ghost"
                          disabled={!connected}
                          title={!connected ? '连接断开，写操作已禁用' : undefined}
                          onClick={() => setCancelTarget(run.workflow_run_id)}
                        >
                          取消
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {cancelTarget && (
        <ConfirmDialog
          title="取消工作流运行？"
          body={<p>已完成步骤会保留；取消后无法继续执行该运行。</p>}
          confirmLabel="取消运行"
          danger
          confirmDisabled={!connected}
          onConfirm={() => cancel(cancelTarget)}
          onCancel={() => setCancelTarget(null)}
        />
      )}

      {startOpen && (
        <StartWorkflowDialog
          onClose={() => setStartOpen(false)}
          onStarted={(workflowRunId) => {
            setStartOpen(false);
            navigate({ domain: 'workflows', workflowId: workflowRunId });
            listResource.reload();
          }}
        />
      )}
    </div>
  );
}
