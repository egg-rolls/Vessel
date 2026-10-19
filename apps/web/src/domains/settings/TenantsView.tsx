import { useMemo, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TenantInfo } from '../../gateway/types';
import { buildTenantPaletteActions } from '../../state/palette-actions';
import {
  EMPTY_QUOTA_FIELDS,
  quotaToFields,
  TENANT_QUOTA_KEYS,
  type TenantFormErrors,
  type TenantQuotaFields,
  validateCreateTenant,
  validateUpdateTenant,
} from '../../state/tenants';
import { resourceData, useResource } from '../../state/useResource';

function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatQuota(quota: Record<string, number> | undefined): string {
  if (!quota) return '—';
  const parts = Object.entries(quota).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

const QUOTA_LABELS: Record<(typeof TENANT_QUOTA_KEYS)[number], string> = {
  max_sessions: '最大会话数',
  max_runs_per_day: '每日 run 上限',
  max_concurrent_runs: '并发 run 上限',
  max_storage_bytes: '存储字节上限',
};

function QuotaFields({
  fields,
  errors,
  onChange,
  disabled,
}: {
  fields: TenantQuotaFields;
  errors: TenantFormErrors;
  onChange: (next: TenantQuotaFields) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-grid">
      {TENANT_QUOTA_KEYS.map((key) => (
        <label className="field" key={key}>
          <span className="field-label">
            {QUOTA_LABELS[key]} <span className="mono">({key})</span>
          </span>
          <input
            className={`input mono ${errors[key] ? 'invalid' : ''}`.trim()}
            inputMode="numeric"
            value={fields[key]}
            onChange={(event) => onChange({ ...fields, [key]: event.target.value })}
            placeholder="留空 = 不限制"
            disabled={disabled}
            aria-invalid={errors[key] ? true : undefined}
          />
          {errors[key] && (
            <span className="field-error" role="alert">
              {errors[key]}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

function TenantCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { client } = useConnection();
  const toast = useToast();
  const [tenantId, setTenantId] = useState('');
  const [name, setName] = useState('');
  const [quota, setQuota] = useState<TenantQuotaFields>({ ...EMPTY_QUOTA_FIELDS });
  const [errors, setErrors] = useState<TenantFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const validation = validateCreateTenant({ tenantId, name, quota });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setSubmitError(null);
    setBusy(true);
    try {
      const tenant = await client.createTenant(validation.tenantId, {
        ...(validation.name ? { name: validation.name } : {}),
        ...(validation.quota ? { quota: validation.quota } : {}),
      });
      toast.success(`已创建租户 ${tenant.tenant_id}`);
      onCreated();
    } catch (error) {
      setSubmitError(isForbidden(error) ? '需要 admin token 才能创建租户。' : errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label="创建租户" onClose={onClose} className="tenant-dialog">
      <h2 className="modal-title">创建租户</h2>
      <label className="field">
        <span className="field-label">租户 ID</span>
        <input
          className={`input mono ${errors.tenantId ? 'invalid' : ''}`.trim()}
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            setErrors((prev) => ({ ...prev, tenantId: undefined }));
          }}
          placeholder="例如 team-alpha"
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          aria-invalid={errors.tenantId ? true : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <span className="field-hint mono">小写字母/数字/下划线/连字符，≤64</span>
        {errors.tenantId && (
          <span className="field-error" role="alert">
            {errors.tenantId}
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">名称（可选）</span>
        <input
          className={`input ${errors.name ? 'invalid' : ''}`.trim()}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder="显示名称"
        />
        {errors.name && (
          <span className="field-error" role="alert">
            {errors.name}
          </span>
        )}
      </label>
      <h3 className="section-title">配额（可选）</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !tenantId.trim()}
          onClick={() => void submit()}
        >
          {busy ? '创建中…' : '创建租户'}
        </button>
      </div>
    </ModalShell>
  );
}

function TenantEditDialog({
  tenant,
  onClose,
  onUpdated,
}: {
  tenant: TenantInfo;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { client } = useConnection();
  const toast = useToast();
  const [name, setName] = useState(tenant.name ?? '');
  const [status, setStatus] = useState<TenantInfo['status']>(tenant.status);
  const [quota, setQuota] = useState<TenantQuotaFields>(quotaToFields(tenant.quota));
  const [errors, setErrors] = useState<TenantFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const validation = validateUpdateTenant({ name, status, quota });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setSubmitError(null);
    setBusy(true);
    try {
      const updated = await client.updateTenant(tenant.tenant_id, {
        ...(validation.name ? { name: validation.name } : {}),
        status: validation.status,
        ...(validation.quota ? { quota: validation.quota } : {}),
      });
      toast.success(`已更新租户 ${updated.tenant_id}`);
      onUpdated();
    } catch (error) {
      setSubmitError(isForbidden(error) ? '需要 admin token 才能更新租户。' : errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label="编辑租户" onClose={onClose} className="tenant-dialog">
      <h2 className="modal-title">编辑租户</h2>
      <p className="section-desc mono">{tenant.tenant_id}</p>
      <label className="field">
        <span className="field-label">名称</span>
        <input
          className={`input ${errors.name ? 'invalid' : ''}`.trim()}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder="显示名称"
          data-autofocus
        />
        {errors.name && (
          <span className="field-error" role="alert">
            {errors.name}
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">状态</span>
        <select
          className="input"
          value={status}
          onChange={(event) => setStatus(event.target.value as TenantInfo['status'])}
        >
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </select>
      </label>
      <h3 className="section-title">配额</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </ModalShell>
  );
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
  const available = hasToken && features.includes('tenants');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TenantInfo | null>(null);

  const resource = useResource({
    load: () => client.listTenants(),
    enabled: available,
    deps: [epoch],
  });
  const tenants = resourceData(resource.state);

  const paletteActions = useMemo(
    () =>
      tenants
        ? buildTenantPaletteActions({
            tenants,
            currentTenantId: tenantId,
            switchTenant: (nextTenantId) => {
              const ok = connect({ gatewayUrl, token, tenantId: nextTenantId });
              if (ok) toast.info(`正在切换到租户 ${nextTenantId}…`);
            },
          })
        : [],
    [tenants, tenantId, connect, gatewayUrl, token, toast],
  );
  usePaletteEntities('settings-tenants', paletteActions);

  if (!hasToken) {
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
    if (!connected) {
      toast.error('连接断开，无法切换租户');
      return;
    }
    if (tenant.status !== 'active') {
      toast.error('该租户已停用，不能切换');
      return;
    }
    const ok = connect({ gatewayUrl, token, tenantId: tenant.tenant_id });
    if (ok) toast.info(`正在切换到租户 ${tenant.tenant_id}…`);
  };

  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="settings-section">
      {!connected && (
        <StaleNotice
          message="连接已断开；显示最近一次读取的租户列表，管理动作已禁用。"
          onRetry={resource.reload}
        />
      )}
      {error && (
        <StaleNotice message={`更新失败，显示旧数据：${error}`} onRetry={resource.reload} />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">租户</h2>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!connected}
            title={!connected ? '连接断开，写操作已禁用' : undefined}
            onClick={() => setCreateOpen(true)}
          >
            新建租户
          </button>
          <button type="button" className="btn btn-small" onClick={resource.reload}>
            刷新
          </button>
        </div>
        <p className="section-desc">
          切换租户会重连 gateway 并清空当前会话选择与事件缓冲；数据不会跨租户混用。 新建/更新需要
          admin token。
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
                配额
              </th>
              <th scope="col" className="col-optional">
                用量
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
                  <td className="mono dim col-optional">{formatQuota(tenant.quota)}</td>
                  <td className="mono dim col-optional">{formatQuota(tenant.usage)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!connected || tenant.status !== 'active' || active}
                      title={!connected ? '连接断开，写操作已禁用' : undefined}
                      onClick={() => switchTenant(tenant)}
                    >
                      {active ? '当前租户' : '切换'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!connected}
                      onClick={() => setEditing(tenant)}
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {createOpen && (
        <TenantCreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            resource.reload();
          }}
        />
      )}
      {editing && (
        <TenantEditDialog
          tenant={editing}
          onClose={() => setEditing(null)}
          onUpdated={() => {
            setEditing(null);
            resource.reload();
          }}
        />
      )}
    </div>
  );
}
