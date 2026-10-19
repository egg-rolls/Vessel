/**
 * /tenant —— 当前 tenant、tenant 列表与切换入口
 * @module @vessel/tui
 *
 * 0.5 不做热切换（1 裁决 / A-4 §11.6）：`/tenant use <id>` 只显示重启指引。
 * 数据：`tenants.list` / `tenants.get`（E19 消费端）；当前 tenant 来自 asm 注入的 ctx.tenant。
 */

import type { ReplContext, TenantQuotaLike, TenantSummaryLike } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /tenant [current|list|use <id>]';
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const TENANT_WIDTH = 24;
const STATUS_WIDTH = 9;
const CREATED_WIDTH = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidTenantId(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

function readQuota(value: unknown): TenantQuotaLike | undefined {
  if (!isRecord(value)) return undefined;
  const quota: TenantQuotaLike = {};
  if (typeof value.max_sessions === 'number') quota.max_sessions = value.max_sessions;
  if (typeof value.max_runs_per_day === 'number') {
    quota.max_runs_per_day = value.max_runs_per_day;
  }
  if (typeof value.max_concurrent_runs === 'number') {
    quota.max_concurrent_runs = value.max_concurrent_runs;
  }
  if (typeof value.max_storage_bytes === 'number') {
    quota.max_storage_bytes = value.max_storage_bytes;
  }
  return Object.keys(quota).length > 0 ? quota : undefined;
}

/** 单条 tenant 元数据（宽松解析） */
export function readTenantSummary(value: unknown): TenantSummaryLike | null {
  if (!isRecord(value) || typeof value.tenant_id !== 'string') return null;
  const quota = readQuota(value.quota);
  return {
    tenant_id: value.tenant_id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.created_at === 'number' ? { created_at: value.created_at } : {}),
    ...(value.status === 'active' || value.status === 'disabled' ? { status: value.status } : {}),
    ...(quota ? { quota } : {}),
  };
}

/** 接受 `[...]` 或 `{ tenants: [...] }` */
export function readTenantList(value: unknown): TenantSummaryLike[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tenants)
      ? value.tenants
      : [];
  return raw
    .map(readTenantSummary)
    .filter((tenant): tenant is TenantSummaryLike => tenant !== null)
    .sort((a, b) => (a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : 0));
}

function formatQuota(quota: TenantQuotaLike | undefined): string {
  if (!quota) return '-';
  const parts: string[] = [];
  if (quota.max_sessions !== undefined) parts.push(`sessions<=${quota.max_sessions}`);
  if (quota.max_runs_per_day !== undefined) parts.push(`runs/day<=${quota.max_runs_per_day}`);
  if (quota.max_concurrent_runs !== undefined)
    parts.push(`concurrent<=${quota.max_concurrent_runs}`);
  if (quota.max_storage_bytes !== undefined) parts.push(`bytes<=${quota.max_storage_bytes}`);
  return parts.length > 0 ? parts.join(' ') : '-';
}

function formatCreated(createdAt: number | undefined, now: number): string {
  return typeof createdAt === 'number' && createdAt > 0 ? formatRelativeTime(createdAt, now) : '-';
}

/** 纯函数：tenant 列表（当前 tenant 标 *） */
export function formatTenantList(
  tenants: TenantSummaryLike[],
  currentTenantId: string,
  now: number = Date.now(),
): string {
  if (tenants.length === 0) return 'No tenants.';

  const lines = ['', `Tenants (${tenants.length}):`];
  lines.push(
    `  ${'TENANT'.padEnd(TENANT_WIDTH)} ${'STATUS'.padEnd(STATUS_WIDTH)} ${'CREATED'.padEnd(
      CREATED_WIDTH,
    )} QUOTA`,
  );
  for (const tenant of tenants) {
    const marker = tenant.tenant_id === currentTenantId ? '*' : ' ';
    lines.push(
      `${marker} ${tenant.tenant_id.padEnd(TENANT_WIDTH)} ${(tenant.status ?? '-').padEnd(
        STATUS_WIDTH,
      )} ${formatCreated(tenant.created_at, now).padEnd(CREATED_WIDTH)} ${formatQuota(tenant.quota)}`.trimEnd(),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 纯函数：/tenant current */
export function formatTenantCurrent(
  tenantId: string,
  dataDir: string | undefined,
  tenant?: TenantSummaryLike | null,
): string {
  const lines = ['', `Current tenant: ${tenantId}`];
  if (dataDir) lines.push(`  data_dir: ${dataDir}`);
  if (tenant) {
    lines.push(`  status:   ${tenant.status ?? '-'}`);
    if (tenant.name) lines.push(`  name:     ${tenant.name}`);
    if (tenant.quota) lines.push(`  quota:    ${formatQuota(tenant.quota)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function restartInstructions(currentTenantId: string, targetTenantId: string): string {
  return [
    '',
    'Tenant switching requires a restart (config/runtime/store are bound at startup).',
    `Current tenant: ${currentTenantId}`,
    `Target tenant:  ${targetTenantId}`,
    `Restart with:   vessel --tenant ${targetTenantId}`,
    `or set:         VESSEL_TENANT=${targetTenantId}`,
    '',
  ].join('\n');
}

/** /tenant 的执行体（导出供单测） */
export async function runTenantCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const [subcommand, target, ...rest] = args;
  const currentTenantId = ctx.tenant?.tenant_id ?? 'default';

  if (subcommand === undefined || subcommand === 'current') {
    if (target !== undefined || rest.length > 0) {
      return { handled: true, output: `\n${USAGE}\n` };
    }

    let tenant: TenantSummaryLike | null = null;
    if (ctx.rpc) {
      try {
        const raw = await ctx.rpc.request<unknown>('tenants.get', {
          tenant_id: currentTenantId,
        });
        const wrapped = isRecord(raw) && isRecord(raw.tenant) ? raw.tenant : raw;
        tenant = readTenantSummary(wrapped);
      } catch {
        // tenants.get 不可用时只展示本地上下文
      }
    }
    return {
      handled: true,
      output: formatTenantCurrent(currentTenantId, ctx.tenant?.data_dir, tenant),
    };
  }

  if (subcommand === 'list') {
    if (target !== undefined) return { handled: true, output: `\n${USAGE}\n` };
    if (!ctx.rpc) {
      return {
        handled: true,
        output: '\nRPC control plane is not available; cannot list tenants.\n',
      };
    }
    try {
      const raw = await ctx.rpc.request<unknown>('tenants.list');
      return {
        handled: true,
        output: formatTenantList(readTenantList(raw), currentTenantId),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to list tenants:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'use') {
    if (target === undefined || rest.length > 0) {
      return { handled: true, output: `\n${USAGE}\n` };
    }
    if (!isValidTenantId(target)) {
      return {
        handled: true,
        output:
          '\nInvalid tenant id: use lowercase letters, digits, "_" or "-" (max 64 chars, must start with a letter or digit).\n',
      };
    }

    let note = '';
    if (ctx.rpc) {
      try {
        const raw = await ctx.rpc.request<unknown>('tenants.list');
        const tenants = readTenantList(raw);
        const found = tenants.find((tenant) => tenant.tenant_id === target);
        if (!found)
          note = `\n⚠ Tenant "${target}" was not found; create it first or check the id.\n`;
        else if (found.status === 'disabled') {
          note = `\n⚠ Tenant "${target}" is disabled; enable it before switching.\n`;
        }
      } catch {
        // 列表不可用不影响给出重启指引
      }
    }

    return {
      handled: true,
      output: (note ? note : '') + restartInstructions(currentTenantId, target),
    };
  }

  return { handled: true, output: `\n${USAGE}\n` };
}

export function tenantCommand(): CommandEntry {
  return {
    name: 'tenant',
    description: 'Show current tenant, list tenants, or print restart guidance',
    usage: '/tenant [current|list|use <id>]',
    category: 'config',
    keywords: ['tenant', 'scope'],
    available: (ctx) => Boolean(ctx.tenant || ctx.rpc),
    run: (args, ctx) => runTenantCommand(args, ctx),
  };
}
