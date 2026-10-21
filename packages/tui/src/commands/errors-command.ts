/**
 * `/errors` —— 最近错误摘要（0.14 P0）
 * @module @vessel-agent/tui
 *
 * 默认只展示 user 级（run / tool / guardrail / 子 agent / 权限拒绝）；
 * `ui.errorLevel: all` 或 `ui.showInternalEvents: true` 时追加 internal 级。
 * `/errors all` 只影响本次展示，不写配置。
 */

import type { RunEvent } from '@vessel-agent/core';
import { t } from '../i18n/index.js';
import {
  collectRecentErrors,
  DEFAULT_ERROR_LIMIT,
  type ErrorLevel,
  type ErrorLogEntry,
} from '../repl/error-log.js';
import {
  findLatestLimitWarnings,
  formatLimitBlock,
  formatLimitWarning,
  type LimitWarningInfo,
} from '../repl/limit-info.js';
import type { ReplContext } from '../repl-context.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { truncateToWidth } from '../utils/text-layout.js';
import type { CommandEntry, CommandResult } from './commands.js';

const ENTRY_MAX_WIDTH = 160;
const SHORT_RUN_ID = 12;

interface UiDiagnosticsConfig {
  errorLevel?: unknown;
  showInternalEvents?: unknown;
}

function readUiConfig(ctx: ReplContext): UiDiagnosticsConfig {
  return (ctx.config as unknown as { ui?: UiDiagnosticsConfig }).ui ?? {};
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function clockTime(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function shortRunId(runId: string): string {
  const chars = Array.from(runId);
  if (chars.length <= SHORT_RUN_ID) return runId;
  return `${chars.slice(0, SHORT_RUN_ID - 1).join('')}…`;
}

function levelLabel(level: ErrorLevel): string {
  return t(`errors.level.${level}`);
}

function oneLine(text: string): string {
  return sanitizeTerminalText(text).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function permissionMessage(entry: ErrorLogEntry): string {
  return entry.tool !== undefined
    ? t('errors.permissionDenied', { tool: entry.tool })
    : t('errors.permissionDeniedNoTool');
}

function metaLabel(entry: ErrorLogEntry): string | undefined {
  const parts: string[] = [];
  if (entry.errorCode !== undefined) parts.push(entry.errorCode);
  if (entry.category !== undefined || entry.phase !== undefined) {
    parts.push([entry.category, entry.phase].filter(Boolean).join('/'));
  }
  if (entry.retryable !== undefined) {
    parts.push(entry.retryable ? t('errors.retryable') : t('errors.notRetryable'));
  }
  return parts.length > 0 ? `[${parts.join(' · ')}]` : undefined;
}

/** 纯函数：单条错误 -> 一行（超出宽度截断） */
export function formatErrorEntry(entry: ErrorLogEntry): string {
  const location: string[] = [];
  if (entry.runId !== undefined) {
    location.push(t('errors.location.run', { id: shortRunId(entry.runId) }));
  }
  if (entry.tool !== undefined) {
    location.push(t('errors.location.tool', { tool: entry.tool }));
  }

  const message =
    entry.kind === 'permissionDenied' ? permissionMessage(entry) : oneLine(entry.message);
  const meta = metaLabel(entry);
  const chunks = [
    `  ${clockTime(entry.ts)}`,
    entry.type,
    ...(location.length > 0 ? [location.join(' · ')] : []),
    ...(meta !== undefined ? [meta] : []),
    ...(entry.limit !== undefined ? [`[${formatLimitBlock(entry.limit)}]`] : []),
    message,
  ];
  return truncateToWidth(chunks.join('  '), ENTRY_MAX_WIDTH);
}

/** 纯函数：错误列表文本 */
export function formatErrorList(entries: ErrorLogEntry[], level: ErrorLevel): string {
  if (entries.length === 0) {
    const hint = level === 'user' ? `\n${t('errors.hintAll')}` : '';
    return `\n${t('errors.empty')}${hint}\n`;
  }

  const lines = ['', t('errors.header', { level: levelLabel(level), count: entries.length })];
  for (const entry of entries) lines.push(formatErrorEntry(entry));
  if (level === 'user') {
    lines.push('');
    lines.push(t('errors.hintAll'));
  }
  lines.push('');
  return lines.join('\n');
}

/** 纯函数：80% 预警段（每 key 一条；无预警时返回空数组） */
export function formatLimitWarningsSection(warnings: LimitWarningInfo[]): string[] {
  if (warnings.length === 0) return [];
  const lines = ['', t('errors.warningsHeader', { count: warnings.length })];
  for (const warning of warnings) lines.push(`  ${formatLimitWarning(warning)}`);
  return lines;
}

function parseLevel(value: string | undefined): ErrorLevel | undefined {
  if (value === 'user' || value === 'all') return value;
  return undefined;
}

/** 有效级别：显式参数 > ui.errorLevel > user；internal 另由 showInternalEvents 放开 */
export function resolveErrorLevel(
  args: string[],
  ctx: ReplContext,
): { level: ErrorLevel; includeInternal: boolean; invalid?: string } {
  const ui = readUiConfig(ctx);
  const configured: ErrorLevel = ui.errorLevel === 'all' ? 'all' : 'user';
  const requested = args[0];

  if (requested !== undefined) {
    const explicit = parseLevel(requested);
    if (explicit === undefined) {
      return { level: configured, includeInternal: false, invalid: requested };
    }
    // 显式参数只影响本次展示：/errors user 始终隐藏 internal。
    return { level: explicit, includeInternal: explicit === 'all' };
  }

  const includeInternal = configured === 'all' || ui.showInternalEvents === true;
  return {
    level: includeInternal ? 'all' : configured,
    includeInternal,
  };
}

function usage(message?: string): CommandResult {
  const prefix = message !== undefined ? `${message}\n` : '';
  return { handled: true, output: `\n${prefix}${t('errors.usage')}\n` };
}

export function errorsCommand(): CommandEntry {
  return {
    name: 'errors',
    description: t('command.errors.description'),
    usage: '/errors [user|all]',
    category: 'inspect',
    keywords: ['errors', 'failures', 'diagnostics', 'internal'],
    run: (args, ctx, _state) => {
      if (args.length > 1) return usage();
      const resolved = resolveErrorLevel(args, ctx);
      if (resolved.invalid !== undefined) {
        return usage(t('errors.invalidLevel', { value: resolved.invalid }));
      }

      const events: RunEvent[] = ctx.events.getHistory();
      const entries = collectRecentErrors(events, {
        includeInternal: resolved.includeInternal,
        limit: DEFAULT_ERROR_LIMIT,
      });
      const warnings = findLatestLimitWarnings(events);
      const warningLines = formatLimitWarningsSection(warnings);
      const output = formatErrorList(entries, resolved.level);
      return {
        handled: true,
        output:
          warningLines.length > 0
            ? `${output.replace(/\n$/, '')}\n${warningLines.join('\n')}\n`
            : output,
      };
    },
  };
}
