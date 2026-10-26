/**
 * Observe → Diagnostics：runtime 队列与诊断级错误（0.15 E6）。
 *
 * process/shutdown/hook/plugin 错误受 `ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 控制；队列来自 `health.get.runtime`。
 */
import { useMemo } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, DataTable, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { RunEvent, SchedulerRunSummary } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { diagnosticEntries, includesDiagnostics, runtimeQueueRows } from '../../state/diagnostics';
import { resourceData } from '../../state/useResource';
import { resolveShowProcessErrors, resolveUiVisibility } from '../../state/visibility';
import { useNodeDiagnostics, useRunStore } from '../../stores/runStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { usePolledAction } from '../../stores/usePolledAction';

function formatTime(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString();
}

export function DiagnosticsView() {
  useLocale();
  const { client, connectionState, hasToken, epoch } = useConnection();
  const { current } = useNodes();
  const connected = hasToken && connectionState === 'open';
  const loadDiagnostics = useRunStore((state) => state.loadDiagnostics);
  const diagnostics = useNodeDiagnostics(current);
  const healthState = diagnostics?.health;
  const eventsState = diagnostics?.events;
  const nodeKey = current ? nodeKeyOf(current) : '';
  const { config, reloadConfig } = useConfigStoreApi();

  const reloadHealth = () => {
    if (current && connected) void loadDiagnostics(client, current, 'health');
  };
  const reloadEvents = () => {
    if (current && connected) void loadDiagnostics(client, current, 'events');
  };
  const reloadAll = () => {
    if (current && connected) void loadDiagnostics(client, current, 'both');
  };

  // Health polls every 5s; diagnostic events only refresh on mount / epoch /
  // explicit refresh (same cadence as the previous per-panel resources).
  usePolledAction(reloadHealth, {
    enabled: connected && current !== null,
    deps: [epoch, nodeKey],
    pollMs: 5000,
  });
  usePolledAction(reloadEvents, {
    enabled: connected && current !== null,
    deps: [epoch, nodeKey],
  });
  useRefreshSignal(() => {
    reloadAll();
    reloadConfig();
  });

  const gate = useMemo(() => {
    const visibility = resolveUiVisibility(resourceData(config));
    return {
      errorLevel: visibility.errorLevel,
      showProcessErrors: resolveShowProcessErrors(resourceData(config)),
    };
  }, [config]);
  const includeDiagnostics = includesDiagnostics(gate);
  const entries = useMemo(
    () => diagnosticEntries((resourceData(eventsState) ?? []) as RunEvent[], gate),
    [eventsState, gate],
  );
  const queue = useMemo(() => runtimeQueueRows(resourceData(healthState)?.runtime), [healthState]);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('observe.diagnostics.noToken')}
        reason={t('observe.diagnostics.noTokenReason')}
      />
    );
  }

  const healthError = healthState?.status === 'error' ? healthState.error : null;
  const eventsError = eventsState?.status === 'error' ? eventsState.error : null;

  return (
    <div className="flex flex-col gap-6">
      {!connected && <p className="text-muted">{t('observe.diagnostics.disconnected')}</p>}
      {healthError && <ErrorState message={healthError} onRetry={reloadHealth} />}
      {eventsError && <ErrorState message={eventsError} onRetry={reloadEvents} />}

      <Section
        title={t('observe.diagnostics.queueTitle')}
        actions={
          <Button size="small" onClick={reloadHealth}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {!healthState || healthState.status === 'loading' ? (
          <LoadingState label={t('observe.diagnostics.loading')} rows={2} />
        ) : queue.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.queueEmpty')} />
        ) : (
          <DataTable<SchedulerRunSummary>
            columns={[
              {
                key: 'run',
                header: 'run',
                cellClassName: 'font-mono',
                cell: (row) => row.run_id,
              },
              {
                key: 'status',
                header: t('observe.diagnostics.col.status'),
                cell: (row) => row.status,
              },
              {
                key: 'session',
                header: t('observe.diagnostics.col.session'),
                cellClassName: 'font-mono',
                cell: (row) => row.session_id ?? '—',
              },
              {
                key: 'queuePosition',
                header: t('observe.diagnostics.col.queuePosition'),
                cell: (row) => row.queue_position ?? '—',
              },
              {
                key: 'waitReason',
                header: t('observe.diagnostics.col.waitReason'),
                cell: (row) => row.wait_reason ?? t('observe.diagnostics.noWaitReason'),
              },
            ]}
            rows={queue}
            rowKey={(row) => `${row.status}:${row.run_id}`}
          />
        )}
        {resourceData(healthState)?.runtime && (
          <p className="text-muted">
            {t('observe.diagnostics.activeRun')}:{' '}
            <span className="font-mono">
              {resourceData(healthState)?.runtime?.active_run_id ?? '—'}
            </span>{' '}
            ·{' '}
            {t('observe.diagnostics.stats', {
              queued: resourceData(healthState)?.runtime?.scheduler.stats.queued ?? 0,
              running: resourceData(healthState)?.runtime?.scheduler.stats.running ?? 0,
            })}
          </p>
        )}
      </Section>

      <Section
        title={t('observe.diagnostics.errorsTitle')}
        actions={
          <Button size="small" onClick={reloadEvents}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {!includeDiagnostics && <p className="text-muted">{t('observe.diagnostics.gateHint')}</p>}
        {entries.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.empty')} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-md">
            {entries.map((entry) => (
              <li key={`${entry.type}:${entry.run_id}:${entry.ts}`}>
                <span className="text-muted">{formatTime(entry.ts)}</span>{' '}
                <span className="font-mono">{entry.type}</span>{' '}
                <span className="text-muted">[{entry.category}]</span>
                {entry.errorCode && <span className="font-mono"> · {entry.errorCode}</span>}
                {entry.phase && <span className="text-muted"> · {entry.phase}</span>}
                {entry.retryable !== undefined && (
                  <span className="text-muted">
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
                <span className="font-mono text-muted">{entry.run_id}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
