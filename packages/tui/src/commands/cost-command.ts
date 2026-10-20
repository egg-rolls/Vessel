/**
 * /cost —— 会话用量
 * @module @vessel/tui
 *
 * Vessel 不内置模型价格：有价格时才能算钱。这里只报 token 与时长，
 * 并明确标注价格未配置，避免给出编造的金额。
 */

import { t } from '../i18n/index.js';
import type { MetricsSnapshotLike, ReplContext } from '../repl-context.js';
import type { CommandEntry, CommandResult } from './commands.js';
import { fetchMetricsSnapshot } from './metrics-command.js';

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 纯函数：/cost 报告（无价格） */
export function formatCostReport(snapshot: MetricsSnapshotLike): string {
  return [
    '',
    'Cost: pricing not configured (Vessel does not bundle model prices).',
    `Tokens: ${snapshot.llm.prompt_tokens} prompt + ${snapshot.llm.completion_tokens} completion = ${snapshot.llm.total_tokens} total`,
    `LLM requests: ${snapshot.llm.requests}`,
    `Duration: total ${formatDuration(snapshot.duration_ms.total)} · avg ${formatDuration(snapshot.duration_ms.avg)} · max ${formatDuration(snapshot.duration_ms.max)}`,
    '',
  ].join('\n');
}

export async function runCostCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  if (args.length > 0) {
    return { handled: true, output: '\nUsage: /cost\n' };
  }

  const result = await fetchMetricsSnapshot(ctx, 'live');
  if (!result.ok) {
    return {
      handled: true,
      output: `\nUsage data unavailable: ${result.message.replace(/^Failed to read metrics:\s*/, '')}\n`,
    };
  }
  return { handled: true, output: formatCostReport(result.snapshot) };
}

export function costCommand(): CommandEntry {
  return {
    name: 'cost',
    description: t('command.cost.description'),
    usage: '/cost',
    category: 'inspect',
    keywords: ['cost', 'tokens', 'usage', 'duration'],
    available: (ctx) => Boolean(ctx.metrics || ctx.rpc),
    unavailableHint: 'not enabled',
    run: (args, ctx) => runCostCommand(args, ctx),
  };
}
