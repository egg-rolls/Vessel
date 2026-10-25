import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ModalShell } from '../../components/Modal';
import { usePaletteEntities } from '../../components/PaletteEntities';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { Badge, Button, DataTable, Field, Input, Section, Select } from '../../components/ui';
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
        <Field
          key={key}
          label={
            <>
              {t(`settings.tenants.quota.${key}`)} <span className="font-mono">({key})</span>
            </>
          }
          htmlFor={`tenant-quota-${key}`}
          error={errors[key]}
        >
          <Input
            id={`tenant-quota-${key}`}
            className="font-mono"
            inputMode="numeric"
            value={fields[key]}
            onChange={(event) => onChange({ ...fields, [key]: event.target.value })}
            placeholder={t('settings.tenants.quotaHint')}
            disabled={disabled}
            invalid={Boolean(errors[key])}
          />
        </Field>
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
    <ModalShell label={t('settings.tenants.createTitle')} onClose={onClose}>
      <h2 className="modal-title">{t('settings.tenants.createTitle')}</h2>
      <Field
        label={t('settings.tenants.tenantId')}
        htmlFor="tenant-create-id"
        hint={<span className="font-mono">{t('settings.tenants.tenantIdHint')}</span>}
        error={errors.tenantId}
      >
        <Input
          id="tenant-create-id"
          className="font-mono"
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            setErrors((prev) => ({ ...prev, tenantId: undefined }));
          }}
          placeholder={t('settings.tenants.tenantIdPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          invalid={Boolean(errors.tenantId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      <Field
        label={t('settings.tenants.nameOptional')}
        htmlFor="tenant-create-name"
        error={errors.name}
      >
        <Input
          id="tenant-create-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder={t('settings.tenants.namePlaceholder')}
          invalid={Boolean(errors.name)}
        />
      </Field>
      <h3 className="text-md font-semibold text-ink">{t('settings.tenants.quota')}</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose} disabled={busy}>
          {t('settings.tenants.cancel')}
        </Button>
        <Button variant="primary" disabled={busy || !tenantId.trim()} onClick={() => void submit()}>
          {busy ? t('settings.tenants.creating') : t('settings.tenants.createTitle')}
        </Button>
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
    <ModalShell label={t('settings.tenants.editTitle')} onClose={onClose}>
      <h2 className="modal-title">{t('settings.tenants.editTitle')}</h2>
      <p className="mt-1.5 font-mono text-md text-muted">{tenant.tenant_id}</p>
      <Field label={t('settings.tenants.name')} htmlFor="tenant-edit-name" error={errors.name}>
        <Input
          id="tenant-edit-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          placeholder={t('settings.tenants.namePlaceholder')}
          data-autofocus
          invalid={Boolean(errors.name)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </Field>
      <Field label={t('settings.tenants.col.status')} htmlFor="tenant-edit-status">
        <Select
          id="tenant-edit-status"
          value={status}
          onChange={(event) => setStatus(event.target.value as TenantInfo['status'])}
        >
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </Select>
      </Field>
      <h3 className="text-md font-semibold text-ink">{t('settings.tenants.quotaRequired')}</h3>
      <QuotaFields fields={quota} errors={errors} onChange={setQuota} disabled={busy} />
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="modal-actions">
        <Button onClick={onClose} disabled={busy}>
          {t('settings.tenants.cancel')}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('settings.tenants.saving') : t('settings.tenants.save')}
        </Button>
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
    <div className="flex flex-col gap-6">
      {!connected && (
        <StaleNotice message={t('settings.tenants.disconnected')} onRetry={resource.reload} />
      )}
      {error && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={resource.reload} />
      )}
      <Section
        title={t('settings.tenants.title')}
        description={t('settings.tenants.description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="small"
              disabled={!connected}
              title={!connected ? t('common.writesDisabled') : undefined}
              onClick={() => setCreateOpen(true)}
            >
              {t('settings.tenants.new')}
            </Button>
            <Button size="small" onClick={resource.reload}>
              {t('common.refresh')}
            </Button>
          </div>
        }
      >
        <DataTable
          activeKey={tenantId ?? undefined}
          columns={[
            {
              key: 'tenant',
              header: t('settings.tenants.col.tenant'),
              cellClassName: 'font-mono',
              cell: (tenant) => (
                <>
                  {tenant.tenant_id}
                  {tenant.tenant_id === tenantId && (
                    <Badge className="ml-1.5">{t('settings.tenants.current')}</Badge>
                  )}
                </>
              ),
            },
            {
              key: 'name',
              header: t('settings.tenants.col.name'),
              cell: (tenant) => tenant.name ?? '—',
            },
            {
              key: 'status',
              header: t('settings.tenants.col.status'),
              cell: (tenant) => (
                <StatusChip
                  status={tenant.status === 'active' ? 'running' : 'disabled'}
                  label={t(
                    tenant.status === 'active'
                      ? 'settings.tenants.enabled'
                      : 'settings.tenants.disabled',
                  )}
                />
              ),
            },
            {
              key: 'created',
              header: t('settings.tenants.col.created'),
              hide: 'compact',
              cellClassName: 'font-mono',
              cell: (tenant) =>
                tenant.created_at ? new Date(tenant.created_at).toLocaleString() : '—',
            },
            {
              key: 'quota',
              header: t('settings.tenants.col.quota'),
              hide: 'compact',
              cellClassName: 'font-mono text-muted',
              cell: (tenant) => formatQuota(tenant.quota),
            },
            {
              key: 'usage',
              header: t('settings.tenants.col.usage'),
              hide: 'compact',
              cellClassName: 'font-mono text-muted',
              cell: (tenant) => formatQuota(tenant.usage),
            },
            {
              key: 'actions',
              header: t('settings.tenants.col.actions'),
              cell: (tenant) => {
                const active = tenant.tenant_id === tenantId;
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="small"
                      disabled={!connected || tenant.status !== 'active' || active}
                      title={!connected ? t('common.writesDisabled') : undefined}
                      onClick={() => switchTenant(tenant)}
                    >
                      {active
                        ? t('settings.tenants.currentTenantAction')
                        : t('settings.tenants.switch')}
                    </Button>
                    <Button size="small" disabled={!connected} onClick={() => setEditing(tenant)}>
                      {t('common.edit')}
                    </Button>
                  </div>
                );
              },
            },
          ]}
          rows={tenants}
          rowKey={(tenant) => tenant.tenant_id}
        />
      </Section>

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
