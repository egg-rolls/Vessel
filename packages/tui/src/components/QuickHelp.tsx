/**
 * `?` quick help（R0 §4.5）
 * @module @vessel-agent/tui
 *
 * 输入框内容恰为 `?` 时打开；独占焦点，Backspace / Esc 关闭。
 * `/help` 完整面板不受影响。
 */

import { Box, Text, useInput } from 'ink';
import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { lineKey, padToWidth } from '../utils/text-layout.js';
import { viewWidth } from '../views/layout.js';
import { PanelFrame } from './PanelFrame.js';

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['/help', 'help.cmd.help'],
  ['/clear', 'help.cmd.clear'],
  ['/resume', 'help.cmd.resume'],
  ['/details', 'help.cmd.details'],
  ['/compact', 'help.cmd.compact'],
];

const HOTKEYS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+C', 'help.hotkey.cancelRun'],
  ['Ctrl+O', 'help.hotkey.fullTranscript'],
  ['Ctrl+L', 'help.hotkey.redraw'],
  ['Ctrl+T', 'help.hotkey.toggleTop'],
  ['Ctrl+G', 'help.hotkey.toggleBottom'],
  ['Ctrl+R', 'help.hotkey.sessions'],
  ['↑ ↓', 'help.hotkey.historyQueue'],
  ['Tab', 'help.hotkey.complete'],
  ['Esc', 'help.hotkey.closeCancel'],
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
  const commands = COMMANDS.map(([name, key]) => [name, t(key)] as const);
  const hotkeys = HOTKEYS.map(([name, key]) => [name, t(key)] as const);
  const body = [
    `${padToWidth(t('help.commonCommands'), 33)}  ${t('help.hotkeys')}`,
    ...Array.from({ length: Math.max(commands.length, hotkeys.length) }, (_, index) =>
      pairLine(commands[index], hotkeys[index]),
    ),
  ].slice(0, maxRows);

  return (
    <PanelFrame
      width={viewWidth(columns)}
      title={t('help.title')}
      hints={t('help.hints')}
      variant="round"
    >
      <Box flexDirection="column">
        {body.map((line, index) => (
          <Text
            key={lineKey(index)}
            color={index === 0 ? theme.brand : theme.muted}
            wrap="truncate-end"
          >
            {line}
          </Text>
        ))}
      </Box>
    </PanelFrame>
  );
}
