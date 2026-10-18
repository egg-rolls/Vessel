import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import {
  assertTenantId,
  resolveTenant,
  resolveTenantId,
  resolveTenantPaths,
  TenantIdError,
} from '../src/index';

describe('tenant resolution (0.5 E1)', () => {
  it('uses the frozen priority explicit > cli > env > config > default', () => {
    expect(
      resolveTenantId({
        explicitTenantId: 'a',
        cliTenantId: 'b',
        envTenantId: 'c',
        configDefaultTenantId: 'd',
      }),
    ).toEqual({ tenant_id: 'a', source: 'explicit' });

    expect(
      resolveTenantId({
        cliTenantId: 'b',
        envTenantId: 'c',
        configDefaultTenantId: 'd',
      }),
    ).toEqual({ tenant_id: 'b', source: 'cli' });

    expect(resolveTenantId({ envTenantId: 'c', configDefaultTenantId: 'd' })).toEqual({
      tenant_id: 'c',
      source: 'env',
    });

    expect(resolveTenantId({ configDefaultTenantId: 'd' })).toEqual({
      tenant_id: 'd',
      source: 'config',
    });

    expect(resolveTenantId()).toEqual({ tenant_id: 'default', source: 'default' });
  });

  it('treats blank values as absent and trims', () => {
    expect(resolveTenantId({ explicitTenantId: '   ', cliTenantId: ' acme ' })).toEqual({
      tenant_id: 'acme',
      source: 'cli',
    });
  });

  it('rejects an invalid explicit value instead of falling through', () => {
    expect(() => resolveTenantId({ explicitTenantId: '../evil', cliTenantId: 'ok' })).toThrow(
      TenantIdError,
    );
  });

  it('validates ids against the frozen pattern', () => {
    expect(assertTenantId('default')).toBe('default');
    expect(assertTenantId('a1-b_2')).toBe('a1-b_2');
    expect(() => assertTenantId('')).toThrow(TenantIdError);
    expect(() => assertTenantId('Upper')).toThrow(TenantIdError);
    expect(() => assertTenantId('-bad')).toThrow(TenantIdError);
    expect(() => assertTenantId('a/b')).toThrow(TenantIdError);
    expect(() => assertTenantId('a'.repeat(65))).toThrow(TenantIdError);
  });

  it('derives data_dir as the tenant root and passes config through', () => {
    const config = { provider: { name: 'mock' } };
    const context = resolveTenant({
      baseDataDir: '/data',
      config,
      explicitTenantId: 'acme',
    });

    expect(context.tenant_id).toBe('acme');
    expect(context.data_dir).toBe(join(resolve('/data'), 'tenants', 'acme'));
    expect(context.config).toBe(config);
  });

  it('rejects an empty base data dir', () => {
    expect(() => resolveTenant({ baseDataDir: '', config: {} })).toThrow(/invalid_data_dir/);
  });
});

describe('tenant paths (0.5 E2)', () => {
  it('returns the frozen layout', () => {
    const paths = resolveTenantPaths('/data', 'acme');
    const root = join(resolve('/data'), 'tenants', 'acme');

    expect(paths).toEqual({
      tenant_id: 'acme',
      root,
      sessions_dir: join(root, 'sessions'),
      runs_dir: join(root, 'runs'),
      events_dir: join(root, 'events'),
      tenant_file: join(root, 'tenant.json'),
      lock_file: join(root, '.lock'),
    });
  });

  it('defaults to the default tenant', () => {
    expect(resolveTenantPaths('/data').tenant_id).toBe('default');
  });

  it('rejects path traversal in tenant ids', () => {
    expect(() => resolveTenantPaths('/data', '..')).toThrow(TenantIdError);
    expect(() => resolveTenantPaths('/data', 'a/../../b')).toThrow(TenantIdError);
  });
});
