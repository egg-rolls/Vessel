import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import { resourceData, useResource } from '../../state/useResource';

export function ConfigView() {
  const { client, connectionState, hasToken, features, epoch, tenantId } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = connected && features.includes('config');

  const resource = useResource({
    load: async () => {
      const [config, sources] = await Promise.all([client.getConfig(), client.getConfigSources()]);
      return { config, sources };
    },
    enabled: available,
    deps: [epoch],
  });

  if (!connected) {
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
  if (resource.state.status === 'idle' || resource.state.status === 'loading') {
    return <LoadingState label="正在读取配置…" />;
  }
  const data = resourceData(resource.state);
  if (!data) {
    return (
      <ErrorState
        message={resource.state.status === 'error' ? resource.state.error : '没有配置数据'}
        onRetry={resource.reload}
      />
    );
  }
  const sourceEntries = Object.entries(data.sources.sources);

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
          <h2 className="section-title">配置快照</h2>
          <CopyButton
            text={JSON.stringify(data.config.config, null, 2)}
            label="复制 JSON"
            toast="已复制配置 JSON"
          />
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
