/**
 * 长文本 pager（R0 §4.3）
 * @module @vessel/tui
 *
 * 只改渲染：`CommandResult` 形状不变。仅 Ink TTY 路径使用。
 */

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';
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
  const page = pagerRows(rows);
  const maxOffset = Math.max(0, lines.length - page);
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

  const visible = lines.slice(offset, offset + page);
  const width = viewWidth(columns);
  let cursor = 0;
  const keyed = visible.map((line) => {
    const key = `${cursor}`;
    cursor += line.length;
    return { line, key };
  });

  return (
    <PanelFrame
      width={width}
      title={title}
      hints="↑↓/jk scroll · enter/pgdn page · b/pgup · g/G · esc close"
      variant="double"
    >
      <Box flexDirection="column">
        {keyed.map(({ line, key }) => (
          <Text key={key} color={theme.muted} wrap="truncate-end">
            {truncateToWidth(line, Math.max(1, width - 4))}
          </Text>
        ))}
        <Text color={theme.faint}>
          {lines.length === 0
            ? 'empty'
            : `${offset + 1}-${offset + visible.length} of ${lines.length}`}
        </Text>
      </Box>
    </PanelFrame>
  );
}
