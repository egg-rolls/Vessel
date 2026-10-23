/**
 * Observe → Tasks：只读任务板（tasks.list）与 canonical agent 树（agents.tree）。
 *
 * 0.15 不提供控制动作（pause / reassign / claim）；只读展示。
 */
import { useMemo } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
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
    <div className="settings-section">
      {!connected && <p className="dim">{t('observe.tasks.disconnected')}</p>}
      {tasksError && <ErrorState message={tasksError} onRetry={tasks.reload} />}
      {agentsError && <ErrorState message={agentsError} onRetry={agents.reload} />}

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('observe.tasks.title')}</h2>
          <button type="button" className="btn btn-small" onClick={tasks.reload}>
            {t('observe.tasks.refresh')}
          </button>
        </div>
        <p className="dim">{t('observe.tasks.readonly')}</p>
        {!loaded ? (
          <LoadingState label={t('observe.tasks.loading')} rows={2} />
        ) : taskRows.length === 0 ? (
          <EmptyState title={t('observe.tasks.empty')} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('observe.tasks.col.id')}</th>
                <th>{t('observe.tasks.col.title')}</th>
                <th>{t('observe.tasks.col.assignee')}</th>
                <th>{t('observe.tasks.col.status')}</th>
                <th>{t('observe.tasks.col.parent')}</th>
                <th>{t('observe.tasks.col.artifacts')}</th>
                <th>{t('observe.tasks.col.since')}</th>
              </tr>
            </thead>
            <tbody>
              {taskRows.map((task) => (
                <tr key={task.id}>
                  <td className="mono">{task.id}</td>
                  <td>{task.title}</td>
                  <td className="mono">{task.assignee}</td>
                  <td>{task.status}</td>
                  <td className="mono">{task.parent_task ?? '—'}</td>
                  <td className="mono">{task.artifact_refs.join(', ') || '—'}</td>
                  <td className="dim">{formatTime(task.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('observe.tasks.agentsTitle')}</h2>
          <button type="button" className="btn btn-small" onClick={agents.reload}>
            {t('observe.tasks.refresh')}
          </button>
        </div>
        {agentRows.length === 0 ? (
          <EmptyState title={t('observe.tasks.agentsEmpty')} />
        ) : (
          <ul className="diag-list">
            {agentRows.map(({ card, depth }) => (
              <li key={card.id} style={{ paddingLeft: `${depth * 16}px` }}>
                <span className="mono">{card.id}</span> <span className="dim">[{card.state}]</span>
                {card.task && <span> · {card.task}</span>}
                {card.queue_position !== undefined && (
                  <span className="dim">
                    {' '}
                    · {t('observe.tasks.queuePosition', { position: card.queue_position })}
                  </span>
                )}
                {card.wait_reason && <span className="dim"> · {card.wait_reason}</span>}
                {card.context_max !== undefined && card.context_used !== undefined && (
                  <span className="dim">
                    {' '}
                    ·{' '}
                    {t('observe.tasks.context', {
                      used: card.context_used,
                      max: card.context_max,
                    })}
                  </span>
                )}
                {card.children_count > 0 && (
                  <span className="dim">
                    {' '}
                    · {t('observe.tasks.children', { count: card.children_count })}
                  </span>
                )}
                {card.last_seen !== undefined && (
                  <span className="dim"> · {formatTime(card.last_seen)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
