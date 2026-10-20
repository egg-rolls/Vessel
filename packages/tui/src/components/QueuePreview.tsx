/**
 * 队列预览（R0 §4.2）
 * @module @vessel/tui
 *
 * 3 条滑动窗口；编辑项尽量居中；>3 条显示尾行。
 * 行数由 `computeLiveLayout(rows, queueRows)` 扣除。
 */

import { Box, Text } from 'ink';
import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { lineKey, truncateToWidth } from '../utils/text-layout.js';

export const QUEUE_WINDOW = 3;

export interface QueueWindow {
  start: number;
  end: number;
  showLead: boolean;
  showTail: boolean;
}

export type QueueLineTone = 'faint' | 'brand' | 'muted';

export interface QueueLine {
  text: string;
  tone: QueueLineTone;
}

/** 纯函数：编辑项尽量居中；无编辑时从队首开始 */
export function getQueueWindow(length: number, editIndex: number | null): QueueWindow {
  const start =
    editIndex === null
      ? 0
      : Math.max(0, Math.min(editIndex - 1, Math.max(0, length - QUEUE_WINDOW)));
  const end = Math.min(length, start + QUEUE_WINDOW);
  return { start, end, showLead: start > 0, showTail: end < length };
}

function compactPreview(text: string, width: number): string {
  return truncateToWidth(text.replace(/\s+/g, ' ').trim(), width);
}

/** 纯函数：队列预览文本行 */
export function formatQueuePreview(
  queued: string[],
  editIndex: number | null,
  columns: number,
  rows: number,
): QueueLine[] {
  if (queued.length === 0) return [];
  const width = Math.max(16, Math.floor(columns) - 10);
  const first = queued[0] ?? '';

  if (rows < 12) {
    return [{ text: `▸ 1. ${compactPreview(first, width)}`, tone: 'brand' }];
  }

  const header =
    editIndex === null
      ? t('queue.header', { count: queued.length })
      : t('queue.headerEditing', { count: queued.length, index: editIndex + 1 });
  const lines: QueueLine[] = [{ text: header, tone: 'faint' }];
  const window = getQueueWindow(queued.length, editIndex);
  if (window.showLead) lines.push({ text: '  …', tone: 'faint' });

  for (let index = window.start; index < window.end; index++) {
    const item = queued[index] ?? '';
    const active = index === editIndex;
    lines.push({
      text: `${active ? '▸' : ' '} ${index + 1}. ${compactPreview(item, width)}`,
      tone: active ? 'brand' : 'muted',
    });
  }

  if (window.showTail) {
    lines.push({
      text: `  ${t('queue.more', { count: queued.length - window.end })}`,
      tone: 'faint',
    });
  }
  return lines;
}

export interface QueuePreviewProps {
  queued: string[];
  editIndex: number | null;
  columns: number;
  rows: number;
}

export function QueuePreview({ queued, editIndex, columns, rows }: QueuePreviewProps) {
  const lines = formatQueuePreview(queued, editIndex, columns, rows);
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={2}>
      {lines.map((line, index) => (
        <Text
          key={lineKey(index)}
          color={
            line.tone === 'brand' ? theme.brand : line.tone === 'faint' ? theme.faint : theme.muted
          }
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
