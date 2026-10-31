import { Field, Input } from '../../components/ui';
import { t } from '../../i18n';
import {
  TENANT_QUOTA_KEYS,
  type TenantFormErrors,
  type TenantQuotaFields,
} from '../../state/tenants';

export function QuotaFields({
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
