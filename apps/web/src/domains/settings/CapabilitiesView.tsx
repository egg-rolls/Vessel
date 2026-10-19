import { useMemo, useState } from 'react';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import { resourceData, useResource } from '../../state/useResource';

const PERMISSIONS = ['read', 'write', 'admin'] as const;

export function CapabilitiesView() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [query, setQuery] = useState('');

  const resource = useResource({
    load: () => client.getCapabilities(),
    enabled: connected,
    deps: [epoch],
  });

  const manifest = resourceData(resource.state);
  const methods = useMemo(() => {
    if (!manifest) return [];
    const needle = query.trim().toLowerCase();
    return manifest.methods.filter(
      (method) => !needle || method.name.toLowerCase().includes(needle),
    );
  }, [manifest, query]);

  if (!connected) {
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取能力清单。" />;
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !manifest)) {
    return <LoadingState label="正在读取能力清单…" />;
  }
  if (!manifest) {
    return (
      <ErrorState
        message={resource.state.status === 'error' ? resource.state.error : '没有能力清单'}
        onRetry={resource.reload}
      />
    );
  }

  return (
    <div className="settings-section">
      {resource.state.status === 'error' && (
        <StaleNotice
          message={`更新失败，显示旧数据：${resource.state.error}`}
          onRetry={resource.reload}
        />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">能力清单</h2>
          <span className="mono dim">
            v{manifest.version} · schema {manifest.config_schema_version}
          </span>
        </div>
        <div className="stats-grid">
          <div className="stat">
            <span className="stat-value">{manifest.methods.length}</span>
            <span className="stat-label">协议方法</span>
          </div>
          <div className="stat">
            <span className="stat-value">{manifest.tools.length}</span>
            <span className="stat-label">工具</span>
          </div>
          <div className="stat">
            <span className="stat-value">{manifest.plugins.filter((p) => p.enabled).length}</span>
            <span className="stat-label">已启用插件</span>
          </div>
        </div>
        <input
          className="input search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索协议方法"
          type="search"
          aria-label="搜索协议方法"
        />
      </section>

      {PERMISSIONS.map((permission) => {
        const group = methods.filter((method) => method.permission === permission);
        if (group.length === 0) return null;
        return (
          <section className="panel" key={permission}>
            <h3 className="section-title">
              方法 · {permission} <span className="count-pill">{group.length}</span>
            </h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">方法</th>
                  <th scope="col">权限</th>
                </tr>
              </thead>
              <tbody>
                {group.map((method) => (
                  <tr key={method.name}>
                    <td className="mono">{method.name}</td>
                    <td>
                      <span className={`perm-badge perm-${permission}`}>{permission}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      <section className="panel">
        <h2 className="section-title">
          工具 <span className="count-pill">{manifest.tools.length}</span>
        </h2>
        {manifest.tools.length === 0 ? (
          <p className="section-desc">该 gateway 没有注册工具。</p>
        ) : (
          <ul className="plain-list">
            {manifest.tools.map((tool) => (
              <li key={tool.name}>
                <span className="mono">{tool.name}</span>
                {tool.description && <span className="dim"> — {tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">
          插件 <span className="count-pill">{manifest.plugins.length}</span>
        </h2>
        {manifest.plugins.length === 0 ? (
          <p className="section-desc">没有插件。</p>
        ) : (
          <ul className="plain-list">
            {manifest.plugins.map((plugin) => (
              <li key={plugin.name}>
                <span className="mono">{plugin.name}</span>
                <span className={`perm-badge ${plugin.enabled ? 'perm-read' : ''}`}>
                  {plugin.enabled ? 'on' : 'off'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
