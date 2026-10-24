import { useCallback } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useConnection } from '../../gateway/ConnectionProvider';
import { resourceData, useResource } from '../../state/useResource';

/** Settings → Nodes：只读展示当前 gateway 节点的健康信息。 */
export function NodesPanel() {
  const { client, connectionState, hasToken, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';

  const health = useResource({
    load: () => client.getHealth(),
    enabled: hasToken,
    pollMs: 15_000,
    deps: [epoch],
  });
  const healthData = resourceData(health.state);

  const reloadAll = useCallback(() => {
    health.reload();
  }, [health.reload]);
  useRefreshSignal(reloadAll);

  if (!hasToken) {
    return <NotEnabledState title="未连接 gateway" reason="连接后才能查看节点。" />;
  }
  if (health.state.status === 'idle' || (health.state.status === 'loading' && !healthData)) {
    return <LoadingState label="正在读取节点信息…" />;
  }
  if (!healthData) {
    return (
      <ErrorState
        message={health.state.status === 'error' ? health.state.error : '没有节点信息'}
        onRetry={health.reload}
      />
    );
  }

  return (
    <div className="settings-section">
      {!connected && (
        <StaleNotice message="连接已断开；显示最近一次读取的节点信息。" onRetry={health.reload} />
      )}
      <section className="panel">
        <h2 className="section-title">当前节点</h2>
        <dl className="diag-list">
          <dt>节点</dt>
          <dd className="mono">{healthData.node.node_id}</dd>
          <dt>名称</dt>
          <dd>{healthData.node.name ?? '—'}</dd>
          <dt>角色</dt>
          <dd>{healthData.node.role}</dd>
          <dt>状态</dt>
          <dd>
            <StatusChip
              status={
                healthData.node.status === 'busy'
                  ? 'running'
                  : healthData.node.status === 'draining'
                    ? 'cancelling'
                    : 'pending'
              }
              label={
                healthData.node.status === 'busy'
                  ? '忙碌'
                  : healthData.node.status === 'draining'
                    ? '排空中'
                    : '空闲'
              }
            />
          </dd>
          <dt>当前 run</dt>
          <dd className="mono">
            {healthData.node.current_run_id ? (
              <a
                className="link-btn mono"
                href={`#/runs?tab=live&run=${encodeURIComponent(healthData.node.current_run_id)}`}
              >
                {healthData.node.current_run_id}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </dl>
      </section>
    </div>
  );
}
