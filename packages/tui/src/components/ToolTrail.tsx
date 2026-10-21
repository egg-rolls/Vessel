/**
 * Tool trail（0.18：渲染 ToolCallView）
 * @module @vessel-agent/tui
 *
 * 同一轮内连续工具调用可聚合为一个 trail（live 视图的紧凑形式）。
 * history 不再经过这里：`<Static>` 按 `UiItem.kind === 'tool'` 逐项渲染完整工具卡。
 */

import { Box, Text } from 'ink';
import { t } from '../i18n/index.js';
import type { ToolCallView } from '../repl/project/ui-item.js';
import { lineKey } from '../utils/text-layout.js';
import { formatDuration, type ItemTone, toneColor } from './UiItemView.js';

export type TrailTone = ItemTone;

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

function detailText(view: ToolCallView): string {
  const duration = formatDuration(view.durationMs);
  const parts = [view.title, view.subtitle ?? '', duration ? `(${duration})` : ''].filter(
    (part) => part.length > 0,
  );
  let text = parts.join('  ');
  if (view.status === 'failed' && view.error) {
    const firstLine = view.error.split('\n').find((line) => line.trim()) ?? '';
    text += `  ${t('tool.trail.failedWith', { error: firstLine })}`;
  }
  return text;
}

function lineTone(view: ToolCallView): TrailTone {
  if (view.status === 'failed') return 'danger';
  if (view.status === 'running') return 'warn';
  return 'muted';
}

/** 纯函数：生成 trail 头与明细；hidden 返回 null */
export function buildTrail(
  views: ToolCallView[],
  mode: 'hidden' | 'collapsed' | 'expanded',
): TrailView | null {
  if (mode === 'hidden' || views.length === 0) return null;

  const failed = views.some((view) => view.status === 'failed');
  const running = views.some((view) => view.status === 'running');
  const glyph = failed ? '✗' : running ? '●' : '✓';
  const headerTone: TrailTone = failed ? 'danger' : running ? 'warn' : 'ok';
  const totalMs = views.reduce(
    (sum, view) => sum + (view.durationMs !== undefined ? view.durationMs : 0),
    0,
  );
  const suffix = totalMs > 0 ? ` · ${formatDuration(totalMs)}` : '';
  const header = t('tool.trail.header', { glyph, count: views.length, suffix });

  const visible = mode === 'collapsed' ? views.slice(-1) : views.slice(-EXPANDED_MAX);
  const hiddenCount = views.length - visible.length;
  const lines: TrailLine[] = [];

  if (mode === 'expanded' && hiddenCount > 0) {
    lines.push({ text: t('tool.trail.earlier', { count: hiddenCount }), tone: 'faint' });
  }

  visible.forEach((view, index) => {
    const last = index === visible.length - 1;
    lines.push({ text: `${last ? '└─' : '├─'} ${detailText(view)}`, tone: lineTone(view) });
  });

  return { header, headerTone, lines };
}

interface ToolTrailProps {
  views: ToolCallView[];
  mode: 'hidden' | 'collapsed' | 'expanded';
}

export function ToolTrail({ views, mode }: ToolTrailProps) {
  const view = buildTrail(views, mode);
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
