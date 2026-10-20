/**
 * 面板边框（R0 §4.3）
 * @module @vessel-agent/tui
 *
 * 标题嵌在上边框、键位提示嵌在下边框；中间用 Ink Box 只画左右边框。
 * 手工顶/底行不消耗横向列，宽度与 Box border + paddingX=1 完全一致。
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { theme } from '../theme.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';

export type PanelVariant = 'round' | 'double';

const GLYPHS: Record<
  PanelVariant,
  { tl: string; tr: string; bl: string; br: string; horizontal: string }
> = {
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', horizontal: '─' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', horizontal: '═' },
};

export interface BorderParts {
  lead: string;
  label: string;
  fill: string;
  tail: string;
}

/** 纯函数：把标题/提示嵌进一条边框，总显示宽度恒等于 width */
export function buildBorderParts(
  width: number,
  label: string | undefined,
  variant: PanelVariant,
  edge: 'top' | 'bottom',
): BorderParts {
  const glyphs = GLYPHS[variant];
  const lead = edge === 'top' ? glyphs.tl : glyphs.bl;
  const tail = edge === 'top' ? glyphs.tr : glyphs.br;
  const total = Math.max(2, Math.floor(Number.isFinite(width) ? width : 2));
  const inner = total - 2;

  if (!label) {
    return { lead, label: '', fill: glyphs.horizontal.repeat(inner), tail };
  }

  const text = truncateToWidth(` ${label} `, inner);
  return {
    lead,
    label: text,
    fill: glyphs.horizontal.repeat(Math.max(0, inner - displayWidth(text))),
    tail,
  };
}

export interface PanelFrameProps {
  /** 外框总宽度（含左右边框与 padding） */
  width: number;
  title?: string;
  hints?: string;
  marginY?: number;
  variant?: PanelVariant;
  children: ReactNode;
}

export function PanelFrame({
  width,
  title,
  hints,
  marginY = 0,
  variant = 'round',
  children,
}: PanelFrameProps) {
  const top = buildBorderParts(width, title, variant, 'top');
  const bottom = buildBorderParts(width, hints, variant, 'bottom');

  return (
    <Box flexDirection="column" width={width} marginY={marginY} flexShrink={0}>
      <Text color={theme.panel} wrap="truncate-end">
        {top.lead}
        {top.label ? (
          <Text bold color={theme.brand}>
            {top.label}
          </Text>
        ) : null}
        {top.fill}
        {top.tail}
      </Text>

      <Box
        flexDirection="column"
        width={width}
        borderStyle={variant}
        borderTop={false}
        borderBottom={false}
        borderLeft
        borderRight
        borderColor={theme.panel}
        paddingX={1}
      >
        {children}
      </Box>

      <Text color={theme.panel} wrap="truncate-end">
        {bottom.lead}
        {bottom.label ? <Text color={theme.faint}>{bottom.label}</Text> : null}
        {bottom.fill}
        {bottom.tail}
      </Text>
    </Box>
  );
}
