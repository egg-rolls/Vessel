/**
 * /tenant —— 当前 tenant、tenant 列表与切换入口
 * @module @vessel-agent/tui
 *
 * 0.5 不做热切换（1 裁决 / A-4 §11.6）：`/tenant use <id>` 只显示重启指引。
 * 数据：`tenants.list` / `tenants.get`（E19 消费端）；当前 tenant 来自 asm 注入的 ctx.tenant。
 */

import { t } from '../i18n/index.js';
import type { ReplContext, TenantQuotaLike, TenantSummaryLike } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { padToWidth, truncateToWidth } from '../utils/text-layout.js';
import { formatRelativeTime } from '../utils/time.js';
import type {
  DetailView,
  TableView,
  ViewAction,
  ViewActionInvocation,
  ViewTone,
} from '../views/types.js';
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
    `  ${padToWidth('TENANT', TENANT_WIDTH)} ${padToWidth(
      'STATUS',
      STATUS_WIDTH,
    )} ${padToWidth('CREATED', CREATED_WIDTH)} QUOTA`,
  );
  for (const tenant of tenants) {
    const marker = tenant.tenant_id === currentTenantId ? '*' : ' ';
    lines.push(
      `${marker} ${padToWidth(
        truncateToWidth(tenant.tenant_id, TENANT_WIDTH),
        TENANT_WIDTH,
      )} ${padToWidth(tenant.status ?? '-', STATUS_WIDTH)} ${padToWidth(
        formatCreated(tenant.created_at, now),
        CREATED_WIDTH,
      )} ${formatQuota(tenant.quota)}`.trimEnd(),
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

function tenantStatusTone(tenant: TenantSummaryLike): ViewTone {
  if (tenant.status === 'disabled') return 'muted';
  if (tenant.status === 'active') return 'ok';
  return 'default';
}

/** 纯函数：tenant 表格列 */
export function tenantColumns(): TableView['columns'] {
  return [
    { key: 'tenant', header: 'TENANT', minWidth: 18, priority: 1 },
    { key: 'status', header: 'STATUS', width: 9, priority: 1 },
    { key: 'created', header: 'CREATED', width: 10, priority: 2 },
    { key: 'quota', header: 'QUOTA', minWidth: 18, priority: 1 },
  ];
}

export function tenantListActions(): ViewAction[] {
  return [
    { id: 'inspect', key: 'enter', label: 'open', enabled: 'selected' },
    { id: 'refresh', key: 'r', label: 'refresh' },
  ];
}

export function tenantDetailActions(): ViewAction[] {
  return [{ id: 'refresh', key: 'r', label: 'refresh' }];
}

/** 纯函数：tenant 列表 -> TableView（当前 tenant 用 current 标记） */
export function buildTenantListView(
  tenants: TenantSummaryLike[],
  currentTenantId: string,
  now: number = Date.now(),
): TableView {
  const rows = tenants.map((tenant) => {
    const current = tenant.tenant_id === currentTenantId;
    return {
      key: tenant.tenant_id,
      current,
      tone: tenantStatusTone(tenant),
      cells: {
        tenant: current ? `${tenant.tenant_id} (active)` : tenant.tenant_id,
        status: tenant.status ?? '-',
        created: formatCreated(tenant.created_at, now),
        quota: formatQuota(tenant.quota),
        name: tenant.name ?? '-',
      },
    };
  });

  return {
    kind: 'table',
    title: 'Tenants',
    columns: tenantColumns(),
    rows,
    actions: tenantListActions(),
    ...(rows[0] ? { initialKey: rows[0].key } : {}),
    emptyText: 'No tenants.',
    meta: `${tenants.length}`,
  };
}

/** 纯函数：单个 tenant 详情（current 与 list -> detail 共用） */
export function buildTenantDetailView(
  tenantId: string,
  dataDir: string | undefined,
  tenant?: TenantSummaryLike | null,
  now: number = Date.now(),
): DetailView {
  const fields: NonNullable<DetailView['sections'][number]['fields']> = [
    { label: 'tenant_id', value: tenantId },
  ];
  if (dataDir) fields.push({ label: 'data_dir', value: dataDir });
  if (tenant) {
    if (tenant.name) fields.push({ label: 'name', value: tenant.name });
    fields.push(
      {
        label: 'status',
        value: tenant.status ?? '-',
        tone: tenantStatusTone(tenant),
      },
      { label: 'created', value: formatCreated(tenant.created_at, now) },
      { label: 'quota', value: formatQuota(tenant.quota) },
    );
  }

  return {
    kind: 'detail',
    title: `Tenant ${tenantId}`,
    ...(tenant?.status ? { badge: { text: tenant.status, tone: tenantStatusTone(tenant) } } : {}),
    key: tenantId,
    sections: [{ title: 'Overview', fields }],
    actions: tenantDetailActions(),
  };
}

type TenantLoad = { ok: true; tenant: TenantSummaryLike | null } | { ok: false; message: string };

/** tenants.get（命令主体与详情刷新共用；失败时保持本地上下文展示） */
async function loadTenantDetail(
  ctx: ReplContext,
  tenantId: string,
  strict = false,
): Promise<TenantLoad> {
  if (!ctx.rpc) return { ok: true, tenant: null };
  try {
    const raw = await ctx.rpc.request<unknown>('tenants.get', { tenant_id: tenantId });
    const wrapped = isRecord(raw) && isRecord(raw.tenant) ? raw.tenant : raw;
    return { ok: true, tenant: readTenantSummary(wrapped) };
  } catch (error) {
    if (strict)
      return {
        ok: false,
        message: `Failed to load tenant "${tenantId}":\n${formatRpcError(error)}`,
      };
    return { ok: true, tenant: null };
  }
}

function envelope(view: TableView | DetailView): NonNullable<CommandResult['view']> {
  return { source: 'tenant', view };
}

/** `/tenant` 视图动作：Enter 详情、r 刷新 */
export async function runTenantViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  const currentTenantId = ctx.tenant?.tenant_id ?? 'default';
  const targetId = invocation.selectionKey || invocation.viewKey || currentTenantId;

  if (invocation.actionId === 'refresh') {
    if (invocation.viewKind === 'table') {
      return runTenantCommand(['list'], ctx);
    }
    const loaded = await loadTenantDetail(ctx, targetId, true);
    if (!loaded.ok) return { handled: true, output: `\n${loaded.message}\n` };
    return {
      handled: true,
      view: envelope(buildTenantDetailView(targetId, ctx.tenant?.data_dir, loaded.tenant)),
    };
  }

  if (invocation.actionId === 'inspect' || invocation.actionId === 'enter') {
    if (!targetId) return { handled: true, output: '\nSelect a tenant first.\n' };
    const loaded = await loadTenantDetail(ctx, targetId);
    if (!loaded.ok) return { handled: true, output: `\n${loaded.message}\n` };
    return {
      handled: true,
      view: envelope(buildTenantDetailView(targetId, ctx.tenant?.data_dir, loaded.tenant)),
    };
  }

  return {
    handled: true,
    output: `\nUnknown /tenant view action "${invocation.actionId}".\n`,
  };
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

    // tenants.get 不可用时只展示本地上下文（不伪装成失败）。
    const loaded = await loadTenantDetail(ctx, currentTenantId);
    const tenant = loaded.ok ? loaded.tenant : null;
    return {
      handled: true,
      output: formatTenantCurrent(currentTenantId, ctx.tenant?.data_dir, tenant),
      view: envelope(buildTenantDetailView(currentTenantId, ctx.tenant?.data_dir, tenant)),
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
      const tenants = readTenantList(raw);
      return {
        handled: true,
        output: formatTenantList(tenants, currentTenantId),
        view: envelope(buildTenantListView(tenants, currentTenantId)),
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
    description: t('command.tenant.description'),
    usage: '/tenant [current|list|use <id>]',
    category: 'config',
    keywords: ['tenant', 'scope'],
    available: (ctx) => Boolean(ctx.tenant || ctx.rpc),
    unavailableHint: 'not available',
    run: (args, ctx) => runTenantCommand(args, ctx),
    viewAction: (invocation, ctx) => runTenantViewAction(invocation, ctx),
  };
}
