import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { WorkflowRunSummary } from '../../gateway/types';
import { resourceData, useResource } from '../../state/useResource';

type WorkflowsRoute = Extract<Route, { domain: 'workflows' }>;
type StatusFilter = 'all' | WorkflowRunSummary['status'];

const FILTERS: readonly { id: StatusFilter; label: string }[] = [
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

function parseInputs(
  raw: string,
): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'inputs 必须是合法 JSON 对象' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'inputs 必须是 JSON 对象' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 64) return { ok: false, error: 'inputs 最多 64 项' };
  const value: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== 'string') return { ok: false, error: 'inputs 的值必须是字符串' };
    value[key] = item;
  }
  return { ok: true, value };
}

export function WorkflowsView({
  route,
  navigate,
}: {
  route: WorkflowsRoute;
  navigate: (route: Route) => void;
}) {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = connected && features.includes('workflow');

  const [status, setStatus] = useState<StatusFilter>('all');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [inputsText, setInputsText] = useState('');
  const [startBusy, setStartBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const listResource = useResource({
    load: () => client.listWorkflowsRpc({ limit: 100 }),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  const workflows = resourceData(listResource.state) ?? [];
  const filtered = useMemo(
    () => (status === 'all' ? workflows : workflows.filter((run) => run.status === status)),
    [workflows, status],
  );

  const detailResource = useResource({
    load: async () => (route.workflowId ? client.getWorkflowRpc(route.workflowId) : null),
    enabled: available && Boolean(route.workflowId),
    deps: [route.workflowId, epoch],
  });
  const detail = resourceData(detailResource.state);
  const detailActive =
    detail?.status === 'pending' ||
    detail?.status === 'running' ||
    detail?.status === 'interrupted';
  useEffect(() => {
    if (!detailActive) return;
    const id = window.setInterval(detailResource.reload, 2000);
    return () => window.clearInterval(id);
  }, [detailActive, detailResource.reload]);

  const refreshAll = useCallback(() => {
    listResource.reload();
    detailResource.reload();
  }, [listResource.reload, detailResource.reload]);
  useRefreshSignal(refreshAll);

  const paletteEntities = useMemo(
    () =>
      (resourceData(listResource.state) ?? []).slice(0, 15).map((run) => ({
        id: `workflow-${run.workflow_run_id}`,
        group: 'entity' as const,
        label: `工作流 ${run.workflow_name}`,
        keywords: [run.workflow_run_id, run.status],
        hint: '工作流运行',
        run: () => navigate({ domain: 'workflows', workflowId: run.workflow_run_id }),
      })),
    [listResource.state, navigate],
  );
  usePaletteEntities(paletteEntities);

  const runAction = async (id: string, action: () => Promise<void>) => {
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
  };

  const resume = (id: string) =>
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

  const cancel = async (id: string) => {
    setCancelTarget(null);
    await runAction(id, async () => {
      try {
        await client.cancelWorkflowRpc(id);
        toast.success(`已取消工作流运行 ${id}`);
        refreshAll();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    });
  };

  const start = async () => {
    const workflowName = name.trim();
    if (!workflowName || startBusy) return;
    const inputs = parseInputs(inputsText);
    if (!inputs.ok) {
      setFormError(inputs.error);
      return;
    }
    setStartBusy(true);
    setFormError(null);
    try {
      const accepted = await client.startWorkflowRpc(workflowName, inputs.value);
      toast.success(`已排队：${accepted.workflow_run_id}`);
      setName('');
      setInputsText('');
      navigate({ domain: 'workflows', workflowId: accepted.workflow_run_id });
      listResource.reload();
    } catch (error) {
      const message = errorMessage(error);
      setFormError(
        message.includes('not_found') ? `找不到 workflow 定义：${workflowName}` : message,
      );
    } finally {
      setStartBusy(false);
    }
  };

  if (!connected) {
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
    return (
      <div className="domain-view">
        <PageHeader
          title={detail?.workflow_name ?? '工作流运行'}
          description={<span className="mono">{route.workflowId}</span>}
          tenantId={tenantId}
          actions={
            <>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => navigate({ domain: 'workflows' })}
              >
                ← 返回列表
              </button>
              {detail &&
                (detail.status === 'interrupted' ||
                  detail.status === 'failed' ||
                  detail.status === 'pending') && (
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={busy.has(detail.workflow_run_id)}
                    onClick={() => resume(detail.workflow_run_id)}
                  >
                    恢复运行
                  </button>
                )}
              {detail &&
                detail.status !== 'completed' &&
                detail.status !== 'failed' &&
                detail.status !== 'cancelled' && (
                  <button
                    type="button"
                    className="btn btn-small btn-danger-ghost"
                    onClick={() => setCancelTarget(detail.workflow_run_id)}
                  >
                    取消
                  </button>
                )}
            </>
          }
        />

        <div className="domain-content">
          {detailResource.state.status === 'error' ? (
            <ErrorState message={detailResource.state.error} onRetry={detailResource.reload} />
          ) : !detail ? (
            <LoadingState label="正在加载工作流运行…" />
          ) : (
            <>
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
                {detail.steps.length === 0 ? (
                  <p className="section-desc">无步骤信息。</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">状态</th>
                        <th scope="col">步骤</th>
                        <th scope="col" className="col-optional">
                          类型
                        </th>
                        <th scope="col" className="col-optional">
                          尝试
                        </th>
                        <th scope="col" className="col-optional">
                          耗时
                        </th>
                        <th scope="col">输出 / 错误</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.steps.map((step) => (
                        <tr key={step.id}>
                          <td>
                            <StatusChip status={step.status} />
                          </td>
                          <td className="mono">{step.id}</td>
                          <td className="col-optional">{step.type}</td>
                          <td className="mono col-optional">{step.attempts}</td>
                          <td className="mono col-optional">
                            {step.started_at
                              ? step.finished_at
                                ? `${Math.max(0, step.finished_at - step.started_at)}ms`
                                : '进行中'
                              : '—'}
                          </td>
                          <td>
                            {step.error ? (
                              <span className="err">{step.error}</span>
                            ) : (
                              <span className="dim">{step.output_preview ?? '—'}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
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
            onConfirm={() => void cancel(cancelTarget)}
            onCancel={() => setCancelTarget(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="domain-view">
      <PageHeader
        title="工作流"
        description="工作流运行与步骤；启动需要输入定义名（后端没有定义枚举接口）。"
        tenantId={tenantId}
        scopeNote="default tenant only"
      />

      <section className="panel start-panel">
        <h2 className="section-title">启动 workflow</h2>
        <div className="start-grid">
          <label className="field">
            <span className="field-label">定义名</span>
            <input
              className="input"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
              placeholder="workflow name"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">inputs（可选 JSON）</span>
            <input
              className="input mono"
              value={inputsText}
              onChange={(event) => {
                setInputsText(event.target.value);
                setFormError(null);
              }}
              placeholder='{"env":"prod"}'
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim() || startBusy}
            onClick={() => void start()}
          >
            {startBusy ? '提交中…' : '启动'}
          </button>
        </div>
        {formError && (
          <p className="field-error" role="alert">
            {formError}
          </p>
        )}
      </section>

      <div className="filter-bar">
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
        {listResource.state.status === 'error' && workflows.length === 0 ? (
          <ErrorState message={listResource.state.error} onRetry={listResource.reload} />
        ) : listResource.state.status === 'idle' ||
          (listResource.state.status === 'loading' && workflows.length === 0) ? (
          <LoadingState label="正在加载工作流运行…" />
        ) : workflows.length === 0 ? (
          <EmptyState title="还没有 workflow run。" description="在上方输入定义名并启动。" />
        ) : filtered.length === 0 ? (
          <EmptyState title="没有匹配的工作流运行。" description="切换状态过滤后重试。" />
        ) : (
          <>
            {listResource.state.status === 'error' && (
              <StaleNotice
                message={`更新失败，显示旧数据：${listResource.state.error}`}
                onRetry={listResource.reload}
              />
            )}
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
                {filtered.map((run) => (
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
                    </td>
                    <td className="mono col-optional">{formatTimestamp(run.updated_at)}</td>
                    <td>
                      {(run.status === 'interrupted' ||
                        run.status === 'failed' ||
                        run.status === 'pending') && (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy.has(run.workflow_run_id)}
                          onClick={() => resume(run.workflow_run_id)}
                        >
                          恢复
                        </button>
                      )}
                      {run.status !== 'completed' &&
                        run.status !== 'failed' &&
                        run.status !== 'cancelled' && (
                          <button
                            type="button"
                            className="btn btn-small btn-danger-ghost"
                            onClick={() => setCancelTarget(run.workflow_run_id)}
                          >
                            取消
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {cancelTarget && (
        <ConfirmDialog
          title="取消工作流运行？"
          body={<p>已完成步骤会保留；取消后无法继续执行该运行。</p>}
          confirmLabel="取消运行"
          danger
          onConfirm={() => void cancel(cancelTarget)}
          onCancel={() => setCancelTarget(null)}
        />
      )}
    </div>
  );
}
