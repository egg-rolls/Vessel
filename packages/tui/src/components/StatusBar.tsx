/**
 * 状态规则（R0 §3）
 * @module @vessel/tui
 *
 * 单行、顶部固定。按宽度分级丢弃低优先级段；颜色不是唯一语义，
 * 进度条与百分比、字形与文本同时表达状态。
 */

import { Box, Text, useStdout } from 'ink';
import { glyph, theme } from '../theme.js';
import { formatDuration, formatModelLabel, formatTokenCount } from '../utils/display-labels.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';

export type StatusKind = 'idle' | 'thinking' | 'tool' | 'cancelling';

export type StatusTone =
  | 'rule'
  | 'brand'
  | 'muted'
  | 'faint'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'statusGood'
  | 'statusWarn'
  | 'statusBad'
  | 'statusCritical'
  | 'plain';

export interface StatusRuleProps {
  status: StatusKind;
  model: string;
  context?: { used: number; max?: number };
  durationMs?: number;
  compactions?: number;
  sessions?: number;
  cwd?: string;
  branch?: string;
}

export interface StatusSegment {
  text: string;
  tone: StatusTone;
}

const STATUS_TEXT: Record<StatusKind, string> = {
  idle: `${glyph.idle} idle`,
  thinking: `${glyph.statusRunning} thinking`,
  tool: `${glyph.statusRunning} tool`,
  cancelling: `${glyph.running} cancelling`,
};

const STATUS_TONE: Record<StatusKind, StatusTone> = {
  idle: 'faint',
  thinking: 'brand',
  tool: 'brand',
  cancelling: 'warn',
};

/** 纯函数：10 格进度条 */
export function contextBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return glyph.barFilled.repeat(filled) + glyph.barEmpty.repeat(width - filled);
}

/** 纯函数：context 阈值色 */
export function contextTone(percent: number): StatusTone {
  if (percent >= 95) return 'statusCritical';
  if (percent > 80) return 'statusBad';
  if (percent >= 50) return 'statusWarn';
  return 'statusGood';
}

function joinSegments(parts: StatusSegment[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ text: ' │ ', tone: 'faint' });
    const part = parts[i];
    if (part) out.push(part);
  }
  return out;
}

/** 按显示宽度截断片段数组；保证总宽 <= max */
function fitSegments(segments: StatusSegment[], max: number): StatusSegment[] {
  const out: StatusSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const width = displayWidth(segment.text);
    if (used + width <= max) {
      out.push(segment);
      used += width;
      continue;
    }
    const budget = max - used;
    if (budget > 0) out.push({ text: truncateToWidth(segment.text, budget), tone: segment.tone });
    break;
  }
  return out;
}

/**
 * 纯函数：按终端列数生成状态规则片段。
 *
 * >=100：状态 │ model │ ctx used/max [bar] pct │ 时长 │ cmp │ sess │ cwd·branch
 * 80–99：去 cwd/branch
 * 60–79：去进度条
 * 24–59：只留状态 + model
 * <24：只留状态
 */
export function formatStatusRule(props: StatusRuleProps, columns: number): StatusSegment[] {
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const max = Math.max(1, width - 4);
  const status: StatusSegment = {
    text: STATUS_TEXT[props.status],
    tone: STATUS_TONE[props.status],
  };

  if (width < 24) return fitSegments([status], max);

  const parts: StatusSegment[] = [];
  const model = formatModelLabel(props.model);
  if (model) parts.push({ text: model, tone: 'muted' });

  if (width >= 60) {
    const used = props.context?.used ?? 0;
    const maxTokens = props.context?.max;
    const percent = maxTokens && maxTokens > 0 ? Math.round((used / maxTokens) * 100) : undefined;
    parts.push({
      text:
        maxTokens !== undefined
          ? `ctx ${formatTokenCount(used)}/${formatTokenCount(maxTokens)}`
          : `ctx ${formatTokenCount(used)} tok`,
      tone: 'muted',
    });
    if (percent !== undefined) {
      if (width >= 80) {
        parts.push({ text: `[${contextBar(percent)}]`, tone: contextTone(percent) });
      }
      parts.push({ text: `${percent}%`, tone: contextTone(percent) });
    }

    if (props.durationMs !== undefined && props.durationMs >= 0) {
      parts.push({ text: formatDuration(props.durationMs), tone: 'muted' });
    }

    if (props.compactions !== undefined && props.compactions > 0) {
      parts.push({
        text: `cmp ${props.compactions}`,
        tone: props.compactions >= 10 ? 'danger' : props.compactions >= 5 ? 'warn' : 'muted',
      });
    }

    if (props.sessions !== undefined && props.sessions > 0) {
      parts.push({ text: `${props.sessions} sess`, tone: 'muted' });
    }
  }

  if (width >= 100 && props.cwd) {
    const cwd = props.branch ? `${props.cwd} · ${props.branch}` : props.cwd;
    parts.push({ text: cwd, tone: 'faint' });
  }

  const tail = parts.length > 0 ? joinSegments(parts) : [];
  const segments: StatusSegment[] =
    tail.length > 0
      ? [{ text: '─ ', tone: 'rule' }, status, { text: ' │ ', tone: 'faint' }, ...tail]
      : [{ text: '─ ', tone: 'rule' }, status];
  return fitSegments(segments, max);
}

function toneColor(tone: StatusTone): string | undefined {
  switch (tone) {
    case 'rule':
      return theme.rule;
    case 'brand':
      return theme.brand;
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
    case 'statusGood':
      return theme.statusGood;
    case 'statusWarn':
      return theme.statusWarn;
    case 'statusBad':
      return theme.statusBad;
    case 'statusCritical':
      return theme.statusCritical;
    case 'plain':
      return undefined;
  }
}

export function StatusBar(props: StatusRuleProps) {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const segments = formatStatusRule(props, columns);
  let offset = 0;
  const keyed = segments.map((segment) => {
    const key = `${offset}-${segment.tone}`;
    offset += segment.text.length;
    return { segment, key };
  });

  return (
    <Box paddingX={2} width="100%" overflow="hidden" flexShrink={0} height={1}>
      <Text wrap="truncate-end">
        {keyed.map(({ segment, key }) => (
          <Text key={key} color={toneColor(segment.tone)}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
