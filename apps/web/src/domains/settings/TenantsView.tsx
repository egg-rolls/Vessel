import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ModalShell } from '../../components/Modal';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TenantInfo } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
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

function isForbidden(code: string | undefined, message: string): boolean {
  return code === 'forbidden' || code === 'unauthorized' || message.includes('forbidden');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function formatQuota(quota: Record<string, number> | undefined): string {
  if (!quota) return '—';
  const parts = Object.entries(quota).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

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
            {t(`settings.tenants.quota.${key}`)} <span className="mono">({key})</span>
          </span>
          <input
            className={`input mono ${errors[key] ? 'invalid' : ''}`.trim()}
            inputMode="numeric"
            value={fields[key]}
            onChange={(event) => onChange({ ...fields, [key]: event.target.value })}
            placeholder={t('settings.tenants.quotaHint')}
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
      toast.success(t('settings.tenants.created', { tenant: tenant.tenant_id }));
      onCreated();
    } catch (error) {
      setSubmitError(
        isForbidden(errorCode(error), errorMessage(error))
          ? t('settings.tenants.adminCreate')
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      label={t('settings.tenants.createTitle')}
      onClose={onClose}
      className="tenant-dialog"
    >
      <h2 className="modal-title">{t('settings.tenants.createTitle')}</h2>
      <label className="field">
        <span className="field-label">{t('settings.tenants.tenantId')}</span>
        <input
          className={`input mono ${errors.tenantId ? 'invalid' : ''}`.trim()}
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            setErrors((prev) => ({ ...prev, tenantId: undefined }));
          }}
          placeholder={t('settings.tenants.tenantIdPlaceholder')}
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
        <span className="field-hint mono">{t('settings.tenants.tenantIdHint')}</span>
        {errors.tenantId && (
          <span className="field-error" role="alert">
            {errors.tenantId}
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">{t('settings.tenants.nameOptional')}</span>
        <input
          className={`input ${errors.name ? 'invalid' : ''}`.trim()}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder={t('settings.tenants.namePlaceholder')}
        />
        {errors.name && (
          <span className="field-error" role="alert">
            {errors.name}
          </span>
        )}
      </label>
      <h3 className="section-title">{t('settings.tenants.quota')}</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {t('settings.tenants.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !tenantId.trim()}
          onClick={() => void submit()}
        >
          {busy ? t('settings.tenants.creating') : t('settings.tenants.createTitle')}
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
      toast.success(t('settings.tenants.updated', { tenant: updated.tenant_id }));
      onUpdated();
    } catch (error) {
      setSubmitError(
        isForbidden(errorCode(error), errorMessage(error))
          ? t('settings.tenants.adminUpdate')
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell label={t('settings.tenants.editTitle')} onClose={onClose} className="tenant-dialog">
      <h2 className="modal-title">{t('settings.tenants.editTitle')}</h2>
      <p className="section-desc mono">{tenant.tenant_id}</p>
      <label className="field">
        <span className="field-label">{t('settings.tenants.name')}</span>
        <input
          className={`input ${errors.name ? 'invalid' : ''}`.trim()}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder={t('settings.tenants.namePlaceholder')}
          data-autofocus
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {errors.name && (
          <span className="field-error" role="alert">
            {errors.name}
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">{t('settings.tenants.col.status')}</span>
        <select
          className="input"
          value={status}
          onChange={(event) => setStatus(event.target.value as TenantInfo['status'])}
        >
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </select>
      </label>
      <h3 className="section-title">{t('settings.tenants.quotaRequired')}</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          {t('settings.tenants.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? t('settings.tenants.saving') : t('settings.tenants.save')}
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
  useLocale();
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
  useRefreshSignal(resource.reload);
  const tenants = resourceData(resource.state);

  const paletteActions = useMemo(
    () =>
      tenants
        ? buildTenantPaletteActions({
            tenants,
            currentTenantId: tenantId,
            switchTenant: (nextTenantId) => {
              const ok = connect({ gatewayUrl, token, tenantId: nextTenantId });
              if (ok) {
                toast.info(t('settings.tenants.switching', { tenant: nextTenantId }));
              }
            },
          })
        : [],
    [tenants, tenantId, connect, gatewayUrl, token, toast],
  );
  usePaletteEntities('settings-tenants', paletteActions);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('settings.tenants.noTokenReason')}
      />
    );
  }
  if (!features.includes('tenants')) {
    return (
      <NotEnabledState
        title={t('settings.tenants.disabledTitle')}
        reason={t('settings.tenants.disabledReason')}
        hint={t('settings.tenants.disabledHint')}
      />
    );
  }
  if (resource.state.status === 'error' && isForbidden(resource.state.code, resource.state.error)) {
    return (
      <NotEnabledState
        title={t('settings.tenants.adminTitle')}
        reason={t('settings.tenants.adminReason')}
        hint={t('settings.tenants.currentTenant', { tenant: tenantId ?? '—' })}
      />
    );
  }
  if (resource.state.status === 'idle' || (resource.state.status === 'loading' && !tenants)) {
    return <LoadingState label={t('settings.tenants.loading')} />;
  }
  if (!tenants) {
    return (
      <ErrorState
        message={
          resource.state.status === 'error' ? resource.state.error : t('settings.tenants.noData')
        }
        onRetry={resource.reload}
      />
    );
  }

  const switchTenant = (tenant: TenantInfo) => {
    if (tenant.tenant_id === tenantId) return;
    if (!connected) {
      toast.error(t('settings.tenants.switchDisconnected'));
      return;
    }
    if (tenant.status !== 'active') {
      toast.error(t('settings.tenants.switchDisabled'));
      return;
    }
    const ok = connect({ gatewayUrl, token, tenantId: tenant.tenant_id });
    if (ok) toast.info(t('settings.tenants.switching', { tenant: tenant.tenant_id }));
  };

  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="settings-section">
      {!connected && (
        <StaleNotice message={t('settings.tenants.disconnected')} onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('settings.tenants.title')}</h2>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!connected}
            title={!connected ? t('common.writesDisabled') : undefined}
            onClick={() => setCreateOpen(true)}
          >
            {t('settings.tenants.new')}
          </button>
          <button type="button" className="btn btn-small" onClick={resource.reload}>
            {t('common.refresh')}
          </button>
        </div>
        <p className="section-desc">{t('settings.tenants.description')}</p>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('settings.tenants.col.tenant')}</th>
              <th scope="col">{t('settings.tenants.col.name')}</th>
              <th scope="col">{t('settings.tenants.col.status')}</th>
              <th scope="col" className="col-optional">
                {t('settings.tenants.col.created')}
              </th>
              <th scope="col" className="col-optional">
                {t('settings.tenants.col.quota')}
              </th>
              <th scope="col" className="col-optional">
                {t('settings.tenants.col.usage')}
              </th>
              <th scope="col">{t('settings.tenants.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => {
              const active = tenant.tenant_id === tenantId;
              return (
                <tr key={tenant.tenant_id} className={active ? 'row-active' : undefined}>
                  <td className="mono">
                    {tenant.tenant_id}
                    {active && <span className="count-pill">{t('settings.tenants.current')}</span>}
                  </td>
                  <td>{tenant.name ?? '—'}</td>
                  <td>
                    <StatusChip
                      status={tenant.status === 'active' ? 'running' : 'disabled'}
                      label={t(
                        tenant.status === 'active'
                          ? 'settings.tenants.enabled'
                          : 'settings.tenants.disabled',
                      )}
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
                      title={!connected ? t('common.writesDisabled') : undefined}
                      onClick={() => switchTenant(tenant)}
                    >
                      {active
                        ? t('settings.tenants.currentTenantAction')
                        : t('settings.tenants.switch')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!connected}
                      onClick={() => setEditing(tenant)}
                    >
                      {t('common.edit')}
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
