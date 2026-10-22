import { useCallback, useMemo, useState } from 'react';
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
import { StatusChip } from '../../components/StatusChip';
import { SegmentedTabs } from '../../components/Tabs';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { buildMcpPaletteActions } from '../../state/palette-actions';
import { resourceData, useResource } from '../../state/useResource';

type IntegrationsRoute = Extract<Route, { domain: 'integrations' }>;
type Tab = IntegrationsRoute['tab'];

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'tools', label: '工具' },
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'channels', label: '渠道' },
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
  const { tenantId } = useConnection();
  return (
    <div className="domain-view">
      <PageHeader
        title="能力"
        description="这个 gateway 实际能做什么：工具、MCP 服务与渠道。"
        tenantId={tenantId}
      />
      <SegmentedTabs
        label="能力分区"
        tabs={TABS}
        value={route.tab}
        onChange={(tab) => navigate({ domain: 'integrations', tab })}
        panelId="integrations-panel"
      />
      <div className="domain-content" id="integrations-panel" role="tabpanel" aria-label="能力内容">
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
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取工具目录。" />;
  }
  if (error && tools.length === 0) {
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (
    resource.state.status === 'idle' ||
    (resource.state.status === 'loading' && tools.length === 0)
  ) {
    return <LoadingState label="正在读取工具…" />;
  }

  return (
    <div className="settings-section">
      {!connected && tools.length > 0 && (
        <StaleNotice message="连接已断开；显示最近一次读取的工具目录。" onRetry={resource.reload} />
      )}
      {error && tools.length > 0 && (
        <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={resource.reload} />
      )}
      <div className="filter-bar">
        <input
          className="input search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索工具名称或描述"
          type="search"
          aria-label="搜索工具"
        />
        <button
          type="button"
          className={`filter-chip ${onlyConfirm ? 'active' : ''}`.trim()}
          aria-pressed={onlyConfirm}
          onClick={() => setOnlyConfirm((value) => !value)}
        >
          仅需确认（{confirmCount}）
        </button>
        <span className="count-pill">
          {filtered.length}/{tools.length}
        </span>
      </div>
      {tools.length === 0 ? (
        <EmptyState title="gateway 没有注册工具。" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的工具。"
          action={
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('');
                setOnlyConfirm(false);
              }}
            >
              清除过滤
            </button>
          }
        />
      ) : (
        <div className="card-grid">
          {filtered.map((tool) => {
            const server = mcpServerOf(tool.name);
            return (
              <article className="card" key={tool.name}>
                <div className="card-header">
                  <h3 className="card-title mono">{tool.name}</h3>
                  {tool.has_permission_check && (
                    <span className="perm-badge perm-warn" title="调用前需要确认">
                      需确认
                    </span>
                  )}
                  {server && <span className="perm-badge">MCP · {server}</span>}
                </div>
                {tool.description && <p className="card-desc">{tool.description}</p>}
                <details className="tool-schema">
                  <summary>input schema</summary>
                  <JsonView value={tool.input_schema} label="JSON Schema" maxHeight={320} open />
                </details>
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
        toast.error('连接断开，无法重连 MCP');
        return;
      }
      setBusy((prev) => new Set(prev).add(name));
      try {
        await client.reconnectMcp(name);
        toast.success(`已重连 ${name}`);
        resource.reload();
      } catch (error) {
        toast.error(`重连 ${name} 失败：${errorMessage(error)}`);
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
    if (failures.length === 0) toast.success(`已重连 ${succeeded} 个 MCP 服务`);
    else if (succeeded === 0) toast.error(`重连失败：${failures.join('；')}`);
    else toast.error(`已重连 ${succeeded} 个；失败：${failures.join('；')}`);
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
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取 MCP 状态。" />;
  }
  if (!features.includes('mcp-status')) {
    return (
      <NotEnabledState
        title="MCP 未启用"
        reason="该 gateway 没有注入 MCP 控制面。"
        hint="未配置 MCP server 时属正常；需要时在 mcp_servers 配置后重启 gateway。"
      />
    );
  }

  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="settings-section">
      <p className="section-desc">
        MCP 控制面为 gateway 全局状态（default tenant），不随租户切换。
        {tenantId && tenantId !== 'default' ? ` 当前租户：${tenantId}。` : ''}
      </p>
      {!connected && servers.length > 0 && (
        <StaleNotice message="连接已断开；显示最近一次读取的 MCP 状态。写操作已禁用。" />
      )}
      {error && servers.length > 0 && (
        <StaleNotice message={`MCP 状态更新失败：${error}`} onRetry={resource.reload} />
      )}
      <div className="filter-bar">
        <span className="count-pill">
          {servers.length} 个服务 · {failed.length} 个失败
        </span>
        <button
          type="button"
          className="btn btn-small"
          disabled={!connected || failed.length === 0 || reconnectingAll}
          title={!connected ? '连接断开，写操作已禁用' : undefined}
          onClick={() => void reconnectAllFailed()}
        >
          {reconnectingAll ? '重连中…' : `重连全部失败（${failed.length}）`}
        </button>
        <button type="button" className="btn btn-small" onClick={resource.reload}>
          刷新
        </button>
      </div>

      {error && servers.length === 0 ? (
        <ErrorState message={error} onRetry={resource.reload} />
      ) : resource.state.status === 'idle' ||
        (resource.state.status === 'loading' && servers.length === 0) ? (
        <LoadingState label="正在读取 MCP 服务…" />
      ) : servers.length === 0 ? (
        <EmptyState
          title="未配置 MCP server。"
          description="在配置中启用 mcp_servers 后重启 gateway。"
        />
      ) : (
        <div className="card-grid">
          {servers.map((server) => (
            <article className="card" key={server.name}>
              <div className="card-header">
                <h3 className="card-title mono">{server.name}</h3>
                <StatusChip status={server.status} />
              </div>
              <p className="card-desc">{server.tools.length} 个工具</p>
              {server.tools.length > 0 && (
                <div className="chip-row">
                  {server.tools.map((tool) => (
                    <span className="perm-badge mono" key={tool}>
                      {tool}
                    </span>
                  ))}
                </div>
              )}
              {server.error && (
                <p className="err" role="alert">
                  {server.error}
                </p>
              )}
              {server.status === 'failed' && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!connected || busy.has(server.name)}
                  title={!connected ? '连接断开，写操作已禁用' : undefined}
                  onClick={() => void reconnect(server.name)}
                >
                  {busy.has(server.name) ? '重连中…' : '重连'}
                </button>
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
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取渠道状态。" />;
  }
  if (!features.includes('feishu')) {
    return (
      <NotEnabledState
        title="飞书渠道未启用"
        reason="该 gateway 没有注入 feishu 渠道。"
        hint="需要启用 feishu 插件并配置凭据后重启 gateway。"
      />
    );
  }
  const error = resource.state.status === 'error' ? resource.state.error : null;
  if (error && !channel) {
    return <ErrorState message={error} onRetry={resource.reload} />;
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !channel)) {
    return <LoadingState label="正在读取飞书状态…" />;
  }
  if (!channel) {
    return <EmptyState title="没有渠道数据。" />;
  }

  return (
    <div className="settings-section">
      <p className="section-desc">该控制面为 gateway 全局状态（default tenant），只读。</p>
      {!connected && (
        <StaleNotice message="连接已断开；显示最近一次读取的渠道状态。" onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={resource.reload} />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">飞书</h2>
          <StatusChip
            status={channel.connected ? 'connected' : 'disconnected'}
            label={channel.connected ? '已连接' : '未连接'}
          />
        </div>
        <dl className="diag-list">
          <dt>App ID</dt>
          <dd className="mono">{channel.appIdMasked || '—'}</dd>
          <dt>活跃会话</dt>
          <dd className="mono">{channel.active_chats}</dd>
          <dt>排队消息</dt>
          <dd className="mono">{channel.queued_messages}</dd>
          <dt>最近错误</dt>
          <dd className={channel.last_error ? 'err' : 'dim'}>{channel.last_error ?? '—'}</dd>
        </dl>
        {channel.last_error && (
          <p className="form-error" role="alert">
            {channel.last_error}
          </p>
        )}
        <p className="section-desc">渠道没有启停接口，因此此处不提供伪造的开关。</p>
      </section>
    </div>
  );
}
