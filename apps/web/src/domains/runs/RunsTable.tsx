/**
 * Runs 列表：live / durable 两张只读表格与「显示更多」。
 *
 * 0.45：状态 / agent 过滤下沉到表头；Run ID 为首列；会话与 agent 优先显示
 * 名称（缺失回退 id），并新增缓存命中率列（缺字段显示 `—`，绝不按 0% 处理）。
 */

import type { ReactNode } from 'react';
import { StatusChip } from '../../components/StatusChip';
import { Button, DataTable } from '../../components/ui';
import { FilterPopover } from '../../components/ui/FilterPopover';
import { formatTimestamp } from '../../format';
import type { DurableRunSummary, RunStatus, Usage } from '../../gateway/types';
import { t } from '../../i18n';
import {
  isCancellableRun,
  isResumableRun,
  type RunStatusFilter,
  runAgentId,
} from '../../state/runs';

/**
 * 耗时文案。
 *
 * `completed_at` 只有 durable checkpoint 才有，live 快照的已完成 run 没有该字段
 * （`liveRunStatus` 不产出）。**不能**用 `Date.now()` 兜底已结束的 run —— 那会让
 * 耗时随当前时间无限增长（实测显示到 6 万秒）。只有还在跑的 run 才按「现在」算。
 */
export function durationLabel(start?: number, end?: number, running = false): string {
  if (start === undefined) return '—';
  const stop = end ?? (running ? Date.now() : undefined);
  if (stop === undefined) return '—';
  const value = Math.max(0, stop - start);
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

/**
 * 缓存命中率 = cache_read_tokens / prompt_tokens。
 *
 * 任一侧缺失（或没有 prompt）都返回 `—`：缺字段 ≠ 0% 命中。
 * 只读已有 usage 字段，不新增 wire 字段。
 */
export function cacheHitRateLabel(usage?: Usage): string {
  const read = usage?.cache_read_input_tokens;
  const prompt = usage?.prompt_tokens;
  if (read === undefined || prompt === undefined || prompt <= 0) return '—';
  const rate = Math.max(0, Math.min(1, read / prompt));
  return `${Math.round(rate * 100)}%`;
}

/** durable checkpoint 可能带 usage；列表类型未声明时按可选读取。 */
function usageOf(run: unknown): Usage | undefined {
  if (typeof run !== 'object' || run === null) return undefined;
  const usage = (run as { usage?: unknown }).usage;
  return typeof usage === 'object' && usage !== null ? (usage as Usage) : undefined;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

export function RunsTable({
  tab,
  windowed,
  connected,
  busy,
  activeKey,
  status,
  onStatusChange,
  filterList,
  agentId,
  onAgentIdChange,
  agentOptions,
  sessionNames,
  agentNames,
  onCancel,
  onResume,
  onOpenRun,
  onOpenSession,
  onSelectAgent,
  onShowMore,
}: {
  tab: 'live' | 'durable';
  windowed: { shown: Array<RunStatus | DurableRunSummary>; hiddenCount: number };
  connected: boolean;
  busy: Set<string>;
  activeKey?: string;
  status: RunStatusFilter;
  onStatusChange: (value: RunStatusFilter) => void;
  filterList: readonly { id: RunStatusFilter; labelKey: string }[];
  agentId: string;
  onAgentIdChange: (value: string) => void;
  agentOptions: readonly string[];
  sessionNames: ReadonlyMap<string, string>;
  agentNames: ReadonlyMap<string, string>;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onOpenRun: (runId: string, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onShowMore: () => void;
}) {
  const statusFilter = (header: ReactNode) => (
    <FilterPopover
      label={String(header)}
      allValue="all"
      value={status}
      options={filterList
        .filter((filter) => filter.id !== 'all')
        .map((filter) => ({ value: filter.id, label: t(filter.labelKey) }))}
      onChange={(value) => onStatusChange(value as RunStatusFilter)}
    />
  );
  const agentFilter = (header: ReactNode) => (
    <FilterPopover
      label={String(header)}
      allValue=""
      value={agentId}
      searchThreshold={0}
      options={agentOptions.map((id) => ({ value: id, label: agentNames.get(id) ?? shortId(id) }))}
      onChange={onAgentIdChange}
    />
  );

  return (
    <>
      {tab === 'live' ? (
        <DataTable<RunStatus>
          columns={[
            {
              key: 'runId',
              header: t('runs.col.runId'),
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  title={run.run_id}
                  onClick={() => onOpenRun(run.run_id, run.session_id)}
                >
                  {run.run_id.slice(0, 16)}
                </Button>
              ),
            },
            {
              key: 'status',
              header: t('runs.col.state'),
              headerFilter: statusFilter,
              cell: (run) => (
                <StatusChip
                  status={run.status}
                  label={
                    run.status === 'queued' && run.queue_position !== undefined
                      ? t('chat.run.queuedPosition', {
                          position: run.queue_position,
                        })
                      : undefined
                  }
                />
              ),
            },
            {
              key: 'session',
              header: t('runs.col.session'),
              hide: 'compact',
              cell: (run) => {
                const name = sessionNames.get(run.session_id);
                return (
                  <Button
                    variant="link"
                    className={name ? undefined : 'font-mono'}
                    title={name ?? run.session_id}
                    onClick={() => onOpenSession(run.session_id)}
                  >
                    {name ?? shortId(run.session_id)}
                  </Button>
                );
              },
            },
            {
              key: 'agent',
              header: t('runs.col.agent'),
              hide: 'wide',
              headerFilter: agentFilter,
              cell: (run) => {
                const runAgent = runAgentId(run);
                if (!runAgent) return <span className="text-muted">—</span>;
                const name = agentNames.get(runAgent);
                return (
                  <Button
                    variant="link"
                    className={name ? undefined : 'font-mono'}
                    title={name ?? runAgent}
                    onClick={() => onSelectAgent(runAgent)}
                  >
                    {name ?? shortId(runAgent)}
                  </Button>
                );
              },
            },
            {
              key: 'started',
              header: t('runs.col.started'),
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => formatTimestamp(run.started_at),
            },
            {
              key: 'duration',
              header: t('runs.col.duration'),
              hide: 'compact',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) =>
                durationLabel(
                  run.started_at,
                  run.completed_at,
                  run.status === 'running' || run.status === 'queued',
                ),
            },
            {
              key: 'tokens',
              header: 'Tokens',
              hide: 'wide',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => run.usage?.total_tokens ?? '—',
            },
            {
              key: 'cache',
              header: t('runs.col.cacheHit'),
              hide: 'wide',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => cacheHitRateLabel(usageOf(run)),
            },
            {
              key: 'actions',
              header: t('runs.col.actions'),
              cell: (run) =>
                isCancellableRun(run.status) ? (
                  <Button
                    size="small"
                    variant="dangerGhost"
                    disabled={!connected || busy.has(run.run_id)}
                    title={!connected ? t('common.writesDisabled') : undefined}
                    onClick={() => onCancel(run.run_id)}
                  >
                    {busy.has(run.run_id) ? t('runs.cancelling') : t('runs.cancel')}
                  </Button>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
          ]}
          rows={windowed.shown as RunStatus[]}
          rowKey={(run) => run.run_id}
          activeKey={activeKey}
        />
      ) : (
        <DataTable<DurableRunSummary>
          columns={[
            {
              key: 'runId',
              header: t('runs.col.runId'),
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  title={run.run_id}
                  onClick={() => onOpenRun(run.run_id, run.session_id)}
                >
                  {run.run_id.slice(0, 16)}
                </Button>
              ),
            },
            {
              key: 'status',
              header: t('runs.col.state'),
              headerFilter: statusFilter,
              cell: (run) => <StatusChip status={run.status} />,
            },
            {
              key: 'session',
              header: t('runs.col.session'),
              hide: 'compact',
              cell: (run) => {
                const name = sessionNames.get(run.session_id);
                return (
                  <Button
                    variant="link"
                    className={name ? undefined : 'font-mono'}
                    title={name ?? run.session_id}
                    onClick={() => onOpenSession(run.session_id)}
                  >
                    {name ?? shortId(run.session_id)}
                  </Button>
                );
              },
            },
            {
              key: 'agent',
              header: t('runs.col.agent'),
              hide: 'wide',
              headerFilter: agentFilter,
              cell: (run) => {
                if (!run.agent_id) return <span className="text-muted">—</span>;
                const name = agentNames.get(run.agent_id);
                return (
                  <Button
                    variant="link"
                    className={name ? undefined : 'font-mono'}
                    title={name ?? run.agent_id}
                    onClick={() => onSelectAgent(run.agent_id ?? '')}
                  >
                    {name ?? shortId(run.agent_id)}
                  </Button>
                );
              },
            },
            {
              key: 'iteration',
              header: t('runs.col.iter'),
              hide: 'compact',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => run.iteration ?? '—',
            },
            {
              key: 'cache',
              header: t('runs.col.cacheHit'),
              hide: 'wide',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => cacheHitRateLabel(usageOf(run)),
            },
            {
              key: 'updated',
              header: t('runs.col.updated'),
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => formatTimestamp(run.updated_at),
            },
            {
              key: 'actions',
              header: t('runs.col.actions'),
              cell: (run) =>
                isResumableRun(run.status) ? (
                  <Button
                    size="small"
                    disabled={!connected || busy.has(run.run_id)}
                    title={!connected ? t('common.writesDisabled') : undefined}
                    onClick={() => onResume(run.run_id)}
                  >
                    {busy.has(run.run_id) ? t('runs.resuming') : t('runs.resume')}
                  </Button>
                ) : (
                  <span className="text-muted">—</span>
                ),
            },
          ]}
          rows={windowed.shown as DurableRunSummary[]}
          rowKey={(run) => run.run_id}
          activeKey={activeKey}
        />
      )}

      {windowed.hiddenCount > 0 && (
        <Button
          variant="plain"
          className="mx-auto mt-2 rounded-full px-3.5 py-2 text-xs text-muted"
          onClick={onShowMore}
        >
          {t('common.showMore', { count: windowed.hiddenCount })}
        </Button>
      )}
    </>
  );
}
