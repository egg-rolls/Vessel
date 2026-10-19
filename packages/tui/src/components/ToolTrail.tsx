/**
 * Tool trail（R0 §4.4）
 * @module @vessel/tui
 *
 * 一轮内连续工具调用聚合为一个 trail；文本段与工具段保持原顺序。
 * hidden / collapsed（默认）/ expanded 三态；归档路径不经过这里。
 */

import { Box, Text } from 'ink';
import type { ToolDetailMode } from '../commands/commands.js';
import { theme } from '../theme.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { lineKey } from '../utils/text-layout.js';
import type { Segment } from './StreamOutput.js';
import { toolDisplayRegistry } from './ToolDisplay.js';

export type ToolSegment = Extract<Segment, { type: 'tool_call' }>;
type TextSegment = Extract<Segment, { type: 'text' }>;

export type SegmentGroup =
  | { type: 'text'; segment: TextSegment }
  | { type: 'tools'; segments: ToolSegment[] };

export type TrailTone = 'ok' | 'warn' | 'danger' | 'muted' | 'faint';

export interface TrailLine {
  text: string;
  tone: TrailTone;
}

export interface TrailView {
  header: string;
  headerTone: TrailTone;
  lines: TrailLine[];
}

const EXPANDED_MAX = 8;

/** 纯函数：只聚合连续工具段；文本段原样保留顺序 */
export function groupSegments(segments: Segment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let tools: ToolSegment[] = [];

  const flush = () => {
    if (tools.length > 0) {
      groups.push({ type: 'tools', segments: tools });
      tools = [];
    }
  };

  for (const segment of segments) {
    if (segment.type === 'tool_call') {
      tools.push(segment);
      continue;
    }
    flush();
    groups.push({ type: 'text', segment });
  }
  flush();
  return groups;
}

function trailDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(text: string | undefined, max = 60): string {
  const line = text?.split('\n').find((value) => value.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function detailText(segment: ToolSegment): string {
  const display = toolDisplayRegistry.get(segment.name);
  const trail = display.getTrailLine?.(segment.arguments, segment.result, segment.status) ?? {
    label: segment.name,
    detail: '',
  };
  const label = trail.label || display.userFacingName(segment.arguments) || segment.name;
  let text = trail.detail ? `${label}  ${trail.detail}` : label;
  if (segment.status === 'failed') {
    const error = firstLine(segment.error);
    text += error ? `  FAILED: ${error}` : '  FAILED';
  }
  return sanitizeTerminalText(text);
}

function lineTone(segment: ToolSegment): TrailTone {
  if (segment.status === 'failed') return 'danger';
  if (segment.status === 'running') return 'warn';
  return 'muted';
}

/** 纯函数：生成 trail 头与明细；hidden 返回 null */
export function buildTrail(segments: ToolSegment[], mode: ToolDetailMode): TrailView | null {
  if (mode === 'hidden' || segments.length === 0) return null;

  const failed = segments.some((segment) => segment.status === 'failed');
  const running = segments.some((segment) => segment.status === 'running');
  const glyph = failed ? '✗' : running ? '●' : '✓';
  const headerTone: TrailTone = failed ? 'danger' : running ? 'warn' : 'ok';
  const totalMs = segments.reduce(
    (sum, segment) => sum + (segment.duration !== undefined ? segment.duration : 0),
    0,
  );
  const suffix = totalMs > 0 ? ` · ${trailDuration(totalMs)}` : '';
  const header = `${glyph} tools (${segments.length})${suffix}`;

  const visible = mode === 'collapsed' ? segments.slice(-1) : segments.slice(-EXPANDED_MAX);
  const hiddenCount = segments.length - visible.length;
  const lines: TrailLine[] = [];

  if (mode === 'expanded' && hiddenCount > 0) {
    lines.push({ text: `…and ${hiddenCount} earlier`, tone: 'faint' });
  }

  visible.forEach((segment, index) => {
    const last = index === visible.length - 1;
    lines.push({
      text: `${last ? '└─' : '├─'} ${detailText(segment)}`,
      tone: lineTone(segment),
    });
  });

  return { header, headerTone, lines };
}

interface ToolTrailProps {
  segments: ToolSegment[];
  mode: ToolDetailMode;
}

function toneColor(tone: TrailTone): string | undefined {
  switch (tone) {
    case 'ok':
      return theme.ok;
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.danger;
    case 'muted':
      return theme.muted;
    case 'faint':
      return theme.faint;
  }
}

export function ToolTrail({ segments, mode }: ToolTrailProps) {
  const view = buildTrail(segments, mode);
  if (!view) return null;

  return (
    <Box flexDirection="column">
      <Text color={toneColor(view.headerTone)} wrap="truncate-end">
        {view.header}
      </Text>
      {view.lines.map((line, index) => (
        <Text key={lineKey(index)} color={toneColor(line.tone)} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
