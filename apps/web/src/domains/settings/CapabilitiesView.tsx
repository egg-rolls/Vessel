import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { useConnection } from '../../gateway/ConnectionProvider';
import {
  CAPABILITY_TABS,
  type CapabilityTab,
  capabilityCounts,
  capabilityTabLabel,
  filterCapabilities,
  groupMethodsByPermission,
} from '../../state/capabilities';
import { resourceData, useResource } from '../../state/useResource';

export function CapabilitiesView() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const [tab, setTab] = useState<CapabilityTab>('methods');
  const [query, setQuery] = useState('');

  const resource = useResource({
    load: () => client.getCapabilities(),
    enabled: hasToken,
    deps: [epoch],
  });

  useRefreshSignal(resource.reload);
  const manifest = resourceData(resource.state);
  const counts = useMemo(() => (manifest ? capabilityCounts(manifest) : null), [manifest]);
  const result = useMemo(
    () => (manifest ? filterCapabilities(manifest, { tab, query }) : null),
    [manifest, tab, query],
  );
  const methodGroups = useMemo(
    () => (result ? groupMethodsByPermission(result.methods) : []),
    [result],
  );

  if (!hasToken) {
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

  const tabs = CAPABILITY_TABS.map((entry) => ({
    id: entry.id,
    label: counts ? capabilityTabLabel(entry.id, counts) : entry.label,
  }));

  return (
    <div className="settings-section">
      {!connected && (
        <StaleNotice message="连接已断开；显示最近一次读取的能力清单。" onRetry={resource.reload} />
      )}
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
        {counts && (
          <div className="stats-grid">
            <div className="stat">
              <span className="stat-value">{counts.methods}</span>
              <span className="stat-label">
                协议方法（read {counts.read} / write {counts.write} / admin {counts.admin}）
              </span>
            </div>
            <div className="stat">
              <span className="stat-value">{counts.tools}</span>
              <span className="stat-label">工具</span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {counts.enabledPlugins}/{counts.plugins}
              </span>
              <span className="stat-label">已启用插件</span>
            </div>
          </div>
        )}
        <SegmentedTabs label="能力类别" tabs={tabs} value={tab} onChange={setTab} />
        <div className="filter-bar">
          <input
            className="input search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              tab === 'methods' ? '搜索协议方法' : tab === 'tools' ? '搜索工具' : '搜索插件'
            }
            type="search"
            aria-label="搜索能力"
          />
          <span className="count-pill">
            {tab === 'methods'
              ? result?.methods.length
              : tab === 'tools'
                ? result?.tools.length
                : result?.plugins.length}
          </span>
        </div>
      </section>

      {tab === 'methods' &&
        (methodGroups.length === 0 ? (
          <p className="section-desc">没有匹配的协议方法。</p>
        ) : (
          methodGroups.map((group) => (
            <section className="panel" key={group.permission}>
              <h3 className="section-title">
                方法 · {group.permission} <span className="count-pill">{group.methods.length}</span>
              </h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">方法</th>
                    <th scope="col">权限</th>
                  </tr>
                </thead>
                <tbody>
                  {group.methods.map((method) => (
                    <tr key={method.name}>
                      <td className="mono">{method.name}</td>
                      <td>
                        <span className={`perm-badge perm-${group.permission}`}>
                          {group.permission}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        ))}

      {tab === 'tools' && (
        <section className="panel">
          <h2 className="section-title">
            工具 <span className="count-pill">{result?.tools.length ?? 0}</span>
          </h2>
          {result && result.tools.length === 0 ? (
            <p className="section-desc">没有匹配的工具。</p>
          ) : (
            <ul className="plain-list">
              {result?.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="mono">{tool.name}</span>
                  {tool.description && <span className="dim"> — {tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'plugins' && (
        <section className="panel">
          <h2 className="section-title">
            插件 <span className="count-pill">{result?.plugins.length ?? 0}</span>
          </h2>
          {result && result.plugins.length === 0 ? (
            <p className="section-desc">没有匹配的插件。</p>
          ) : (
            <ul className="plain-list">
              {result?.plugins.map((plugin) => (
                <li key={plugin.name}>
                  <span className="mono">{plugin.name}</span>
                  <span className={`perm-badge ${plugin.enabled ? 'perm-read' : ''}`}>
                    {plugin.enabled ? 'enabled' : 'disabled'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
