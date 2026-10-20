import { useCallback } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useConnection } from '../../gateway/ConnectionProvider';
import { resourceData, useResource } from '../../state/useResource';

function isForbidden(code: string | undefined, message: string): boolean {
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}

/** Settings → Nodes：team 未启用时解释原因；启用时只读展示 peers/agents。 */
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
  const teamEnabled = healthData?.team.enabled === true;

  const peers = useResource({
    load: () => client.listTeamPeers(),
    enabled: hasToken && teamEnabled,
    pollMs: 15_000,
    deps: [epoch],
  });
  const agents = useResource({
    load: () => client.listTeamAgents(),
    enabled: hasToken && teamEnabled,
    pollMs: 15_000,
    deps: [epoch],
  });

  const reloadAll = useCallback(() => {
    health.reload();
    peers.reload();
    agents.reload();
  }, [health.reload, peers.reload, agents.reload]);
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
  if (!teamEnabled) {
    return (
      <NotEnabledState
        title="Team 未启用"
        reason="当前 gateway 以 standalone 模式运行，没有 team peers/agents。"
        hint="需要 team.enabled 配置并重启 gateway。"
      />
    );
  }

  const peersData = resourceData(peers.state);
  const agentsData = resourceData(agents.state);
  const peersError = peers.state.status === 'error' ? peers.state : null;
  const agentsError = agents.state.status === 'error' ? agents.state : null;
  const forbidden =
    Boolean(peersError && isForbidden(peersError.code, peersError.error)) ||
    Boolean(agentsError && isForbidden(agentsError.code, agentsError.error));

  if (forbidden) {
    return (
      <NotEnabledState
        title="Team 控制面仅对 default tenant 或 admin token 开放。"
        reason="当前 token 无法读取 peers/agents。"
        hint={`当前节点：${healthData.node.node_id}`}
      />
    );
  }

  // 非 403 的读取失败且没有旧数据：不要永远停在 Loading。
  if ((peersError && !peersData) || (agentsError && !agentsData)) {
    const failureMessage =
      (peersError && !peersData ? peersError.error : agentsError?.error) ?? '无法读取节点信息';
    return (
      <ErrorState
        message={failureMessage}
        onRetry={() => {
          peers.reload();
          agents.reload();
        }}
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
          <dt>Team transport</dt>
          <dd className="mono">{healthData.team.transport ?? '—'}</dd>
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
          <dt>Peers / Agents</dt>
          <dd className="mono">
            {peersData?.peers.length ?? '…'} / {agentsData?.agents.length ?? '…'}
          </dd>
        </dl>
      </section>

      {peersError && (
        <StaleNotice message={`Peers 更新失败：${peersError.error}`} onRetry={peers.reload} />
      )}
      {agentsError && (
        <StaleNotice message={`Agents 更新失败：${agentsError.error}`} onRetry={agents.reload} />
      )}

      <section className="panel">
        <h2 className="section-title">节点成员</h2>
        {!peersData ? (
          <LoadingState label="正在读取 peers…" rows={2} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">节点</th>
                <th scope="col" className="col-optional">
                  Endpoint
                </th>
                <th scope="col" className="col-optional">
                  协议
                </th>
                <th scope="col">Agents</th>
              </tr>
            </thead>
            <tbody>
              {peersData.peers.map((peer) => (
                <tr key={peer.node_id}>
                  <td className="mono">{peer.node_id}</td>
                  <td className="mono col-optional">{peer.endpoint ?? '—'}</td>
                  <td className="mono col-optional">v{peer.protocol}</td>
                  <td>{peer.agents.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">Agents</h2>
        {!agentsData ? (
          <LoadingState label="正在读取 agents…" rows={2} />
        ) : agentsData.agents.length === 0 ? (
          <p className="section-desc">当前节点没有 agent。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col" className="col-optional">
                  名称
                </th>
                <th scope="col">状态</th>
                <th scope="col" className="col-optional">
                  当前 run
                </th>
                <th scope="col" className="col-optional">
                  工具
                </th>
                <th scope="col">最近错误</th>
              </tr>
            </thead>
            <tbody>
              {agentsData.agents.map((agent) => (
                <tr key={agent.id}>
                  <td className="mono">{agent.id}</td>
                  <td className="col-optional">{agent.name ?? '—'}</td>
                  <td>
                    <StatusChip
                      status={
                        agent.state === 'idle'
                          ? 'pending'
                          : agent.state === 'error'
                            ? 'failed'
                            : agent.state
                      }
                      label={
                        agent.state === 'idle'
                          ? '空闲'
                          : agent.state === 'closed'
                            ? '已关闭'
                            : undefined
                      }
                    />
                  </td>
                  <td className="mono col-optional">{agent.current_run_id ?? '—'}</td>
                  <td className="dim col-optional">{agent.tool_names.join(', ') || '—'}</td>
                  <td className="err">{agent.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="section-desc">
        该控制面为 gateway 全局状态；team 控制面仅对 default tenant 或 admin token 开放。
      </p>
    </div>
  );
}
