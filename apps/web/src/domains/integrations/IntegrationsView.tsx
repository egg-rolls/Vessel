import { useMemo, useState } from 'react';
import type { Route } from '../../app/router';
import { JsonView } from '../../components/JsonView';
import { PageHeader } from '../../components/PageHeader';
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
import { resourceData, useResource } from '../../state/useResource';

type IntegrationsRoute = Extract<Route, { domain: 'integrations' }>;
type Tab = IntegrationsRoute['tab'];

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'tools', label: '工具' },
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'channels', label: '渠道' },
];

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
      />
      <div className="domain-content">
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
  const resource = useResource({
    load: () => client.listTools(),
    enabled: connected,
    deps: [epoch],
  });
  const tools = resourceData(resource.state) ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
    );
  }, [tools, query]);

  if (!connected) {
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取工具目录。" />;
  }
  if (
    resource.state.status === 'idle' ||
    (resource.state.status === 'loading' && tools.length === 0)
  ) {
    return <LoadingState label="正在读取工具…" />;
  }
  if (resource.state.status === 'error' && tools.length === 0) {
    return <ErrorState message={resource.state.error} onRetry={resource.reload} />;
  }

  return (
    <div className="settings-section">
      {resource.state.status === 'error' && (
        <StaleNotice
          message={`更新失败，显示旧数据：${resource.state.error}`}
          onRetry={resource.reload}
        />
      )}
      <div className="filter-bar">
        <input
          className="input search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索工具"
          type="search"
          aria-label="搜索工具"
        />
        <span className="count-pill">{filtered.length}</span>
      </div>
      {tools.length === 0 ? (
        <EmptyState title="gateway 没有注册工具。" />
      ) : filtered.length === 0 ? (
        <EmptyState title={`没有匹配“${query.trim()}”的工具。`} />
      ) : (
        <div className="card-grid">
          {filtered.map((tool) => (
            <article className="card" key={tool.name}>
              <div className="card-header">
                <h3 className="card-title mono">{tool.name}</h3>
                {tool.has_permission_check && (
                  <span className="perm-badge perm-warn" title="调用前需要确认">
                    需确认
                  </span>
                )}
              </div>
              {tool.description && <p className="card-desc">{tool.description}</p>}
              <JsonView value={tool.input_schema} label="input_schema" maxHeight={240} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function McpPanel() {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = connected && features.includes('mcp-status');
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const resource = useResource({
    load: () => client.listMcpServers(),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  const servers = resourceData(resource.state) ?? [];

  if (!connected) {
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

  const reconnect = async (name: string) => {
    setBusy((prev) => new Set(prev).add(name));
    try {
      await client.reconnectMcp(name);
      toast.success(`已重连 ${name}`);
      resource.reload();
    } catch (error) {
      toast.error(`重连 ${name} 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  return (
    <div className="settings-section">
      <p className="section-desc">
        MCP 控制面为 gateway 全局状态（default tenant），不随租户切换。
        {tenantId && tenantId !== 'default' ? ` 当前租户：${tenantId}。` : ''}
      </p>
      {resource.state.status === 'error' && (
        <StaleNotice
          message={`MCP 状态更新失败：${resource.state.error}`}
          onRetry={resource.reload}
        />
      )}
      {resource.state.status === 'idle' ||
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
                <p className="mono dim card-tools">{server.tools.join(', ')}</p>
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
                  disabled={busy.has(server.name)}
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
  const available = connected && features.includes('feishu');
  const resource = useResource({
    load: () => client.getFeishuStatus(),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch],
  });
  const channel = resourceData(resource.state);

  if (!connected) {
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
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !channel)) {
    return <LoadingState label="正在读取飞书状态…" />;
  }
  if (!channel) {
    return (
      <ErrorState
        message={resource.state.status === 'error' ? resource.state.error : '没有渠道数据'}
        onRetry={resource.reload}
      />
    );
  }

  return (
    <div className="settings-section">
      <p className="section-desc">该控制面为 gateway 全局状态（default tenant），只读。</p>
      {resource.state.status === 'error' && (
        <StaleNotice
          message={`更新失败，显示旧数据：${resource.state.error}`}
          onRetry={resource.reload}
        />
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
