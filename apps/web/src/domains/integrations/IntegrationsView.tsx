import { useCallback, useId, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import { JsonView } from '../../components/JsonView';
import { PageHeader } from '../../components/PageHeader';
import { usePaletteEntities } from '../../components/PaletteEntities';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { StatusChip, statusLabel } from '../../components/StatusChip';
import { SegmentedTabs } from '../../components/Tabs';
import { useToast } from '../../components/ToastProvider';
import { Badge, Button, KeyValueList, SearchInput, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { buildMcpPaletteActions } from '../../state/palette-actions';
import { resourceData, useResource } from '../../state/useResource';

type IntegrationsRoute = Extract<Route, { domain: 'integrations' }>;
type Tab = IntegrationsRoute['tab'];

const TABS: readonly { id: Tab; labelKey: string }[] = [
  { id: 'tools', labelKey: 'integrations.tab.tools' },
  { id: 'mcp', labelKey: 'integrations.tab.mcp' },
  { id: 'channels', labelKey: 'integrations.tab.channels' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `mcp__<server>__<tool>` → server 名；普通工具返回 undefined。 */
export function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
}

export function IntegrationsView({
  route,
  navigate,
}: {
  route: IntegrationsRoute;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { tenantId } = useConnection();
  return (
    <div className="domain-view">
      <PageHeader
        title={t('integrations.title')}
        description={t('integrations.description')}
        tenantId={tenantId}
      />
      <SegmentedTabs
        label={t('integrations.tabsLabel')}
        tabs={TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }))}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'integrations', tab })}
        panelId="integrations-panel"
      />
      <div
        className="domain-content"
        id="integrations-panel"
        role="tabpanel"
        aria-label={t('integrations.panelLabel')}
      >
        {route.tab === 'tools' && <ToolsPanel />}
        {route.tab === 'mcp' && <McpPanel />}
        {route.tab === 'channels' && <ChannelsPanel />}
      </div>
    </div>
  );
}

function ToolsPanel() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [query, setQuery] = useState('');
  const [onlyConfirm, setOnlyConfirm] = useState(false);
  /** 只影响展示；搜索 / 过滤始终基于 name + description。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const panelBaseId = useId();
  const toggleTool = (name: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const resource = useResource({
    load: () => client.listTools(),
    enabled: hasToken,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const tools = useMemo(() => resourceData(resource.state) ?? [], [resource.state]);
  const confirmCount = useMemo(
    () => tools.filter((tool) => tool.has_permission_check).length,
    [tools],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (onlyConfirm && !tool.has_permission_check) return false;
      if (!needle) return true;
      return (
        tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
      );
    });
  }, [tools, query, onlyConfirm]);
  const error = resource.state.status === 'error' ? resource.state.error : null;

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('integrations.tools.noTokenReason')}
      />
    );
  }
  if (error && tools.length === 0) {
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (
    resource.state.status === 'idle' ||
    (resource.state.status === 'loading' && tools.length === 0)
  ) {
    return <LoadingState label={t('integrations.tools.loading')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {!connected && tools.length > 0 && (
        <StaleNotice message={t('integrations.tools.stale')} onRetry={resource.reload} />
      )}
      {error && tools.length > 0 && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('integrations.tools.searchPlaceholder')}
          ariaLabel={t('integrations.tools.searchLabel')}
          className="grow basis-60 max-w-search"
        />
        <Button
          variant="chip"
          size="small"
          aria-pressed={onlyConfirm}
          onClick={() => setOnlyConfirm((value) => !value)}
        >
          {t('integrations.tools.onlyConfirm', { count: confirmCount })}
        </Button>
        <span className="ml-1.5 inline-block rounded-full bg-sunken px-1.5 py-0.5 font-mono text-xs text-muted">
          {filtered.length}/{tools.length}
        </span>
      </div>
      {tools.length === 0 ? (
        <EmptyState title={t('integrations.tools.empty')} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={t('integrations.tools.noMatch')}
          action={
            <Button
              onClick={() => {
                setQuery('');
                setOnlyConfirm(false);
              }}
            >
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((tool, index) => {
            const server = mcpServerOf(tool.name);
            const open = expanded.has(tool.name);
            const panelId = `${panelBaseId}-tool-${index}`;
            return (
              <article
                className="flex flex-col overflow-visible rounded-md bg-raised shadow-elev-1"
                key={tool.name}
              >
                <button
                  type="button"
                  className="flex min-h-control w-full items-center gap-2 rounded-md px-3 py-2 text-left text-muted hover:bg-hover pointer-coarse:min-h-touch"
                  aria-expanded={open}
                  aria-controls={open ? panelId : undefined}
                  onClick={() => toggleTool(tool.name)}
                >
                  <span className="min-w-0 break-words font-mono text-sm font-medium text-ink">
                    {tool.name}
                  </span>
                  {tool.has_permission_check && (
                    <Badge tone="warn" title={t('integrations.tools.needsConfirm')}>
                      {t('integrations.tools.badgeConfirm')}
                    </Badge>
                  )}
                  {server && <Badge>MCP · {server}</Badge>}
                  <span
                    className="ml-auto flex-none font-mono text-sm leading-none text-faint"
                    aria-hidden="true"
                  >
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="sr-only">
                    {open
                      ? t('integrations.tools.collapse', { name: tool.name })
                      : t('integrations.tools.expand', { name: tool.name })}
                  </span>
                </button>
                {open && (
                  <div className="flex min-w-0 flex-col gap-2 px-3 pb-3" id={panelId}>
                    <h4 className="m-0 font-mono text-xs font-medium uppercase tracking-wide text-faint">
                      {t('integrations.tools.details')}
                    </h4>
                    {tool.description && (
                      <p className="text-sm leading-normal text-muted">{tool.description}</p>
                    )}
                    <JsonView
                      value={tool.input_schema}
                      label={t('integrations.tools.schema')}
                      maxHeight={320}
                      open
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function McpPanel() {
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

  const error = resource.state.status === 'error' ? resource.state.error : null;

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
        <ErrorState message={error} onRetry={resource.reload} />
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

function ChannelsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('feishu');
  const resource = useResource({
    load: () => client.getFeishuStatus(),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const channel = resourceData(resource.state);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('integrations.channels.noTokenReason')}
      />
    );
  }
  if (!features.includes('feishu')) {
    return (
      <NotEnabledState
        title={t('integrations.channels.disabledTitle')}
        reason={t('integrations.channels.disabledReason')}
        hint={t('integrations.channels.disabledHint')}
      />
    );
  }
  const error = resource.state.status === 'error' ? resource.state.error : null;
  if (error && !channel) {
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !channel)) {
    return <LoadingState label={t('integrations.channels.loading')} />;
  }
  if (!channel) {
    return <EmptyState title={t('integrations.channels.empty')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('integrations.channels.globalDesc')}
      </p>
      {!connected && (
        <StaleNotice message={t('integrations.channels.stale')} onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <Section
        title={t('integrations.channels.title')}
        actions={
          <StatusChip
            status={channel.connected ? 'connected' : 'disconnected'}
            label={statusLabel(channel.connected ? 'connected' : 'disconnected')}
          />
        }
      >
        <KeyValueList
          items={[
            {
              key: 'app-id',
              label: 'App ID',
              value: <span className="font-mono">{channel.appIdMasked || '—'}</span>,
            },
            {
              key: 'active-chats',
              label: t('integrations.channels.activeChats'),
              value: <span className="font-mono">{channel.active_chats}</span>,
            },
            {
              key: 'queued-messages',
              label: t('integrations.channels.queuedMessages'),
              value: <span className="font-mono">{channel.queued_messages}</span>,
            },
            {
              key: 'last-error',
              label: t('integrations.channels.lastError'),
              value: channel.last_error ? (
                <span className="text-danger">{channel.last_error}</span>
              ) : (
                <span className="text-muted">—</span>
              ),
            },
          ]}
        />
        {channel.last_error && (
          <p
            className="mt-2.5 rounded-sm bg-danger-soft px-2.75 py-2 text-md text-danger"
            role="alert"
          >
            {channel.last_error}
          </p>
        )}
        <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
          {t('integrations.channels.noToggle')}
        </p>
      </Section>
    </div>
  );
}
