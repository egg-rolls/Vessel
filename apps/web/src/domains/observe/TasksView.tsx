/**
 * Observe → Tasks：只读任务板（tasks.list）与 canonical agent 树（agents.tree）。
 *
 * 0.15 不提供控制动作（pause / reassign / claim）；只读展示。
 */
import { useMemo } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, DataTable, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TaskEntry } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { flattenAgentCards, sortTasks } from '../../state/tasks';
import { resourceData, useResource } from '../../state/useResource';

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString();
}

export function TasksView() {
  useLocale();
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';

  const tasks = useResource({
    load: () => client.listTasks(),
    enabled: connected,
    deps: [epoch],
    pollMs: 5000,
  });
  const agents = useResource({
    load: () => client.listAgentsTree(),
    enabled: connected,
    deps: [epoch],
    pollMs: 5000,
  });
  useRefreshSignal(() => {
    tasks.reload();
    agents.reload();
  });

  const taskRows = useMemo(() => sortTasks(resourceData(tasks.state) ?? []), [tasks.state]);
  const agentRows = useMemo(
    () => flattenAgentCards(resourceData(agents.state)?.nodes ?? []),
    [agents.state],
  );

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('observe.tasks.noToken')}
        reason={t('observe.tasks.noTokenReason')}
      />
    );
  }

  const tasksError = tasks.state.status === 'error' ? tasks.state.error : null;
  const agentsError = agents.state.status === 'error' ? agents.state.error : null;
  const loaded = resourceData(tasks.state) !== undefined;

  return (
    <div className="flex flex-col gap-6">
      {!connected && <p className="text-muted">{t('observe.tasks.disconnected')}</p>}
      {tasksError && <ErrorState message={tasksError} onRetry={tasks.reload} />}
      {agentsError && <ErrorState message={agentsError} onRetry={agents.reload} />}

      <Section
        title={t('observe.tasks.title')}
        actions={
          <Button size="small" onClick={tasks.reload}>
            {t('observe.tasks.refresh')}
          </Button>
        }
      >
        <p className="text-muted">{t('observe.tasks.readonly')}</p>
        {!loaded ? (
          <LoadingState label={t('observe.tasks.loading')} rows={2} />
        ) : taskRows.length === 0 ? (
          <EmptyState title={t('observe.tasks.empty')} />
        ) : (
          <DataTable<TaskEntry>
            columns={[
              {
                key: 'id',
                header: t('observe.tasks.col.id'),
                cellClassName: 'font-mono',
                cell: (task) => task.id,
              },
              {
                key: 'title',
                header: t('observe.tasks.col.title'),
                cell: (task) => task.title,
              },
              {
                key: 'assignee',
                header: t('observe.tasks.col.assignee'),
                cellClassName: 'font-mono',
                cell: (task) => task.assignee,
              },
              {
                key: 'status',
                header: t('observe.tasks.col.status'),
                cell: (task) => task.status,
              },
              {
                key: 'parent',
                header: t('observe.tasks.col.parent'),
                cellClassName: 'font-mono',
                cell: (task) => task.parent_task ?? '—',
              },
              {
                key: 'artifacts',
                header: t('observe.tasks.col.artifacts'),
                cellClassName: 'font-mono',
                cell: (task) => task.artifact_refs.join(', ') || '—',
              },
              {
                key: 'since',
                header: t('observe.tasks.col.since'),
                cellClassName: 'text-muted',
                cell: (task) => formatTime(task.since),
              },
            ]}
            rows={taskRows}
            rowKey={(task) => task.id}
          />
        )}
      </Section>

      <Section
        title={t('observe.tasks.agentsTitle')}
        actions={
          <Button size="small" onClick={agents.reload}>
            {t('observe.tasks.refresh')}
          </Button>
        }
      >
        {agentRows.length === 0 ? (
          <EmptyState title={t('observe.tasks.agentsEmpty')} />
        ) : (
          <ul className="mt-2.5 grid grid-cols-[minmax(90px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-md">
            {agentRows.map(({ card, depth }) => (
              <li key={card.id} style={{ paddingLeft: `${depth * 16}px` }}>
                <span className="font-mono">{card.id}</span>{' '}
                <span className="text-muted">[{card.state}]</span>
                {card.task && <span> · {card.task}</span>}
                {card.queue_position !== undefined && (
                  <span className="text-muted">
                    {' '}
                    · {t('observe.tasks.queuePosition', { position: card.queue_position })}
                  </span>
                )}
                {card.wait_reason && <span className="text-muted"> · {card.wait_reason}</span>}
                {card.context_max !== undefined && card.context_used !== undefined && (
                  <span className="text-muted">
                    {' '}
                    ·{' '}
                    {t('observe.tasks.context', {
                      used: card.context_used,
                      max: card.context_max,
                    })}
                  </span>
                )}
                {card.children_count > 0 && (
                  <span className="text-muted">
                    {' '}
                    · {t('observe.tasks.children', { count: card.children_count })}
                  </span>
                )}
                {card.last_seen !== undefined && (
                  <span className="text-muted"> · {formatTime(card.last_seen)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
