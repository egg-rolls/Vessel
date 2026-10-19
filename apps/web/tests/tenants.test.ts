import { describe, expect, test } from 'bun:test';
import {
  EMPTY_QUOTA_FIELDS,
  parseQuotaFields,
  parseQuotaValue,
  quotaToFields,
  validateCreateTenant,
  validateTenantId,
  validateUpdateTenant,
} from '../src/state/tenants';

describe('validateTenantId', () => {
  test('accepts the core tenant pattern', () => {
    expect(validateTenantId('default')).toBe('default');
    expect(validateTenantId(' team-alpha_2 ')).toBe('team-alpha_2');
  });

  test('rejects uppercase, spaces, leading dash and overlong ids', () => {
    expect(validateTenantId('Team')).toBeNull();
    expect(validateTenantId('has space')).toBeNull();
    expect(validateTenantId('-team')).toBeNull();
    expect(validateTenantId('a'.repeat(65))).toBeNull();
    expect(validateTenantId('')).toBeNull();
  });
});

describe('quota parsing', () => {
  test('empty values mean no limit', () => {
    expect(parseQuotaValue('')).toEqual({ ok: true });
    expect(parseQuotaValue('   ')).toEqual({ ok: true });
  });

  test('requires non-negative integers', () => {
    expect(parseQuotaValue('12')).toEqual({ ok: true, value: 12 });
    expect(parseQuotaValue('0')).toEqual({ ok: true, value: 0 });
    expect(parseQuotaValue('-1').ok).toBe(false);
    expect(parseQuotaValue('1.5').ok).toBe(false);
    expect(parseQuotaValue('abc').ok).toBe(false);
  });

  test('builds a sparse quota and reports per-field errors', () => {
    expect(parseQuotaFields({ ...EMPTY_QUOTA_FIELDS, max_sessions: '3' })).toEqual({
      ok: true,
      errors: {},
      quota: { max_sessions: 3 },
    });

    const bad = parseQuotaFields({ ...EMPTY_QUOTA_FIELDS, max_sessions: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.max_sessions).toBeTruthy();
  });

  test('quotaToFields keeps only known finite values', () => {
    expect(quotaToFields({ max_sessions: 2, other: 9 })).toEqual({
      ...EMPTY_QUOTA_FIELDS,
      max_sessions: '2',
    });
    expect(quotaToFields(undefined)).toEqual(EMPTY_QUOTA_FIELDS);
  });
});

describe('validateCreateTenant', () => {
  test('normalizes valid input', () => {
    expect(
      validateCreateTenant({
        tenantId: ' team-a ',
        name: ' Team A ',
        quota: { ...EMPTY_QUOTA_FIELDS, max_runs_per_day: '10' },
      }),
    ).toEqual({
      ok: true,
      tenantId: 'team-a',
      name: 'Team A',
      quota: { max_runs_per_day: 10 },
    });
  });

  test('collects field errors instead of throwing', () => {
    const result = validateCreateTenant({
      tenantId: 'BAD',
      name: 'x'.repeat(129),
      quota: { ...EMPTY_QUOTA_FIELDS, max_storage_bytes: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.tenantId).toBeTruthy();
      expect(result.errors.name).toBeTruthy();
      expect(result.errors.max_storage_bytes).toBeTruthy();
    }
  });
});

describe('validateUpdateTenant', () => {
  test('always sends status and omits empty name/quota', () => {
    expect(
      validateUpdateTenant({
        name: '  ',
        status: 'disabled',
        quota: { ...EMPTY_QUOTA_FIELDS },
      }),
    ).toEqual({ ok: true, status: 'disabled' });
  });

  test('accepts name and quota', () => {
    expect(
      validateUpdateTenant({
        name: 'Renamed',
        status: 'active',
        quota: { ...EMPTY_QUOTA_FIELDS, max_sessions: '5' },
      }),
    ).toEqual({ ok: true, name: 'Renamed', status: 'active', quota: { max_sessions: 5 } });
  });
});
