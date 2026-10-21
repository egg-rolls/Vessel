/**
 * Observe → Diagnostics：runtime 队列与诊断级错误（0.15 E6）。
 *
 * process/shutdown/hook/plugin 错误受 `ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 控制；队列来自 `health.get.runtime`。
 */
import { useMemo } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { RunEvent } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import {
  DIAGNOSTIC_EVENT_TYPES,
  diagnosticEntries,
  includesDiagnostics,
  runtimeQueueRows,
} from '../../state/diagnostics';
import { resourceData, useResource } from '../../state/useResource';
import { resolveShowProcessErrors, resolveUiVisibility } from '../../state/visibility';

function formatTime(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString();
}

export function DiagnosticsView() {
  useLocale();
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';

  const health = useResource({
    load: () => client.getHealth(),
    enabled: connected,
    deps: [epoch],
    pollMs: 5000,
  });
  const config = useResource({
    load: () => client.getConfig(),
    enabled: connected,
    deps: [epoch],
  });
  const events = useResource({
    load: () => client.readEvents({ types: [...DIAGNOSTIC_EVENT_TYPES], limit: 200 }),
    enabled: connected,
    deps: [epoch],
  });
  useRefreshSignal(() => {
    health.reload();
    config.reload();
    events.reload();
  });

  const gate = useMemo(() => {
    const visibility = resolveUiVisibility(resourceData(config.state));
    return {
      errorLevel: visibility.errorLevel,
      showProcessErrors: resolveShowProcessErrors(resourceData(config.state)),
    };
  }, [config.state]);
  const includeDiagnostics = includesDiagnostics(gate);
  const entries = useMemo(
    () => diagnosticEntries((resourceData(events.state) ?? []) as RunEvent[], gate),
    [events.state, gate],
  );
  const queue = useMemo(
    () => runtimeQueueRows(resourceData(health.state)?.runtime),
    [health.state],
  );

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('observe.diagnostics.noToken')}
        reason={t('observe.diagnostics.noTokenReason')}
      />
    );
  }

  const healthError = health.state.status === 'error' ? health.state.error : null;
  const eventsError = events.state.status === 'error' ? events.state.error : null;

  return (
    <div className="settings-section">
      {!connected && <p className="dim">{t('observe.diagnostics.disconnected')}</p>}
      {healthError && <ErrorState message={healthError} onRetry={health.reload} />}
      {eventsError && <ErrorState message={eventsError} onRetry={events.reload} />}

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('observe.diagnostics.queueTitle')}</h2>
          <button type="button" className="btn btn-small" onClick={health.reload}>
            {t('observe.diagnostics.refresh')}
          </button>
        </div>
        {!health.state || health.state.status === 'loading' ? (
          <LoadingState label={t('observe.diagnostics.loading')} rows={2} />
        ) : queue.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.queueEmpty')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>run</th>
                <th>{t('observe.diagnostics.col.status')}</th>
                <th>{t('observe.diagnostics.col.session')}</th>
                <th>{t('observe.diagnostics.col.queuePosition')}</th>
                <th>{t('observe.diagnostics.col.waitReason')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={`${row.status}:${row.run_id}`}>
                  <td className="mono">{row.run_id}</td>
                  <td>{row.status}</td>
                  <td className="mono">{row.session_id ?? '—'}</td>
                  <td>{row.queue_position ?? '—'}</td>
                  <td>{row.wait_reason ?? t('observe.diagnostics.noWaitReason')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {resourceData(health.state)?.runtime && (
          <p className="dim">
            {t('observe.diagnostics.activeRun')}:{' '}
            <span className="mono">
              {resourceData(health.state)?.runtime?.active_run_id ?? '—'}
            </span>{' '}
            ·{' '}
            {t('observe.diagnostics.stats', {
              queued: resourceData(health.state)?.runtime?.scheduler.stats.queued ?? 0,
              running: resourceData(health.state)?.runtime?.scheduler.stats.running ?? 0,
            })}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('observe.diagnostics.errorsTitle')}</h2>
          <button type="button" className="btn btn-small" onClick={events.reload}>
            {t('observe.diagnostics.refresh')}
          </button>
        </div>
        {!includeDiagnostics && <p className="dim">{t('observe.diagnostics.gateHint')}</p>}
        {entries.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.empty')} />
        ) : (
          <ul className="diag-list diag-errors">
            {entries.map((entry) => (
              <li key={`${entry.type}:${entry.run_id}:${entry.ts}`}>
                <span className="dim">{formatTime(entry.ts)}</span>{' '}
                <span className="mono">{entry.type}</span>{' '}
                <span className="dim">[{entry.category}]</span>
                {entry.errorCode && <span className="mono"> · {entry.errorCode}</span>}
                {entry.phase && <span className="dim"> · {entry.phase}</span>}
                {entry.retryable !== undefined && (
                  <span className="dim">
                    {' '}
                    ·{' '}
                    {t(
                      entry.retryable
                        ? 'observe.diagnostics.retryable'
                        : 'observe.diagnostics.fatal',
                    )}
                  </span>
                )}
                {entry.message && <div>{entry.message}</div>}
                <span className="mono dim">{entry.run_id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
