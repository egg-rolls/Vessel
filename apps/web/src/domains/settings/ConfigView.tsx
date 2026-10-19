import { useMemo, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import { filterConfigEntries, flattenConfig } from '../../state/config';
import { resourceData, useResource } from '../../state/useResource';

export function ConfigView() {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('config');
  const [query, setQuery] = useState('');

  const resource = useResource({
    load: async () => {
      const [config, sources] = await Promise.all([client.getConfig(), client.getConfigSources()]);
      return { config, sources };
    },
    enabled: available,
    deps: [epoch],
  });
  const data = resourceData(resource.state);
  const entries = useMemo(() => (data ? flattenConfig(data.config.config) : []), [data]);
  const filteredEntries = useMemo(() => filterConfigEntries(entries, query), [entries, query]);

  if (!hasToken) {
    return <NotEnabledState title="未连接 gateway" reason="连接后才能读取配置。" />;
  }
  if (!features.includes('config')) {
    return (
      <NotEnabledState
        title="配置接口未启用"
        reason="该 gateway 没有注入 config 控制面。"
        hint="需要 gateway 启用 config 控制面后重启。"
      />
    );
  }
  if (!data) {
    return resource.state.status === 'error' ? (
      <ErrorState message={resource.state.error} onRetry={resource.reload} />
    ) : (
      <LoadingState label="正在读取配置…" />
    );
  }
  const sourceEntries = Object.entries(data.sources.sources);
  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="settings-section">
      {!connected && (
        <StaleNotice message="连接已断开；显示最近一次读取的配置快照。" onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={resource.reload} />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">配置快照</h2>
          <CopyButton
            text={JSON.stringify(data.config.config, null, 2)}
            label="复制 JSON"
            toast="已复制配置 JSON"
          />
          <button type="button" className="btn btn-small" onClick={resource.reload}>
            刷新
          </button>
        </div>
        <dl className="diag-list">
          <dt>schema 版本</dt>
          <dd className="mono">{data.config.schema_version}</dd>
          <dt>租户</dt>
          <dd className="mono">{data.config.tenant_id || tenantId || '—'}</dd>
          <dt>用户配置路径</dt>
          <dd className="mono">{data.config.paths.user || '—'}</dd>
          <dt>项目配置路径</dt>
          <dd className="mono">{data.config.paths.project || '—'}</dd>
          <dt>租户覆盖键</dt>
          <dd className="mono">
            {data.config.tenant_overlay_keys?.length
              ? data.config.tenant_overlay_keys.join(', ')
              : '—'}
          </dd>
        </dl>
        <JsonView value={data.config.config} label="脱敏配置 JSON（服务端已完成脱敏）" />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">配置项</h2>
          <span className="count-pill">
            {filteredEntries.length}/{entries.length}
          </span>
        </div>
        <p className="section-desc">
          展平后的只读视图；密钥字段由服务端在返回前脱敏（前端不猜测、不展示密钥）。
        </p>
        <div className="filter-bar">
          <input
            className="input search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索路径或值"
            type="search"
            aria-label="搜索配置项"
          />
        </div>
        {entries.length === 0 ? (
          <p className="section-desc">配置为空。</p>
        ) : filteredEntries.length === 0 ? (
          <p className="section-desc">没有匹配“{query.trim()}”的配置项。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">路径</th>
                <th scope="col">值</th>
                <th scope="col" className="col-optional">
                  类型
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry) => (
                <tr key={entry.path}>
                  <td className="mono">{entry.path}</td>
                  <td className="mono">{entry.value || '—'}</td>
                  <td className="col-optional dim">{entry.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">配置来源</h2>
        {sourceEntries.length === 0 ? (
          <p className="section-desc">无来源信息。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">键</th>
                <th scope="col">来源</th>
              </tr>
            </thead>
            <tbody>
              {sourceEntries.map(([key, source]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="mono">{source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
