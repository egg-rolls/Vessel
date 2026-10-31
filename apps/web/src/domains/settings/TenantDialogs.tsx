import { useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, Select } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { TenantInfo } from '../../gateway/types';
import { t } from '../../i18n';
import {
  EMPTY_QUOTA_FIELDS,
  quotaToFields,
  type TenantFormErrors,
  type TenantQuotaFields,
  validateCreateTenant,
  validateUpdateTenant,
} from '../../state/tenants';
import { QuotaFields } from './TenantQuotaFields';
import { errorCode, errorMessage, isForbidden } from './tenantsShared';

export function TenantCreateDialog({
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

export function TenantEditDialog({
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
