/**
 * `?` quick help（R0 §4.5）
 * @module @vessel/tui
 *
 * 输入框内容恰为 `?` 时打开；独占焦点，Backspace / Esc 关闭。
 * `/help` 完整面板不受影响。
 */

import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { padToWidth } from '../utils/text-layout.js';
import { viewWidth } from '../views/layout.js';
import { PanelFrame } from './PanelFrame.js';

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['/help', 'Show all commands'],
  ['/clear', 'Clear transcript'],
  ['/resume', 'Resume a session'],
  ['/details', 'Tool trail verbosity'],
  ['/compact', 'Compress conversation'],
];

const HOTKEYS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+C', 'Cancel run'],
  ['Ctrl+O', 'Full transcript'],
  ['Ctrl+L', 'Redraw'],
  ['↑ ↓', 'History / queue'],
  ['Tab', 'Complete'],
  ['Esc', 'Close / cancel'],
];

/** 纯函数：只在空输入框刚输入 `?` 时打开 */
export function shouldOpenQuickHelp(previousInput: string, nextInput: string): boolean {
  return previousInput === '' && nextInput === '?';
}

function pairLine(
  left: readonly [string, string] | undefined,
  right: readonly [string, string] | undefined,
): string {
  const leftText = left ? `${padToWidth(left[0], 10)} ${padToWidth(left[1], 22)}` : ' '.repeat(33);
  const rightText = right ? `${padToWidth(right[0], 9)} ${right[1]}` : '';
  return `${leftText}  ${rightText}`.trimEnd();
}

export interface QuickHelpProps {
  columns: number;
  rows: number;
  onClose: () => void;
}

export function QuickHelp({ columns, rows, onClose }: QuickHelpProps) {
  useInput((_input, key) => {
    if (key.escape || key.backspace || key.delete) onClose();
  });

  const maxRows = Math.max(5, rows - 6);
  const body = [
    `${padToWidth('Common commands', 33)}  Hotkeys`,
    ...Array.from({ length: Math.max(COMMANDS.length, HOTKEYS.length) }, (_, index) =>
      pairLine(COMMANDS[index], HOTKEYS[index]),
    ),
  ].slice(0, maxRows);
  let offset = 0;
  const keyed = body.map((line) => {
    const key = `${offset}`;
    offset += line.length;
    return { line, key };
  });

  return (
    <PanelFrame
      width={viewWidth(columns)}
      title="? quick help"
      hints="type /help for the full panel · backspace to dismiss"
      variant="round"
    >
      <Box flexDirection="column">
        {keyed.map(({ line, key }, index) => (
          <Text key={key} color={index === 0 ? theme.brand : theme.muted} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </PanelFrame>
  );
}
