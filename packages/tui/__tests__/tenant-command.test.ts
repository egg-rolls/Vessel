import { describe, expect, it } from 'bun:test';
import {
  formatTenantCurrent,
  formatTenantList,
  isValidTenantId,
  readTenantList,
  readTenantSummary,
  runTenantCommand,
} from '../src/commands/tenant-command.js';
import type { RpcClientLike, TenantSummaryLike } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const TENANTS: TenantSummaryLike[] = [
  {
    tenant_id: 'default',
    name: 'Default',
    created_at: NOW - 3_600_000,
    status: 'active',
  },
  {
    tenant_id: 'acme',
    name: 'Acme',
    created_at: NOW - 60_000,
    status: 'disabled',
    quota: { max_sessions: 10, max_runs_per_day: 5 },
  },
];

function makeRpc(handlers: Record<string, (params?: unknown) => unknown>): RpcClientLike {
  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return (await handler(params)) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('/tenant', () => {
  it('默认显示当前 tenant 与 data_dir', async () => {
    const ctx = makeCtx({
      tenant: { tenant_id: 'acme', data_dir: '/data/tenants/acme' },
    });
    const result = await runTenantCommand([], ctx);
    expect(result.output).toContain('Current tenant: acme');
    expect(result.output).toContain('data_dir: /data/tenants/acme');
  });

  it('无 tenant 注入时按 default 显示', async () => {
    const result = await runTenantCommand([], makeCtx());
    expect(result.output).toContain('Current tenant: default');
  });

  it('current 通过 tenants.get 补充状态与配额', async () => {
    const ctx = makeCtx({
      tenant: { tenant_id: 'acme' },
      rpc: makeRpc({
        'tenants.get': () => ({
          tenant: { tenant_id: 'acme', status: 'disabled', quota: { max_sessions: 10 } },
        }),
      }),
    });
    const result = await runTenantCommand(['current'], ctx);
    expect(result.output).toContain('status:   disabled');
    expect(result.output).toContain('quota:    sessions<=10');
  });

  it('list 排序并标记当前 tenant', async () => {
    const ctx = makeCtx({
      tenant: { tenant_id: 'acme' },
      rpc: makeRpc({ 'tenants.list': () => ({ tenants: [...TENANTS].reverse() }) }),
    });
    const result = await runTenantCommand(['list'], ctx);
    const output = result.output ?? '';
    expect(output.indexOf('acme')).toBeLessThan(output.indexOf('default'));
    expect(output).toContain('* acme');
    expect(output).toContain('runs/day<=5');
  });

  it('list 接受裸数组', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({ 'tenants.list': () => TENANTS }),
    });
    const result = await runTenantCommand(['list'], ctx);
    expect(result.output).toContain('Tenants (2)');
  });

  it('list 无 rpc 时明确提示', async () => {
    const result = await runTenantCommand(['list'], makeCtx());
    expect(result.output).toContain('RPC control plane is not available');
  });

  it('list RPC 错误按 code 展示', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({
        'tenants.list': () => {
          throw { code: 'forbidden', message: 'no access' };
        },
      }),
    });
    const result = await runTenantCommand(['list'], ctx);
    expect(result.output).toContain('✗ [forbidden] no access');
  });

  it('use 给出重启指引', async () => {
    const ctx = makeCtx({
      tenant: { tenant_id: 'default' },
      rpc: makeRpc({ 'tenants.list': () => TENANTS }),
    });
    const result = await runTenantCommand(['use', 'acme'], ctx);
    expect(result.output).toContain('Tenant switching requires a restart');
    expect(result.output).toContain('vessel --tenant acme');
    expect(result.output).toContain('VESSEL_TENANT=acme');
    expect(result.output).toContain('is disabled');
  });

  it('use 未知 tenant 时给出提示但仍给指引', async () => {
    const ctx = makeCtx({
      rpc: makeRpc({ 'tenants.list': () => TENANTS }),
    });
    const result = await runTenantCommand(['use', 'ghost'], ctx);
    expect(result.output).toContain('was not found');
    expect(result.output).toContain('vessel --tenant ghost');
  });

  it('use 无 rpc 时仍给重启指引', async () => {
    const result = await runTenantCommand(['use', 'acme'], makeCtx());
    expect(result.output).toContain('vessel --tenant acme');
  });

  it('use 非法 id 不发请求', async () => {
    let called = 0;
    const ctx = makeCtx({
      rpc: makeRpc({
        'tenants.list': () => {
          called += 1;
          return TENANTS;
        },
      }),
    });
    const result = await runTenantCommand(['use', 'Bad/Id'], ctx);
    expect(result.output).toContain('Invalid tenant id');
    expect(called).toBe(0);
  });

  it('未知子命令给 usage', async () => {
    const result = await runTenantCommand(['nope'], makeCtx());
    expect(result.output).toContain('Usage: /tenant');
  });

  it('isValidTenantId 边界', () => {
    expect(isValidTenantId('default')).toBe(true);
    expect(isValidTenantId('team-1_a')).toBe(true);
    expect(isValidTenantId('Upper')).toBe(false);
    expect(isValidTenantId('-bad')).toBe(false);
    expect(isValidTenantId('a'.repeat(65))).toBe(false);
  });

  it('readTenantSummary / readTenantList 宽松解析', () => {
    expect(readTenantSummary({ tenant_id: 'x', status: 'weird' })).toEqual({ tenant_id: 'x' });
    expect(readTenantSummary({ name: 'no id' })).toBeNull();
    expect(readTenantList({})).toEqual([]);
  });

  it('纯函数格式化空列表', () => {
    expect(formatTenantList([], 'default')).toBe('No tenants.');
    expect(formatTenantCurrent('default', undefined)).toContain('Current tenant: default');
  });
});
