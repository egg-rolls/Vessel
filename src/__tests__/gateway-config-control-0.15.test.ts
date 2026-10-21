/**
 * 0.15 gateway config.set 写回：白名单键、default tenant、保留其它键。
 *
 * 故障形态：Web 通过 RPC 改写未知键或跨 tenant 写用户配置，静默破坏配置。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGatewayConfigSet } from '../gateway-config-control';

const dirs: string[] = [];

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-gateway-config-'));
  dirs.push(dir);
  return join(dir, 'config.yaml');
}

afterEach(() => {
  dirs.length = 0;
});

describe('gateway config.set control', () => {
  it('writes a whitelisted key and keeps other keys', async () => {
    const configPath = tempConfig();
    writeFileSync(configPath, 'api_key: sk-test\nui:\n  language: en\n', 'utf8');
    const set = createGatewayConfigSet({ defaultTenantId: 'default', configPath });
    await set({ tenantId: 'default', key: 'ui.errorLevel', value: 'all' });
    const root = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(root.api_key).toBe('sk-test');
    expect(root.ui).toEqual({ language: 'en', error_level: 'all' });
  });

  it('rejects unknown keys without writing', async () => {
    const configPath = tempConfig();
    const set = createGatewayConfigSet({ defaultTenantId: 'default', configPath });
    await expect(set({ tenantId: 'default', key: 'provider.apiKey', value: 'x' })).rejects.toThrow(
      'invalid_params',
    );
    expect(existsSync(configPath)).toBe(false);
  });

  it('rejects non-default tenants', async () => {
    const configPath = tempConfig();
    const set = createGatewayConfigSet({ defaultTenantId: 'default', configPath });
    await expect(set({ tenantId: 'acme', key: 'ui.errorLevel', value: 'all' })).rejects.toThrow(
      'forbidden',
    );
    expect(existsSync(configPath)).toBe(false);
  });

  it('rejects invalid enum values', async () => {
    const configPath = tempConfig();
    const set = createGatewayConfigSet({ defaultTenantId: 'default', configPath });
    await expect(
      set({ tenantId: 'default', key: 'ui.errorLevel', value: 'debug' }),
    ).rejects.toThrow('invalid_error_level');
    expect(existsSync(configPath)).toBe(false);
  });
});
