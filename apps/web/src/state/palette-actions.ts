/**
 * 命令面板的实体动作目录（纯数据）。
 *
 * 只生成 action 组；破坏性动作带 `danger` + `confirm`，由 AppShell 弹确认框。
 * 数量有上限，避免 recent 列表把面板撑爆。
 */
import type {
  DurableRunSummary,
  McpServerStatus,
  RunStatus,
  TenantInfo,
  WorkflowRunSummary,
} from '../gateway/types';
import type { PaletteItem } from './palette';
import { isCancellableRun, isResumableRun } from './runs';
import { workflowStatusResumable } from './workflows';

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
      label: `取消运行 ${shortId(run.run_id)}`,
      keywords: ['cancel', 'run', run.session_id],
      hint: '取消',
      danger: true,
      confirm: {
        title: '取消运行？',
        body: '运行中的工具调用会被取消，已产生的输出仍会保留。',
        confirmLabel: '取消运行',
      },
      run: () => cancel(run.run_id),
    });
  }
  for (const run of durable.filter((entry) => isResumableRun(entry.status)).slice(0, limit)) {
    items.push({
      id: `run-resume-${run.run_id}`,
      group: 'action',
      label: `恢复运行 ${shortId(run.run_id)}`,
      keywords: ['resume', 'durable', 'interrupted', run.session_id],
      hint: '恢复',
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
      label: `打开运行 ${shortId(run.run_id)}`,
      keywords: ['open', 'run', 'detail', run.session_id],
      hint: '运行',
      run: () => openRun(run.run_id, 'live', run.session_id),
    });
  }
  for (const run of durable.slice(0, limit)) {
    if (seenSessions.has(run.session_id)) continue;
    seenSessions.add(run.session_id);
    items.push({
      id: `run-open-durable-${run.run_id}`,
      group: 'action',
      label: `打开可恢复运行 ${shortId(run.run_id)}`,
      keywords: ['open', 'durable', 'run', run.session_id],
      hint: '运行',
      run: () => openRun(run.run_id, 'durable', run.session_id),
    });
  }
  return items;
}

export interface WorkflowPaletteActionsOptions {
  workflows: readonly WorkflowRunSummary[];
  open: (workflowId: string) => void;
  resume: (workflowId: string) => void;
  cancel: (workflowId: string) => void;
  limit?: number;
}

export function buildWorkflowPaletteActions({
  workflows,
  open,
  resume,
  cancel,
  limit = PALETTE_ACTION_LIMIT,
}: WorkflowPaletteActionsOptions): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const run of workflows.slice(0, limit)) {
    items.push({
      id: `workflow-open-${run.workflow_run_id}`,
      group: 'action',
      label: `打开工作流 ${run.workflow_name}`,
      keywords: ['workflow', 'open', run.workflow_run_id, run.status],
      hint: '工作流',
      run: () => open(run.workflow_run_id),
    });
  }
  for (const run of workflows
    .filter((entry) => workflowStatusResumable(entry.status))
    .slice(0, limit)) {
    items.push({
      id: `workflow-resume-${run.workflow_run_id}`,
      group: 'action',
      label: `恢复工作流 ${run.workflow_name}`,
      keywords: ['workflow', 'resume', run.workflow_run_id, run.status],
      hint: '恢复',
      run: () => resume(run.workflow_run_id),
    });
  }
  for (const run of workflows
    .filter((entry) => workflowStatusActive(entry.status))
    .slice(0, limit)) {
    items.push({
      id: `workflow-cancel-${run.workflow_run_id}`,
      group: 'action',
      label: `取消工作流 ${run.workflow_name}`,
      keywords: ['workflow', 'cancel', run.workflow_run_id, run.status],
      hint: '取消',
      danger: true,
      confirm: {
        title: '取消工作流运行？',
        body: '已完成步骤会保留；取消后无法继续执行该运行。',
        confirmLabel: '取消运行',
      },
      run: () => cancel(run.workflow_run_id),
    });
  }
  return items;
}

/** 与 shell 的判定一致：non-terminal 才可取消。 */
export function workflowStatusActive(status: WorkflowRunSummary['status']): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
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
      label: `重连 MCP ${server.name}`,
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
      label: `切换到租户 ${tenant.name?.trim() || tenant.tenant_id}`,
      keywords: ['tenant', 'switch', tenant.tenant_id],
      hint: '租户',
      run: () => switchTenant(tenant.tenant_id),
    }));
}
