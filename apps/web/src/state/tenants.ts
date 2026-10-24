/**
 * 租户表单纯函数：id 规则与 core 的 `TENANT_ID_PATTERN` 对齐，
 * quota 是 4 个非负整数字段（`TenantQuota`）。
 */
import type { TenantInfo } from '../gateway/types';
import { t } from '../i18n';

/** 与 packages/core/src/types/tenant.ts 的 TENANT_ID_PATTERN 一致。 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const TENANT_QUOTA_KEYS = [
  'max_sessions',
  'max_runs_per_day',
  'max_concurrent_runs',
  'max_storage_bytes',
] as const;

export type TenantQuotaKey = (typeof TENANT_QUOTA_KEYS)[number];
export type TenantQuotaFields = Record<TenantQuotaKey, string>;
export type TenantFormErrors = Partial<Record<'tenantId' | 'name' | TenantQuotaKey, string>>;

export const EMPTY_QUOTA_FIELDS: TenantQuotaFields = {
  max_sessions: '',
  max_runs_per_day: '',
  max_concurrent_runs: '',
  max_storage_bytes: '',
};

export function validateTenantId(raw: string): string | null {
  const id = raw.trim();
  return TENANT_ID_PATTERN.test(id) ? id : null;
}

/** 空串 = 不设置该配额；否则必须是非负整数。 */
export function parseQuotaValue(
  raw: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: t('settings.tenants.validation.nonNegativeInteger') };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, error: t('settings.tenants.validation.tooLarge') };
  }
  return { ok: true, value };
}

export interface QuotaParseResult {
  ok: boolean;
  quota?: Record<string, number>;
  errors: TenantFormErrors;
}

export function parseQuotaFields(fields: TenantQuotaFields): QuotaParseResult {
  const errors: TenantFormErrors = {};
  const quota: Record<string, number> = {};
  for (const key of TENANT_QUOTA_KEYS) {
    const parsed = parseQuotaValue(fields[key]);
    if (!parsed.ok) {
      errors[key] = parsed.error;
      continue;
    }
    if (parsed.value !== undefined) quota[key] = parsed.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors,
    ...(Object.keys(quota).length > 0 ? { quota } : {}),
  };
}

export function quotaToFields(quota: Record<string, number> | undefined): TenantQuotaFields {
  const fields = { ...EMPTY_QUOTA_FIELDS };
  if (!quota) return fields;
  for (const key of TENANT_QUOTA_KEYS) {
    const value = quota[key];
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = String(value);
  }
  return fields;
}

export interface CreateTenantForm {
  tenantId: string;
  name: string;
  quota: TenantQuotaFields;
}

export type CreateTenantValidation =
  | { ok: true; tenantId: string; name?: string; quota?: Record<string, number> }
  | { ok: false; errors: TenantFormErrors };

export function validateCreateTenant(form: CreateTenantForm): CreateTenantValidation {
  const errors: TenantFormErrors = {};
  const tenantId = validateTenantId(form.tenantId);
  if (!tenantId) {
    errors.tenantId = t('settings.tenants.validation.tenantId');
  }
  const name = form.name.trim();
  if (name.length > 128) errors.name = t('settings.tenants.validation.nameTooLong');
  const quota = parseQuotaFields(form.quota);
  Object.assign(errors, quota.errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    tenantId: tenantId as string,
    ...(name ? { name } : {}),
    ...(quota.quota ? { quota: quota.quota } : {}),
  };
}

export interface UpdateTenantForm {
  name: string;
  status: TenantInfo['status'];
  quota: TenantQuotaFields;
}

export type UpdateTenantValidation =
  | { ok: true; name?: string; status: TenantInfo['status']; quota?: Record<string, number> }
  | { ok: false; errors: TenantFormErrors };

export function validateUpdateTenant(form: UpdateTenantForm): UpdateTenantValidation {
  const errors: TenantFormErrors = {};
  const name = form.name.trim();
  if (name.length > 128) errors.name = t('settings.tenants.validation.nameTooLong');
  if (form.status !== 'active' && form.status !== 'disabled') {
    errors.name = t('settings.tenants.validation.statusInvalid');
  }
  const quota = parseQuotaFields(form.quota);
  Object.assign(errors, quota.errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    ...(name ? { name } : {}),
    status: form.status,
    ...(quota.quota ? { quota: quota.quota } : {}),
  };
}

/** 从 tenants.list 结果判断当前 token 是否具备 admin 管理能力。 */
export function canManageTenants(state: {
  status: 'idle' | 'loading' | 'success' | 'error';
}): boolean {
  return state.status === 'success';
}
