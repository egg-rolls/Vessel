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

import { buildBorderParts } from '../components/PanelFrame.js';
import { t } from '../i18n/index.js';
import { formatModelLabel, shortSessionId } from '../utils/display-labels.js';
import { displayWidth, padToWidth, truncateToWidth } from '../utils/text-layout.js';
import { viewWidth } from '../views/layout.js';

/** R0 §2.2 的 5 行块字，最宽 48 列 */
export const WORDMARK_5: readonly string[] = [
  '██    ██ ███████ ███████ ███████ ███████ ██',
  '██    ██ ██      ██      ██      ██      ██',
  '██    ██ ██████  ███████ ███████ ██████  ██',
  ' ██  ██  ██           ██      ██ ██      ██',
  '  ████   ███████ ███████ ███████ ███████ ███████',
];

export const STARTUP_TAGLINE = t('startup.tagline');

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
  if (model) parts.push(t('startup.summary.model', { model }));
  if (facts.sessionId) {
    parts.push(t('startup.summary.session', { id: shortSessionId(facts.sessionId) }));
  }
  if (facts.tenantId) parts.push(t('startup.summary.tenant', { id: facts.tenantId }));
  if (facts.mcpCount && facts.mcpCount > 0) {
    parts.push(t('startup.summary.mcp', { count: facts.mcpCount }));
  }
  if (facts.interruptedRuns && facts.interruptedRuns > 0) {
    parts.push(t('startup.summary.runs', { count: facts.interruptedRuns }));
  }
  if (facts.interruptedWorkflows && facts.interruptedWorkflows > 0) {
    parts.push(t('startup.summary.wf', { count: facts.interruptedWorkflows }));
  }
  if (facts.feishuConnected) parts.push(t('startup.summary.feishu'));
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

/**
 * 纯函数：把启动头包进单线 PanelFrame（与 StatusBar / QueuePreview 同款 round 边框）。
 * 每行按 viewWidth - 4 截断并补齐，总宽恒定 = viewWidth(columns)。
 */
export function frameStartupLines(lines: string[], columns: number): string[] {
  if (lines.length === 0) return [];
  const width = viewWidth(columns);
  const inner = Math.max(1, width - 4);
  const top = buildBorderParts(width, undefined, 'round', 'top');
  const bottom = buildBorderParts(width, undefined, 'round', 'bottom');
  const body = lines.map((line) => `│ ${padToWidth(truncateToWidth(line, inner), inner)} │`);
  return [
    `${top.lead}${top.fill}${top.tail}`,
    ...body,
    `${bottom.lead}${bottom.fill}${bottom.tail}`,
  ];
}

/** 纯函数：未加框的启动头行（内部实现；对外统一走 buildStartupHeader） */
function buildStartupHeaderBody(input: StartupHeaderInput): string[] {
  const columns = normalize(input.columns, 80);
  const rows = normalize(input.rows, 24);
  const summary = input.summary
    ? buildSessionSummary(input.summary, Math.max(1, columns - 2))
    : null;

  if (rows >= 20) {
    if (columns >= 72) {
      const lines = WORDMARK_5.map((line) => line.trimEnd());
      lines.push(`  ${truncateToWidth(t('startup.tagline'), Math.max(1, columns - 2))}`);
      if (summary) lines.push(`  ${summary}`);
      return lines;
    }
    if (columns >= 48) {
      const width = Math.max(1, columns - 4);
      const rule = '─'.repeat(width);
      return [rule, centerIn(t('startup.tagline'), width), rule];
    }
    if (columns >= 34) {
      return [truncateToWidth(t('startup.bannerShort'), Math.max(1, columns - 2))];
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

/** 纯函数：生成启动头行（含单线边框；空数组 = 隐藏） */
export function buildStartupHeader(input: StartupHeaderInput): string[] {
  return frameStartupLines(buildStartupHeaderBody(input), normalize(input.columns, 80));
}
