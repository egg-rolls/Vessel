/**
 * 命令面板的实体动作目录（纯数据）。
 *
 * 只生成 action 组；破坏性动作带 `danger` + `confirm`，由 AppShell 弹确认框。
 * 数量有上限，避免 recent 列表把面板撑爆。
 */
import type { DurableRunSummary, McpServerStatus, RunStatus, TenantInfo } from '../gateway/types';
import { t } from '../i18n';
import type { PaletteItem } from './palette';
import { isCancellableRun, isResumableRun } from './runs';

export const PALETTE_ACTION_LIMIT = 5;

export function shortId(id: string, length = 14): string {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

export interface RunPaletteActionsOptions {
  live: readonly RunStatus[];
  durable: readonly DurableRunSummary[];
  openRun: (runId: string, tab: 'live' | 'durable', sessionId: string) => void;
  cancel: (runId: string) => void;
  resume: (runId: string) => void;
  limit?: number;
}

export function buildRunPaletteActions({
  live,
  durable,
  openRun,
  cancel,
  resume,
  limit = PALETTE_ACTION_LIMIT,
}: RunPaletteActionsOptions): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const run of live.filter((entry) => isCancellableRun(entry.status)).slice(0, limit)) {
    items.push({
      id: `run-cancel-${run.run_id}`,
      group: 'action',
      label: t('palette.action.cancelRun', { id: shortId(run.run_id) }),
      keywords: ['cancel', 'run', run.session_id],
      hint: t('palette.hint.cancel'),
      danger: true,
      confirm: {
        title: t('palette.confirm.cancelRunTitle'),
        body: t('palette.confirm.cancelRunBody'),
        confirmLabel: t('palette.action.cancelRunLabel'),
      },
      run: () => cancel(run.run_id),
    });
  }
  for (const run of durable.filter((entry) => isResumableRun(entry.status)).slice(0, limit)) {
    items.push({
      id: `run-resume-${run.run_id}`,
      group: 'action',
      label: t('palette.action.resumeRunNamed', { id: shortId(run.run_id) }),
      keywords: ['resume', 'durable', 'interrupted', run.session_id],
      hint: t('palette.hint.resume'),
      run: () => resume(run.run_id),
    });
  }
  const seenSessions = new Set<string>();
  for (const run of live.slice(0, limit)) {
    if (seenSessions.has(run.session_id)) continue;
    seenSessions.add(run.session_id);
    items.push({
      id: `run-open-live-${run.run_id}`,
      group: 'action',
      label: t('palette.action.openRun', { id: shortId(run.run_id) }),
      keywords: ['open', 'run', 'detail', run.session_id],
      hint: t('palette.hint.run'),
      run: () => openRun(run.run_id, 'live', run.session_id),
    });
  }
  for (const run of durable.slice(0, limit)) {
    if (seenSessions.has(run.session_id)) continue;
    seenSessions.add(run.session_id);
    items.push({
      id: `run-open-durable-${run.run_id}`,
      group: 'action',
      label: t('palette.action.openDurableRun', { id: shortId(run.run_id) }),
      keywords: ['open', 'durable', 'run', run.session_id],
      hint: t('palette.hint.run'),
      run: () => openRun(run.run_id, 'durable', run.session_id),
    });
  }
  return items;
}

export interface McpPaletteActionsOptions {
  servers: readonly McpServerStatus[];
  reconnect: (name: string) => void;
}

export function buildMcpPaletteActions({
  servers,
  reconnect,
}: McpPaletteActionsOptions): PaletteItem[] {
  return servers
    .filter((server) => server.status === 'failed')
    .map((server) => ({
      id: `mcp-reconnect-${server.name}`,
      group: 'action' as const,
      label: t('palette.action.reconnectMcp', { name: server.name }),
      keywords: ['mcp', 'reconnect', 'failed', server.name],
      hint: 'MCP',
      run: () => reconnect(server.name),
    }));
}

export interface TenantPaletteActionsOptions {
  tenants: readonly TenantInfo[];
  currentTenantId: string | null;
  switchTenant: (tenantId: string) => void;
}

export function buildTenantPaletteActions({
  tenants,
  currentTenantId,
  switchTenant,
}: TenantPaletteActionsOptions): PaletteItem[] {
  return tenants
    .filter((tenant) => tenant.tenant_id !== currentTenantId && tenant.status === 'active')
    .map((tenant) => ({
      id: `tenant-switch-${tenant.tenant_id}`,
      group: 'action' as const,
      label: t('palette.action.switchTenantNamed', {
        name: tenant.name?.trim() || tenant.tenant_id,
      }),
      keywords: ['tenant', 'switch', tenant.tenant_id],
      hint: t('palette.hint.tenant'),
      run: () => switchTenant(tenant.tenant_id),
    }));
}
