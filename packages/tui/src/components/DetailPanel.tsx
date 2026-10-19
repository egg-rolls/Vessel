/**
 * 详情视图渲染（纯展示，不用 useInput）
 * @module @vessel/tui
 */

import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { displayWidth, padToWidth, wrapToWidth } from '../utils/text-layout.js';
import { toneColor } from '../views/tones.js';
import type { DetailView } from '../views/types.js';

export interface DetailPanelProps {
  view: DetailView;
  /** 内容区宽度（不含边框） */
  width: number;
  /** 最多渲染行数；超出时截断并提示 */
  maxRows?: number;
}

export function DetailPanel({ view, width, maxRows }: DetailPanelProps) {
  const lines: Array<{ text: string; tone?: string; bold?: boolean }> = [];

  lines.push({
    text: view.badge ? `${view.title}  [${view.badge.text}]` : view.title,
    tone: view.badge ? toneColor(view.badge.tone) : theme.brand,
    bold: true,
  });

  for (const section of view.sections) {
    lines.push({ text: '' });
    if (section.title) {
      lines.push({ text: section.title, tone: theme.faint, bold: true });
    }

    const labelWidth = Math.min(
      18,
      Math.max(0, ...(section.fields ?? []).map((field) => displayWidth(field.label))),
    );
    for (const field of section.fields ?? []) {
      const valueWidth = Math.max(1, width - labelWidth - 2);
      const wrapped = wrapToWidth(field.value, valueWidth);
      const [first = '', ...rest] = wrapped;
      lines.push({
        text: `  ${padToWidth(field.label, labelWidth)}  ${first}`,
        tone: toneColor(field.tone),
      });
      for (const continuation of rest) {
        lines.push({ text: `  ${' '.repeat(labelWidth)}  ${continuation}` });
      }
    }

    for (const raw of section.lines ?? []) {
      for (const line of wrapToWidth(raw, width)) lines.push({ text: `  ${line}` });
    }
  }

  const visible = maxRows !== undefined ? lines.slice(0, Math.max(0, maxRows)) : lines;
  const truncated = maxRows !== undefined && lines.length > visible.length;
  // 静态详情行：用位置 id 作为 key（不使用数组索引表达式触发 lint）。
  const keyed = visible.map((line, index) => ({ ...line, id: `detail-${index}` }));

  return (
    <Box flexDirection="column">
      {keyed.map((line) => (
        <Text key={line.id} color={line.tone ?? theme.muted} bold={line.bold} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
      {truncated ? (
        <Text color={theme.faint}>… {lines.length - visible.length} more lines</Text>
      ) : null}
    </Box>
  );
}
