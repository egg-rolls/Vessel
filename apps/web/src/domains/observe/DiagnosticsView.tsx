/**
 * Observe → Diagnostics：runtime 摘要、队列、MCP / 插件 / 能力 / 配置来源
 * 与诊断级错误（0.15 E6；0.29 补齐 doctor 的远程可观测子集）。
 *
 * process/shutdown/hook/plugin 错误受 `ui.errorLevel: all` 或
 * `observability.showProcessErrors: true` 控制；队列来自 `health.get.runtime`。
 * 只复用既有 RPC：health.get / capabilities.list / mcp.list / config.sources。
 */
import { useMemo } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { EmptyState, ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { Badge, Button, DataTable, KeyValueList, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type {
  McpServerState,
  McpServerStatus,
  RunEvent,
  SchedulerRunSummary,
} from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { diagnosticEntries, includesDiagnostics, runtimeQueueRows } from '../../state/diagnostics';
import { resourceData, useResource } from '../../state/useResource';
import { resolveShowProcessErrors, resolveUiVisibility } from '../../state/visibility';
import { useNodeDiagnostics, useRunStore } from '../../stores/runStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { usePolledAction } from '../../stores/usePolledAction';
import { DoctorChecksSection } from './DoctorChecksSection';

function formatTime(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString();
}

/** 进程运行时长：只在 UI 层格式化，不引入新的 RPC 字段。 */
function formatUptime(startedAt: number | undefined): string {
  if (startedAt === undefined) return '—';
  const elapsed = Date.now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return '—';
  const totalSeconds = Math.floor(elapsed / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function mcpTone(status: McpServerState): 'success' | 'danger' | 'neutral' {
  if (status === 'connected') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

export function DiagnosticsView() {
  useLocale();
  const { client, connectionState, hasToken, epoch, gatewayUrl } = useConnection();
  const { current } = useNodes();
  const connected = hasToken && connectionState === 'open';
  const loadDiagnostics = useRunStore((state) => state.loadDiagnostics);
  const diagnostics = useNodeDiagnostics(current);
  const healthState = diagnostics?.health;
  const eventsState = diagnostics?.events;
  const nodeKey = current ? nodeKeyOf(current) : '';
  const { config, sources, capabilities, reloadConfig, reloadSources, reloadCapabilities } =
    useConfigStoreApi({ capabilities: true, sources: true });

  const reloadHealth = () => {
    if (current && connected) void loadDiagnostics(client, current, 'health');
  };
  const reloadEvents = () => {
    if (current && connected) void loadDiagnostics(client, current, 'events');
  };
  const reloadAll = () => {
    if (current && connected) void loadDiagnostics(client, current, 'both');
  };

  // Health polls every 5s; MCP status every 10s; diagnostic events only refresh
  // on mount / epoch / explicit refresh (same cadence as the previous panels).
  usePolledAction(reloadHealth, {
    enabled: connected && current !== null,
    deps: [epoch, nodeKey],
    pollMs: 5000,
  });
  usePolledAction(reloadEvents, {
    enabled: connected && current !== null,
    deps: [epoch, nodeKey],
  });
  const mcp = useResource({
    load: () => client.listMcpServers(),
    enabled: connected && current !== null,
    pollMs: 10_000,
    deps: [epoch, nodeKey],
  });
  const refreshAll = () => {
    reloadAll();
    reloadConfig();
    reloadSources();
    reloadCapabilities();
    mcp.reload();
  };
  useRefreshSignal(refreshAll);

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

  const health = resourceData(healthState);
  const runtime = health?.runtime;
  const mcpServers = useMemo(() => resourceData(mcp.state) ?? [], [mcp.state]);
  const mcpError = mcp.state.status === 'error' ? mcp.state : null;
  const mcpNotEnabled = mcpError?.code === 'not_found' || mcpError?.code === 'mcp_disabled';
  const manifest = resourceData(capabilities);
  const enabledPlugins = useMemo(
    () => (manifest ? manifest.plugins.filter((plugin) => plugin.enabled) : []),
    [manifest],
  );
  const sourcesData = resourceData(sources);
  const configData = resourceData(config);
  const sourcesError = sources.status === 'error' ? sources : null;
  const sourcesUnavailable =
    sourcesError?.code === 'not_found' ||
    sourcesError?.code === 'method_not_allowed' ||
    sourcesError?.code === 'not_supported';
  const overlayKeys = sourcesData?.tenant_overlay_keys ?? configData?.tenant_overlay_keys ?? [];

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
  const capabilitiesError = capabilities.status === 'error' ? capabilities.error : null;

  return (
    <div className="flex flex-col gap-6">
      {!connected && <p className="text-muted">{t('observe.diagnostics.disconnected')}</p>}
      {healthError && <ErrorState message={healthError} onRetry={reloadHealth} />}
      {eventsError && <ErrorState message={eventsError} onRetry={reloadEvents} />}

      <DoctorChecksSection
        config={config}
        sources={sources}
        health={healthState}
        capabilities={capabilities}
        mcp={mcp.state}
        gatewayUrl={gatewayUrl}
        connected={connected}
        onRefresh={refreshAll}
      />

      <Section
        title={t('observe.diagnostics.runtimeTitle')}
        actions={
          <Button size="small" onClick={reloadHealth}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {!health ? (
          healthError ? (
            <p className="text-muted">{healthError}</p>
          ) : (
            <LoadingState label={t('observe.diagnostics.loading')} rows={2} />
          )
        ) : (
          <KeyValueList
            items={[
              {
                key: 'status',
                label: t('observe.diagnostics.nodeStatus'),
                value: <span className="font-mono">{health.node.status}</span>,
              },
              {
                key: 'provider',
                label: t('observe.diagnostics.provider'),
                value: (
                  <span className="font-mono">{health.node.capabilities.provider ?? '—'}</span>
                ),
              },
              {
                key: 'model',
                label: t('observe.diagnostics.model'),
                value: <span className="font-mono">{health.node.capabilities.model ?? '—'}</span>,
              },
              {
                key: 'uptime',
                label: t('observe.diagnostics.uptime'),
                value: <span className="font-mono">{formatUptime(health.started_at)}</span>,
              },
              {
                key: 'clients',
                label: t('observe.diagnostics.clients'),
                value: <span className="font-mono">{health.clients}</span>,
              },
              {
                key: 'activeRun',
                label: t('observe.diagnostics.activeRun'),
                value: <span className="font-mono">{runtime?.active_run_id ?? '—'}</span>,
              },
            ]}
          />
        )}
      </Section>

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
        title={t('observe.diagnostics.mcpTitle')}
        actions={
          <Button size="small" onClick={mcp.reload}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {mcpNotEnabled ? (
          <NotEnabledState
            title={t('observe.diagnostics.mcpNotEnabled')}
            reason={t('observe.diagnostics.mcpNotEnabledReason')}
          />
        ) : mcpError ? (
          <ErrorState message={mcpError.error} onRetry={mcp.reload} />
        ) : (mcp.state.status === 'idle' || mcp.state.status === 'loading') &&
          mcpServers.length === 0 ? (
          <LoadingState label={t('common.loading')} rows={2} />
        ) : mcpServers.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.mcpEmpty')} />
        ) : (
          <DataTable<McpServerStatus>
            columns={[
              {
                key: 'name',
                header: t('observe.diagnostics.col.mcpServer'),
                cellClassName: 'font-mono',
                cell: (row) => row.name,
              },
              {
                key: 'status',
                header: t('observe.diagnostics.col.mcpStatus'),
                cell: (row) => <Badge tone={mcpTone(row.status)}>{row.status}</Badge>,
              },
              {
                key: 'tools',
                header: t('observe.diagnostics.col.mcpTools'),
                cell: (row) =>
                  row.tools.length === 0 ? (
                    '0'
                  ) : (
                    <>
                      <span className="font-mono">{row.tools.length}</span>{' '}
                      <span className="text-muted">{row.tools.join(', ')}</span>
                    </>
                  ),
              },
              {
                key: 'error',
                header: t('observe.diagnostics.col.mcpError'),
                cell: (row) => (row.error ? <span className="text-danger">{row.error}</span> : '—'),
              },
            ]}
            rows={mcpServers}
            rowKey={(row) => row.name}
          />
        )}
      </Section>

      <Section
        title={t('observe.diagnostics.pluginsTitle')}
        actions={
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {manifest && (
              <Badge>
                {t('observe.diagnostics.pluginsCount', {
                  enabled: enabledPlugins.length,
                  total: manifest.plugins.length,
                })}
              </Badge>
            )}
            <Button size="small" onClick={reloadCapabilities}>
              {t('observe.diagnostics.refresh')}
            </Button>
          </div>
        }
      >
        {!manifest ? (
          capabilitiesError ? (
            <ErrorState message={capabilitiesError} onRetry={reloadCapabilities} />
          ) : (
            <LoadingState label={t('common.loading')} rows={2} />
          )
        ) : enabledPlugins.length === 0 ? (
          <EmptyState title={t('observe.diagnostics.pluginsEmpty')} />
        ) : (
          <ul className="plain-list">
            {enabledPlugins.map((plugin) => (
              <li key={plugin.name}>
                <span className="font-mono">{plugin.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('observe.diagnostics.capabilitiesTitle')}
        actions={
          <Button size="small" onClick={reloadCapabilities}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {!manifest ? (
          capabilitiesError ? (
            <ErrorState message={capabilitiesError} onRetry={reloadCapabilities} />
          ) : (
            <LoadingState label={t('common.loading')} rows={2} />
          )
        ) : (
          <KeyValueList
            items={[
              {
                key: 'version',
                label: t('observe.diagnostics.version'),
                value: <span className="font-mono">{manifest.version}</span>,
              },
              {
                key: 'methods',
                label: t('observe.diagnostics.methods'),
                value: <span className="font-mono">{manifest.methods.length}</span>,
              },
              {
                key: 'tools',
                label: t('observe.diagnostics.tools'),
                value: <span className="font-mono">{manifest.tools.length}</span>,
              },
            ]}
          />
        )}
      </Section>

      <Section
        title={t('observe.diagnostics.sourcesTitle')}
        actions={
          <Button size="small" onClick={reloadSources}>
            {t('observe.diagnostics.refresh')}
          </Button>
        }
      >
        {!sourcesData && !configData ? (
          sourcesError && !sourcesUnavailable ? (
            <ErrorState message={sourcesError.error} onRetry={reloadSources} />
          ) : (
            <LoadingState label={t('common.loading')} rows={2} />
          )
        ) : (
          <>
            <KeyValueList
              items={[
                {
                  key: 'user',
                  label: t('observe.diagnostics.userPath'),
                  value: <span className="font-mono">{configData?.paths.user || '—'}</span>,
                },
                {
                  key: 'project',
                  label: t('observe.diagnostics.projectPath'),
                  value: <span className="font-mono">{configData?.paths.project || '—'}</span>,
                },
                {
                  key: 'overlay',
                  label: t('observe.diagnostics.overlayKeys'),
                  value: (
                    <span className="font-mono">
                      {overlayKeys.length > 0 ? overlayKeys.join(', ') : '—'}
                    </span>
                  ),
                },
              ]}
            />
            {sourcesUnavailable && (
              <p className="text-muted">{t('observe.diagnostics.notAvailable')}</p>
            )}
            {sourcesError && !sourcesUnavailable && (
              <p className="text-muted">{sourcesError.error}</p>
            )}
          </>
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
