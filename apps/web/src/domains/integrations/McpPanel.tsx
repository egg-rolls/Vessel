import { useCallback, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
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
import { Badge, Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t } from '../../i18n';
import { buildMcpPaletteActions } from '../../state/palette-actions';
import { resourceData, useResource } from '../../state/useResource';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function McpPanel() {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('mcp-status');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [reconnectingAll, setReconnectingAll] = useState(false);

  const resource = useResource({
    load: () => client.listMcpServers(),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const servers = useMemo(() => resourceData(resource.state) ?? [], [resource.state]);
  const failed = servers.filter((server) => server.status === 'failed');

  const reconnect = useCallback(
    async (name: string) => {
      if (!connected) {
        toast.error(t('integrations.mcp.reconnectDisconnected'));
        return;
      }
      setBusy((prev) => new Set(prev).add(name));
      try {
        await client.reconnectMcp(name);
        toast.success(t('integrations.mcp.reconnectSuccess', { name }));
        resource.reload();
      } catch (error) {
        toast.error(t('integrations.mcp.reconnectFailed', { name, detail: errorMessage(error) }));
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [client, connected, resource.reload, toast],
  );

  const reconnectAllFailed = useCallback(async () => {
    if (!connected || failed.length === 0) return;
    setReconnectingAll(true);
    let succeeded = 0;
    const failures: string[] = [];
    for (const server of failed) {
      setBusy((prev) => new Set(prev).add(server.name));
      try {
        await client.reconnectMcp(server.name);
        succeeded += 1;
      } catch (error) {
        failures.push(`${server.name}: ${errorMessage(error)}`);
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(server.name);
          return next;
        });
      }
    }
    setReconnectingAll(false);
    resource.reload();
    if (failures.length === 0) {
      toast.success(t('integrations.mcp.reconnectAllSuccess', { count: succeeded }));
    } else if (succeeded === 0) {
      toast.error(t('integrations.mcp.reconnectAllFailed', { detail: failures.join('; ') }));
    } else {
      toast.error(
        t('integrations.mcp.reconnectPartial', {
          count: succeeded,
          detail: failures.join('; '),
        }),
      );
    }
  }, [client, connected, failed, resource.reload, toast]);

  const paletteActions = useMemo(
    () =>
      buildMcpPaletteActions({
        servers,
        reconnect: (name) => void reconnect(name),
      }),
    [servers, reconnect],
  );
  usePaletteEntities('integrations-mcp', paletteActions);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('integrations.mcp.noTokenReason')}
      />
    );
  }
  if (!features.includes('mcp-status')) {
    return (
      <NotEnabledState
        title={t('integrations.mcp.disabledTitle')}
        reason={t('integrations.mcp.disabledReason')}
        hint={t('integrations.mcp.disabledHint')}
      />
    );
  }

  const errorState = resource.state.status === 'error' ? resource.state : null;
  const error = errorState?.error ?? null;

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('integrations.mcp.globalDesc')}
        {tenantId && tenantId !== 'default'
          ? t('integrations.mcp.currentTenant', { tenant: tenantId })
          : ''}
      </p>
      {!connected && servers.length > 0 && <StaleNotice message={t('integrations.mcp.stale')} />}
      {error && servers.length > 0 && (
        <StaleNotice
          message={t('integrations.mcp.staleDetail', { detail: error })}
          onRetry={resource.reload}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge>
          {t('integrations.mcp.counts', { total: servers.length, failed: failed.length })}
        </Badge>
        <Button
          size="small"
          disabled={!connected || failed.length === 0 || reconnectingAll}
          title={!connected ? t('common.writesDisabled') : undefined}
          onClick={() => void reconnectAllFailed()}
        >
          {reconnectingAll
            ? t('integrations.mcp.reconnectAllBusy')
            : t('integrations.mcp.reconnectAll', { count: failed.length })}
        </Button>
        <Button size="small" onClick={resource.reload}>
          {t('common.refresh')}
        </Button>
      </div>

      {error && servers.length === 0 ? (
        // 同 ChannelsPanel：`mcp_disabled` 是「没配 mcp_servers」的配置状态，不是故障。
        errorState?.code === 'mcp_disabled' || errorState?.code === 'not_found' ? (
          <NotEnabledState
            title={t('integrations.mcp.disabledTitle')}
            reason={t('integrations.mcp.disabledReason')}
            hint={t('integrations.mcp.disabledHint')}
          />
        ) : (
          <ErrorState message={error} onRetry={resource.reload} />
        )
      ) : resource.state.status === 'idle' ||
        (resource.state.status === 'loading' && servers.length === 0) ? (
        <LoadingState label={t('integrations.mcp.loading')} />
      ) : servers.length === 0 ? (
        <EmptyState
          title={t('integrations.mcp.emptyTitle')}
          description={t('integrations.mcp.emptyDesc')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <article
              className="flex flex-col gap-1.5 rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border"
              key={server.name}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 wrap-anywhere font-mono text-md font-medium text-ink">
                  {server.name}
                </h3>
                <StatusChip status={server.status} />
              </div>
              <p className="text-sm leading-normal text-muted">
                {t('integrations.mcp.toolsCount', { count: server.tools.length })}
              </p>
              {server.tools.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {server.tools.map((tool) => (
                    <Badge key={tool}>{tool}</Badge>
                  ))}
                </div>
              )}
              {server.error && (
                <p className="text-danger" role="alert">
                  {server.error}
                </p>
              )}
              {server.status === 'failed' && (
                <Button
                  size="small"
                  className="mt-1 self-start"
                  disabled={!connected || busy.has(server.name)}
                  title={!connected ? t('common.writesDisabled') : undefined}
                  onClick={() => void reconnect(server.name)}
                >
                  {busy.has(server.name)
                    ? t('integrations.mcp.reconnecting')
                    : t('integrations.mcp.reconnect')}
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
