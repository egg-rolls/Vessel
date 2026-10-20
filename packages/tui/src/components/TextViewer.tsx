/**
 * 长文本 pager（R0 §4.3）
 * @module @vessel-agent/tui
 *
 * 只改渲染：`CommandResult` 形状不变。仅 Ink TTY 路径使用。
 */

import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { theme } from '../theme.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { displayWidth, lineKey, truncateToWidth } from '../utils/text-layout.js';
import { viewWidth } from '../views/layout.js';
import { PanelFrame } from './PanelFrame.js';

/** 纯函数：长度 >180 列或非空行 >2 行走 overlay pager */
export function shouldPageOutput(text: string): boolean {
  if (displayWidth(text) > 180) return true;
  return text.split('\n').filter((line) => line.trim().length > 0).length > 2;
}

/** 纯函数：页高 max(5, rows - 6) */
export function pagerRows(rows: number): number {
  return Math.max(5, Math.floor(Number.isFinite(rows) ? rows : 24) - 6);
}

export interface TextViewerProps {
  title: string;
  lines: string[];
  columns: number;
  rows: number;
  onClose: () => void;
}

export function TextViewer({ title, lines, columns, rows, onClose }: TextViewerProps) {
  // 展示层统一清洗控制序列；`\r` 归一化后可能拆出额外行。
  const safeLines = useMemo(
    () => lines.flatMap((line) => sanitizeTerminalText(line).split('\n')),
    [lines],
  );
  const page = pagerRows(rows);
  const maxOffset = Math.max(0, safeLines.length - page);
  const [offset, setOffset] = useState(0);
  const clamp = (value: number) => Math.max(0, Math.min(maxOffset, value));

  useInput((inputChar, key) => {
    if (key.escape || inputChar === 'q') {
      onClose();
      return;
    }
    if (key.upArrow || inputChar === 'k') {
      setOffset((value) => clamp(value - 1));
      return;
    }
    if (key.downArrow || inputChar === 'j') {
      setOffset((value) => clamp(value + 1));
      return;
    }
    if (key.return || inputChar === ' ' || key.pageDown) {
      setOffset((value) => clamp(value + page));
      return;
    }
    if (inputChar === 'b' || key.pageUp) {
      setOffset((value) => clamp(value - page));
      return;
    }
    if (inputChar === 'g') {
      setOffset(0);
      return;
    }
    if (inputChar === 'G' || (key.shift && inputChar === 'g')) {
      setOffset(maxOffset);
    }
  });

  const visible = safeLines.slice(offset, offset + page);
  const width = viewWidth(columns);

  return (
    <PanelFrame
      width={width}
      title={title}
      hints="↑↓/jk scroll · enter/pgdn page · b/pgup · g/G · esc close"
      variant="double"
    >
      <Box flexDirection="column">
        {visible.map((line, index) => (
          <Text key={lineKey(index)} color={theme.muted} wrap="truncate-end">
            {truncateToWidth(line, Math.max(1, width - 4))}
          </Text>
        ))}
        <Text color={theme.faint}>
          {safeLines.length === 0
            ? 'empty'
            : `${offset + 1}-${offset + visible.length} of ${safeLines.length}`}
        </Text>
      </Box>
    </PanelFrame>
  );
}
