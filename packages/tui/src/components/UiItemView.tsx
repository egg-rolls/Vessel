/**
 * UiItem 渲染（history 与 live 共用）
 * @module @vessel-agent/tui
 *
 * 只有 assistant 文本走 Markdown；工具输出、用户输入、notice / error 全部纯文本，
 * 避免工具结果被二次解释。所有文本在投影层已清洗控制序列。
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import type { PermissionDecision, ToolCallView, UiItem } from '../repl/project/ui-item.js';
import { theme } from '../theme.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { displayWidth, lineKey, truncateToWidth } from '../utils/text-layout.js';
import { MarkdownText } from './Markdown.js';
import { toolDisplayRegistry } from './ToolDisplay.js';

export type ItemTone = 'normal' | 'muted' | 'faint' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';

export function toneColor(tone: ItemTone): string | undefined {
  switch (tone) {
    case 'muted':
      return theme.muted;
    case 'faint':
      return theme.faint;
    case 'ok':
      return theme.ok;
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.danger;
    case 'info':
      return theme.info;
    case 'brand':
      return theme.brand;
    case 'normal':
      return undefined;
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(count: number | undefined): string {
  if (count === undefined || !Number.isFinite(count)) return '';
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count)}`;
}

export interface ToolCardLine {
  text: string;
  tone: ItemTone;
}

export interface ToolCardView {
  header: string;
  headerTone: ItemTone;
  lines: ToolCardLine[];
}

export interface ToolCardOptions {
  /** Ctrl+O 展开：结果不再按预览行数截断 */
  expanded?: boolean;
  /** 终端列数：耗时右对齐（未提供时用两空格分隔） */
  columns?: number;
  /** 结果预览行数，默认 TOOL_RESULT_PREVIEW_LINES（3） */
  previewLines?: number;
}

const EXPANDED_RESULT_MAX_LINES = 4000;
const PREVIEW_LINES = 3;

function toolGlyph(view: ToolCallView): string {
  if (view.status === 'failed') return '✗';
  if (view.status === 'running') return '◐';
  return '✓';
}

function toolTone(view: ToolCallView): ItemTone {
  if (view.status === 'failed') return 'danger';
  if (view.status === 'running') return 'warn';
  return 'muted';
}

function decisionTone(decision: PermissionDecision): ItemTone {
  if (decision === 'deny') return 'danger';
  if (decision === 'pending') return 'warn';
  return 'ok';
}

function clockTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 纯函数：工具卡头与正文（参数永远显示；结果默认 3 行） */
export function buildToolCard(view: ToolCallView, options: ToolCardOptions = {}): ToolCardView {
  const expanded = options.expanded === true;
  const previewLines = Math.max(1, options.previewLines ?? PREVIEW_LINES);
  const glyph = toolGlyph(view);
  const headerTone = toolTone(view);

  const rightParts: string[] = [];
  const duration = formatDuration(view.durationMs);
  if (duration) rightParts.push(duration);
  if (view.permission !== undefined) rightParts.push(view.permission.decision);
  const right = rightParts.join('  ');

  const baseLeft = view.subtitle
    ? `${glyph} ${view.title}  ${sanitizeTerminalText(view.subtitle)}`
    : `${glyph} ${view.title}`;
  const columns = options.columns;
  let left = baseLeft;
  let header: string;
  if (columns !== undefined && columns > 0 && right) {
    const maxLeft = Math.max(8, columns - 1 - displayWidth(right) - 2);
    left = truncateToWidth(baseLeft, maxLeft);
    const gap = Math.max(2, columns - 1 - displayWidth(left) - displayWidth(right));
    header = `${left}${' '.repeat(gap)}${right}`;
  } else {
    header = right ? `${baseLeft}  ${right}` : baseLeft;
  }

  const lines: ToolCardLine[] = [];

  if (view.errorEnvelope !== undefined) {
    const envelope = view.errorEnvelope;
    lines.push({
      text: `  ■ ${envelope.error_code} · ${envelope.category} · ${envelope.phase}${
        envelope.retryable ? ' · retryable' : ''
      }${envelope.http_status !== undefined ? ` · http ${envelope.http_status}` : ''}`,
      tone: 'danger',
    });
  }

  const errorLines = view.error ? sanitizeTerminalText(view.error).split('\n') : [];
  const shownErrors = expanded ? errorLines : errorLines.slice(0, previewLines);
  for (const line of shownErrors) lines.push({ text: `  ! ${line}`, tone: 'danger' });
  if (!expanded && errorLines.length > shownErrors.length) {
    lines.push({ text: `  … ${errorLines.length - shownErrors.length} more lines`, tone: 'faint' });
  }

  if (view.result !== undefined) {
    const resultLines = sanitizeTerminalText(view.result).split('\n');
    const shown = expanded
      ? resultLines.slice(0, EXPANDED_RESULT_MAX_LINES)
      : resultLines.slice(0, previewLines);
    for (const line of shown) lines.push({ text: `  │ ${line}`, tone: 'muted' });
    if (!expanded && resultLines.length > shown.length) {
      lines.push({
        text: `  … ${resultLines.length - shown.length} more lines · Ctrl+O`,
        tone: 'faint',
      });
    } else if (expanded && resultLines.length > shown.length) {
      lines.push({ text: `  … truncated at ${EXPANDED_RESULT_MAX_LINES} lines`, tone: 'faint' });
    }
  }

  if (view.permission !== undefined) {
    const time = clockTime(view.permission.at);
    lines.push({
      text: `  ⚠ ${view.permission.decision}${time ? ` · ${time}` : ''}`,
      tone: decisionTone(view.permission.decision),
    });
  }

  return { header, headerTone, lines };
}

function ToolCard({
  view,
  columns,
  expanded,
}: {
  view: ToolCallView;
  columns?: number;
  expanded?: boolean;
}) {
  const card = buildToolCard(view, {
    ...(columns !== undefined ? { columns } : {}),
    expanded: expanded === true,
  });
  const display = toolDisplayRegistry.get(view.name);
  const detail =
    expanded === true && display.renderDetail !== undefined ? display.renderDetail(view) : null;

  return (
    <Box flexDirection="column">
      <Text color={toneColor(card.headerTone)} wrap="truncate-end">
        {card.header}
      </Text>
      {detail ??
        card.lines.map((line, index) => (
          <Text key={lineKey(index)} color={toneColor(line.tone)} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
    </Box>
  );
}

function UserBlock({ text }: { text: string }) {
  const lines = sanitizeTerminalText(text).split('\n');
  if (theme.userBg === undefined) {
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={lineKey(index)}>› {line}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={lineKey(index)} backgroundColor={theme.userBg} color={theme.userInk}>
          {` ${line} `}
        </Text>
      ))}
    </Box>
  );
}

function PermissionLine({ item }: { item: Extract<UiItem, { kind: 'permission' }> }) {
  const at = clockTime(item.at);
  return (
    <Box flexDirection="column">
      <Text color={decisionTone(item.decision)}>{t('item.permission', { tool: item.tool })}</Text>
      <Text color={toneColor(decisionTone(item.decision))}>
        {'  '}
        {t(`item.permission.${item.decision}`)}
        {at ? ` · ${at}` : ''}
        {item.actor ? ` · ${item.actor}` : ''}
      </Text>
    </Box>
  );
}

function AgentLine({
  item,
  depth = 0,
}: {
  item: Extract<UiItem, { kind: 'agent' }>;
  depth?: number;
}) {
  const prefix = '  '.repeat(depth);
  const tone: ItemTone =
    item.state === 'failed'
      ? 'danger'
      : item.state === 'waiting_permission'
        ? 'warn'
        : item.state === 'completed'
          ? 'ok'
          : 'info';
  return (
    <Box flexDirection="column">
      <Text color={toneColor(tone)} wrap="truncate-end">
        {prefix}
        {depth > 0 ? '└─ ' : ''}
        {`agent ${item.agentId} · ${item.state}`}
      </Text>
      {item.task ? (
        <Text color={theme.faint} wrap="truncate-end">
          {prefix}
          {'   '}
          {item.task}
        </Text>
      ) : null}
      {item.children?.map((child, index) =>
        child.kind === 'agent' ? (
          <AgentLine key={lineKey(index)} item={child} depth={depth + 1} />
        ) : null,
      )}
    </Box>
  );
}

function NoticeLine({ item }: { item: Extract<UiItem, { kind: 'notice' }> }) {
  const glyph = item.level === 'info' ? 'ℹ' : item.level === 'warn' ? '⚠' : '■';
  const tone: ItemTone = item.level === 'info' ? 'info' : item.level === 'warn' ? 'warn' : 'danger';
  return (
    <Box flexDirection="column">
      <Text color={toneColor(tone)} wrap="truncate-end">
        {glyph} {item.text}
      </Text>
      {item.detail ? (
        <Text color={theme.faint} wrap="truncate-end">
          {'  '}
          {item.detail}
        </Text>
      ) : null}
    </Box>
  );
}

function ErrorBlock({
  item,
  expanded,
}: {
  item: Extract<UiItem, { kind: 'error' }>;
  expanded?: boolean;
}) {
  const envelope = item.envelope;
  const messageLines = sanitizeTerminalText(item.text).split('\n');
  const shown = expanded === true ? messageLines : messageLines.slice(0, 8);
  return (
    <Box flexDirection="column">
      <Text color={theme.danger}>
        {envelope ? `■ ${envelope.error_code} · ${envelope.category}` : '■ error'}
      </Text>
      {shown.map((line, index) => (
        <Text key={lineKey(index)} color={theme.danger} wrap="truncate-end">
          {'  '}
          {line}
        </Text>
      ))}
      {envelope ? (
        <Text color={theme.faint}>
          {`  retryable=${envelope.retryable}`}
          {envelope.http_status !== undefined ? ` · http=${envelope.http_status}` : ''}
          {` · phase=${envelope.phase}`}
        </Text>
      ) : null}
    </Box>
  );
}

function RunSummary({ item }: { item: Extract<UiItem, { kind: 'run' }> }) {
  const glyph = item.status === 'completed' ? '✔' : item.status === 'failed' ? '✖' : '⏹';
  const tone: ItemTone =
    item.status === 'completed' ? 'faint' : item.status === 'failed' ? 'danger' : 'warn';
  const parts = [
    t(`item.run.${item.status}`),
    formatDuration(item.durationMs),
    t('item.run.tools', { count: item.toolCount }),
    item.usage?.total_tokens !== undefined
      ? t('item.run.tokens', { tokens: formatTokens(item.usage.total_tokens) })
      : '',
  ].filter((part) => part.length > 0);
  return (
    <Text color={toneColor(tone)}>
      {glyph} {parts.join(' · ')}
    </Text>
  );
}

export interface UiItemViewProps {
  item: UiItem;
  /** 终端列数（右对齐耗时 / 表格宽度） */
  columns?: number;
  /** Ctrl+O 展开态 */
  expanded?: boolean;
}

/** Ink 组件：按 item.kind 渲染一个历史/实时项 */
export function UiItemView({ item, columns, expanded }: UiItemViewProps) {
  switch (item.kind) {
    case 'user':
      return <UserBlock text={item.text} />;
    case 'assistant':
      return (
        <Box flexDirection="column">
          <MarkdownText text={item.text} />
        </Box>
      );
    case 'reasoning': {
      const duration = formatDuration(item.ms);
      return (
        <Text color={theme.faint} italic>
          {t('item.reasoning', { suffix: duration ? ` · ${duration}` : '' })}
        </Text>
      );
    }
    case 'tool':
      return (
        <ToolCard
          view={item.view}
          {...(columns !== undefined ? { columns } : {})}
          expanded={expanded === true}
        />
      );
    case 'permission':
      return <PermissionLine item={item} />;
    case 'agent':
      return <AgentLine item={item} />;
    case 'notice':
      return <NoticeLine item={item} />;
    case 'error':
      return <ErrorBlock item={item} expanded={expanded === true} />;
    case 'run':
      return <RunSummary item={item} />;
    case 'command':
      return (
        <Box flexDirection="column">
          <Text color={item.tone === 'brand' ? theme.brand : undefined}>{item.text}</Text>
          {item.output
            ? item.output.split('\n').map((line, index) => <Text key={lineKey(index)}>{line}</Text>)
            : null}
        </Box>
      );
  }
}

/** 供 ToolTrail / 测试复用的纯渲染节点 */
export function renderToolCard(view: ToolCallView, options: ToolCardOptions = {}): ReactNode {
  const card = buildToolCard(view, options);
  return (
    <Box flexDirection="column">
      <Text color={toneColor(card.headerTone)} wrap="truncate-end">
        {card.header}
      </Text>
      {card.lines.map((line, index) => (
        <Text key={lineKey(index)} color={toneColor(line.tone)} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
