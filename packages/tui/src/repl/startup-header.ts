/**
 * 启动头——纯函数（R0 §2.2 / D2）
 * @module @vessel/tui
 *
 * 高度分级（rows 优先，cols 决定形态）：
 * - rows>=20, cols>=72：5 行 wordmark + tagline + session 摘要 = 7 行
 * - rows>=20, cols 48..71：rule + tagline + rule = 3 行
 * - rows>=20, cols 34..47：1 行
 * - rows>=20, cols<34：隐藏
 * - rows 14..19：2 行
 * - rows 10..13：1 行
 * - rows<10：隐藏
 *
 * 启动头写入 <Static>，不占每帧 live 预算。
 */

import { formatModelLabel, shortSessionId } from '../utils/display-labels.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';

/** R0 §2.2 的 5 行块字，最宽 48 列 */
export const WORDMARK_5: readonly string[] = [
  '██    ██ ███████ ███████ ███████ ███████ ██',
  '██    ██ ██      ██      ██      ██      ██',
  '██    ██ ██████  ███████ ███████ ██████  ██',
  ' ██  ██  ██           ██      ██ ██      ██',
  '  ████   ███████ ███████ ███████ ███████ ███████',
];

export const STARTUP_TAGLINE = 'Agent Harness · local-first · /help for commands';

export interface SessionSummaryFacts {
  model?: string;
  sessionId?: string;
  tenantId?: string;
  mcpCount?: number;
  interruptedRuns?: number;
  interruptedWorkflows?: number;
  feishuConnected?: boolean;
}

export interface StartupHeaderInput {
  columns: number;
  rows: number;
  version?: string;
  summary?: SessionSummaryFacts;
}

function normalize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 纯函数：一行 session 摘要；无任何项时返回 null */
export function buildSessionSummary(facts: SessionSummaryFacts, columns: number): string | null {
  const parts: string[] = [];
  const model = facts.model ? formatModelLabel(facts.model) : '';
  if (model) parts.push(`model ${model}`);
  if (facts.sessionId) parts.push(`session ${shortSessionId(facts.sessionId)}`);
  if (facts.tenantId) parts.push(`tenant ${facts.tenantId}`);
  if (facts.mcpCount && facts.mcpCount > 0) parts.push(`MCP ${facts.mcpCount}`);
  if (facts.interruptedRuns && facts.interruptedRuns > 0) {
    parts.push(`runs ${facts.interruptedRuns}`);
  }
  if (facts.interruptedWorkflows && facts.interruptedWorkflows > 0) {
    parts.push(`wf ${facts.interruptedWorkflows}`);
  }
  if (facts.feishuConnected) parts.push('feishu');
  if (parts.length === 0) return null;
  return truncateToWidth(parts.join(' · '), Math.max(1, columns - 2));
}

function centerIn(text: string, width: number): string {
  const fitted = truncateToWidth(text, width);
  const slack = Math.max(0, width - displayWidth(fitted));
  const left = Math.floor(slack / 2);
  return `${' '.repeat(left)}${fitted}${' '.repeat(slack - left)}`;
}

function versionLine(version?: string): string {
  if (!version) return 'VESSEL';
  return version.startsWith('v') ? `VESSEL · ${version}` : `VESSEL · v${version}`;
}

/** 纯函数：生成启动头行（空数组 = 隐藏） */
export function buildStartupHeader(input: StartupHeaderInput): string[] {
  const columns = normalize(input.columns, 80);
  const rows = normalize(input.rows, 24);
  const summary = input.summary
    ? buildSessionSummary(input.summary, Math.max(1, columns - 2))
    : null;

  if (rows >= 20) {
    if (columns >= 72) {
      const lines = WORDMARK_5.map((line) => line.trimEnd());
      lines.push(`  ${truncateToWidth(STARTUP_TAGLINE, Math.max(1, columns - 2))}`);
      if (summary) lines.push(`  ${summary}`);
      return lines;
    }
    if (columns >= 48) {
      const width = Math.max(1, columns - 4);
      const rule = '─'.repeat(width);
      return [rule, centerIn(STARTUP_TAGLINE, width), rule];
    }
    if (columns >= 34) {
      return [truncateToWidth('VESSEL · Agent Harness', Math.max(1, columns - 2))];
    }
    return [];
  }

  if (rows >= 14) {
    const lines = [versionLine(input.version)];
    if (summary) lines.push(`  ${summary}`);
    return lines;
  }

  if (rows >= 10) return [versionLine(input.version)];

  return [];
}
