/**
 * 启动横幅：只有存在可操作能力时才输出一行
 * @module @vessel/tui
 *
 * 触发条件（DECISION-008 §4.5；DECISION-009 §5.8 / Addendum A §10.1）：
 * - 配置了至少一个 MCP server（含 disabled）；
 * - 或存在 interrupted durable run；
 * - 或存在 interrupted workflow run；
 * - 或飞书已连接。
 * 查询失败静默降级，不阻塞、不打断启动。
 */

import { t } from '../i18n/index.js';
import type {
  DurableRunSummary,
  FeishuStatusLike,
  McpServerSummary,
  ReplContext,
  WorkflowRunSummaryLike,
} from '../repl-context.js';

export interface StartupNoticeInput {
  /** null = 未注入 / 查询失败 */
  mcpServers: McpServerSummary[] | null;
  /** null = 未注入 / 查询失败 */
  interruptedRuns: DurableRunSummary[] | null;
  /** 0.4：null = 未注入 / 查询失败（optional 保证 0.3 调用方零改动） */
  interruptedWorkflows?: WorkflowRunSummaryLike[] | null;
  /** 0.4：null = 未注入 / 查询失败 / 未连接 */
  feishu?: FeishuStatusLike | null;
  /** 0.5：当前 tenant；default / 缺失时不显示 */
  tenantId?: string | null;
}

/** 纯函数：生成启动横幅（null = 不输出） */
export function buildStartupNotice(input: StartupNoticeInput): string | null {
  const mcpCount = input.mcpServers?.length ?? 0;
  const runCount = input.interruptedRuns?.length ?? 0;
  const workflowCount = input.interruptedWorkflows?.length ?? 0;

  const segments: string[] = [];
  const hints: string[] = [];

  if (input.tenantId && input.tenantId !== 'default') {
    segments.push(t('startup.notice.tenant', { id: input.tenantId }));
    hints.push('/tenant');
  }
  if (mcpCount > 0) {
    segments.push(
      t(mcpCount === 1 ? 'startup.notice.mcpOne' : 'startup.notice.mcpOther', { count: mcpCount }),
    );
    hints.push('/mcp');
  }
  if (runCount > 0) {
    segments.push(
      t(runCount === 1 ? 'startup.notice.runOne' : 'startup.notice.runOther', { count: runCount }),
    );
    hints.push('/runs');
  }
  if (workflowCount > 0) {
    segments.push(
      t(workflowCount === 1 ? 'startup.notice.workflowOne' : 'startup.notice.workflowOther', {
        count: workflowCount,
      }),
    );
    hints.push('/workflows');
  }
  if (input.feishu?.connected) {
    segments.push(t('startup.notice.feishu'));
    hints.push('/feishu');
  }

  if (segments.length === 0) return null;
  return `ℹ ${segments.join(' · ')} — ${hints.join(' · ')}`;
}

/** 启动控制面事实；null = 未注入 / 查询失败 */
export interface StartupFacts {
  mcpServers: McpServerSummary[] | null;
  interruptedRuns: DurableRunSummary[] | null;
  interruptedWorkflows: WorkflowRunSummaryLike[] | null;
  feishu: FeishuStatusLike | null;
  tenantId: string | null;
}

/**
 * 查询注入的控制面；任一失败都按“无该项”处理。
 * 启动头与能力提示共用同一次查询，避免重复 RPC。
 */
export async function loadStartupFacts(ctx: ReplContext): Promise<StartupFacts> {
  const feishu = ctx.feishu;

  const [mcpServers, interruptedRuns, interruptedWorkflows, feishuStatus] = await Promise.all([
    ctx.mcp ? ctx.mcp.list().catch(() => null) : Promise.resolve(null),
    ctx.runs
      ? ctx.runs.list({ status: 'interrupted', limit: 20 }).catch(() => null)
      : Promise.resolve(null),
    ctx.workflows
      ? ctx.workflows.listRuns({ status: 'interrupted', limit: 20 }).catch(() => null)
      : Promise.resolve(null),
    feishu
      ? Promise.resolve()
          .then(() => feishu.status())
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    mcpServers,
    interruptedRuns,
    interruptedWorkflows,
    feishu: feishuStatus,
    tenantId: ctx.tenant?.tenant_id ?? null,
  };
}

/** 兼容入口：能力提示行（输出逐字不变） */
export async function loadStartupNotice(ctx: ReplContext): Promise<string | null> {
  const facts = await loadStartupFacts(ctx);
  return buildStartupNotice({
    mcpServers: facts.mcpServers,
    interruptedRuns: facts.interruptedRuns,
    interruptedWorkflows: facts.interruptedWorkflows,
    feishu: facts.feishu,
    ...(facts.tenantId ? { tenantId: facts.tenantId } : {}),
  });
}
