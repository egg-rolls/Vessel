/**
 * Runs 列表：live / durable 两张只读表格与「显示更多」。
 *
 * 纯展示；取消/恢复/打开等动作由容器注入。
 */

import { StatusChip } from '../../components/StatusChip';
import { Button, DataTable } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { DurableRunSummary, RunStatus } from '../../gateway/types';
import { t } from '../../i18n';
import { isCancellableRun, isResumableRun, runAgentId } from '../../state/runs';

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

export function RunsTable({
  tab,
  windowed,
  connected,
  busy,
  activeKey,
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
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onOpenRun: (runId: string, sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onShowMore: () => void;
}) {
  return (
    <>
      {tab === 'live' ? (
        <DataTable<RunStatus>
          columns={[
            {
              key: 'status',
              header: t('runs.col.state'),
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
              key: 'runId',
              header: t('runs.col.runId'),
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  onClick={() => onOpenRun(run.run_id, run.session_id)}
                >
                  {run.run_id.slice(0, 16)}
                </Button>
              ),
            },
            {
              key: 'session',
              header: t('runs.col.session'),
              hide: 'compact',
              cellClassName: 'font-mono',
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  onClick={() => onOpenSession(run.session_id)}
                >
                  {run.session_id.slice(0, 12)}
                </Button>
              ),
            },
            {
              key: 'agent',
              header: t('runs.col.agent'),
              hide: 'wide',
              cellClassName: 'font-mono',
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  title={t('runs.filterByAgent')}
                  onClick={() => onSelectAgent(runAgentId(run) ?? '')}
                >
                  {runAgentId(run) ?? '—'}
                </Button>
              ),
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
              key: 'status',
              header: t('runs.col.state'),
              cell: (run) => <StatusChip status={run.status} />,
            },
            {
              key: 'runId',
              header: t('runs.col.runId'),
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  onClick={() => onOpenRun(run.run_id, run.session_id)}
                >
                  {run.run_id.slice(0, 16)}
                </Button>
              ),
            },
            {
              key: 'session',
              header: t('runs.col.session'),
              hide: 'compact',
              cellClassName: 'font-mono',
              cell: (run) => (
                <Button
                  variant="link"
                  className="font-mono"
                  onClick={() => onOpenSession(run.session_id)}
                >
                  {run.session_id.slice(0, 12)}
                </Button>
              ),
            },
            {
              key: 'agent',
              header: t('runs.col.agent'),
              hide: 'wide',
              cellClassName: 'font-mono',
              cell: (run) => run.agent_id ?? '—',
            },
            {
              key: 'iteration',
              header: t('runs.col.iter'),
              hide: 'compact',
              cellClassName: 'font-mono tabular-nums',
              cell: (run) => run.iteration ?? '—',
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
