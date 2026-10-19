import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TenantInfo } from '../../gateway/types';
import { resourceData, useResource } from '../../state/useResource';

function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}

/** Settings → Tenants：只有 tenants.list 成功（admin）才显示管理动作。 */
export function TenantsView() {
  const {
    client,
    connectionState,
    hasToken,
    features,
    epoch,
    tenantId,
    gatewayUrl,
    token,
    connect,
  } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = connected && features.includes('tenants');

  const resource = useResource({
    load: () => client.listTenants(),
    enabled: available,
    deps: [epoch],
  });
  const tenants = resourceData(resource.state);

  if (!connected) {
    return <NotEnabledState title="未连接 gateway" reason="连接后才能查看租户。" />;
  }
  if (!features.includes('tenants')) {
    return (
      <NotEnabledState
        title="租户管理未启用"
        reason="该 gateway 没有注入 tenant registry。"
        hint="需要在配置中启用 tenants 后重启 gateway。"
      />
    );
  }
  if (resource.state.status === 'error' && isForbidden(resource.state.error)) {
    return (
      <NotEnabledState
        title="需要 admin token 才能管理租户。"
        reason="当前 token 只能查看本租户数据。"
        hint={`当前租户：${tenantId ?? '—'}`}
      />
    );
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !tenants)) {
    return <LoadingState label="正在读取租户…" />;
  }
  if (!tenants) {
    return (
      <ErrorState
        message={resource.state.status === 'error' ? resource.state.error : '没有租户数据'}
        onRetry={resource.reload}
      />
    );
  }

  const switchTenant = (tenant: TenantInfo) => {
    if (tenant.tenant_id === tenantId) return;
    const ok = connect({ gatewayUrl, token, tenantId: tenant.tenant_id });
    if (ok) toast.info(`正在切换到租户 ${tenant.tenant_id}…`);
  };

  return (
    <div className="settings-section">
      {resource.state.status === 'error' && (
        <StaleNotice
          message={`更新失败，显示旧数据：${resource.state.error}`}
          onRetry={resource.reload}
        />
      )}
      <section className="panel">
        <h2 className="section-title">租户</h2>
        <p className="section-desc">
          切换租户会重连 gateway 并清空当前会话选择与事件缓冲；数据不会跨租户混用。
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">租户</th>
              <th scope="col">名称</th>
              <th scope="col">状态</th>
              <th scope="col" className="col-optional">
                创建时间
              </th>
              <th scope="col" className="col-optional">
                配额 / 用量
              </th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => {
              const active = tenant.tenant_id === tenantId;
              return (
                <tr key={tenant.tenant_id} className={active ? 'row-active' : undefined}>
                  <td className="mono">
                    {tenant.tenant_id}
                    {active && <span className="count-pill">当前</span>}
                  </td>
                  <td>{tenant.name ?? '—'}</td>
                  <td>
                    <StatusChip
                      status={tenant.status === 'active' ? 'running' : 'disabled'}
                      label={tenant.status === 'active' ? '启用' : '停用'}
                    />
                  </td>
                  <td className="mono col-optional">
                    {tenant.created_at ? new Date(tenant.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="mono dim col-optional">
                    {tenant.quota ? JSON.stringify(tenant.quota) : '—'} /{' '}
                    {tenant.usage ? JSON.stringify(tenant.usage) : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={active}
                      onClick={() => switchTenant(tenant)}
                    >
                      {active ? '当前租户' : '切换到此租户'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
