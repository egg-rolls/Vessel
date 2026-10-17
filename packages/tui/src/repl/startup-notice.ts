/**
 * 启动横幅：只有存在可操作能力时才输出一行
 * @module @vessel/tui
 *
 * 触发条件（DECISION-008 §4.5）：
 * - 配置了至少一个 MCP server（含 disabled）；
 * - 或存在 interrupted durable run。
 * 查询失败静默降级，不阻塞、不打断启动。
 */

import type { DurableRunSummary, McpServerSummary, ReplContext } from '../repl-context.js';

export interface StartupNoticeInput {
  /** null = 未注入 / 查询失败 */
  mcpServers: McpServerSummary[] | null;
  /** null = 未注入 / 查询失败 */
  interruptedRuns: DurableRunSummary[] | null;
}

/** 纯函数：生成启动横幅（null = 不输出） */
export function buildStartupNotice(input: StartupNoticeInput): string | null {
  const mcpCount = input.mcpServers?.length ?? 0;
  const runCount = input.interruptedRuns?.length ?? 0;

  const segments: string[] = [];
  const hints: string[] = [];

  if (mcpCount > 0) {
    segments.push(`MCP: ${mcpCount} ${mcpCount === 1 ? 'server' : 'servers'}`);
    hints.push('/mcp');
  }
  if (runCount > 0) {
    segments.push(`${runCount} interrupted ${runCount === 1 ? 'run' : 'runs'}`);
    hints.push('/runs');
  }

  if (segments.length === 0) return null;
  return `ℹ ${segments.join(' · ')} — ${hints.join(' · ')}`;
}

/** 查询注入的控制面；任一失败都按“无该项”处理 */
export async function loadStartupNotice(ctx: ReplContext): Promise<string | null> {
  const [mcpServers, interruptedRuns] = await Promise.all([
    ctx.mcp ? ctx.mcp.list().catch(() => null) : Promise.resolve(null),
    ctx.runs
      ? ctx.runs.list({ status: 'interrupted', limit: 20 }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return buildStartupNotice({ mcpServers, interruptedRuns });
}
