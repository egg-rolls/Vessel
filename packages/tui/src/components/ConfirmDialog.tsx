/**
 * 确认弹窗组件
 * 图形弹窗替换 readline confirm()
 *
 * 权限确认的关键约束：
 * - 默认选中 **No**（Enter 不盲批准）；
 * - 展示工具入参摘要（例如 bash 的 command），否则用户不知道自己批准了什么；
 * - Esc = 拒绝；
 * - 显示与 core 一致的 120s 超时倒计时。
 */

import { Box, Text, useInput, useStdout, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { computeDialogWidth } from '../utils/dialog.js';

export type ConfirmChoice = 'y' | 'n' | 'always';

interface ConfirmDialogProps {
  question: string;
  /** 工具入参摘要（每行一条） */
  details?: string[];
  /** 初始选中项，默认 'n' */
  defaultChoice?: ConfirmChoice;
  /** 超时时间点（epoch ms）；传入则显示倒计时 */
  expiresAt?: number;
  onConfirm: (answer: ConfirmChoice) => void;
}

/** 纯函数：左右切换选中项（测试用） */
export function moveConfirmSelection(
  current: ConfirmChoice,
  direction: 'left' | 'right',
): ConfirmChoice {
  const order: ConfirmChoice[] = ['y', 'n', 'always'];
  const index = order.indexOf(current);
  const next = direction === 'left' ? index - 1 : index + 1;
  if (next < 0 || next >= order.length) return current;
  return order[next] ?? current;
}

/**
 * 纯函数：选项文本。
 * 选中项始终带 `▸` 前缀，保证 NO_COLOR / 16 色终端下也能看出焦点。
 */
export function formatConfirmChoice(choice: ConfirmChoice, selected: boolean): string {
  const label =
    choice === 'y' ? t('confirm.yes') : choice === 'n' ? t('confirm.no') : t('confirm.always');
  return `${selected ? '▸' : ' '}${label} `;
}

export function ConfirmDialog({
  question,
  details = [],
  defaultChoice = 'n',
  expiresAt,
  onConfirm,
}: ConfirmDialogProps) {
  const { stdout } = useStdout();
  // useStdout 不订阅 resize：优先 useWindowSize，保证弹窗宽度即时跟随窗口。
  const windowSize = useWindowSize();
  const width = computeDialogWidth(windowSize.columns > 0 ? windowSize.columns : stdout.columns);
  const [selected, setSelected] = useState<ConfirmChoice>(defaultChoice);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds =
    expiresAt !== undefined ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;

  useInput((inputChar, key) => {
    if (key.leftArrow) {
      setSelected((prev) => moveConfirmSelection(prev, 'left'));
      return;
    }

    if (key.rightArrow) {
      setSelected((prev) => moveConfirmSelection(prev, 'right'));
      return;
    }

    if (key.return) {
      onConfirm(selected);
      return;
    }

    // Esc = 拒绝（不批准任何东西）
    if (key.escape) {
      onConfirm('n');
      return;
    }

    if (inputChar === 'y' || inputChar === 'Y') {
      setSelected('y');
      onConfirm('y');
      return;
    }

    if (inputChar === 'n' || inputChar === 'N') {
      setSelected('n');
      onConfirm('n');
      return;
    }

    if (inputChar === 'a' || inputChar === 'A') {
      setSelected('always');
      onConfirm('always');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
      marginY={1}
      width={width}
      overflow="hidden"
    >
      <Box marginBottom={1}>
        <Text bold color={theme.warn}>
          {t('confirm.title')}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text wrap="wrap">{question}</Text>
      </Box>

      {details.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {details.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: details are a short immutable list
            <Text key={index} color={theme.muted} wrap="wrap">
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box>
        <Text
          backgroundColor={selected === 'y' ? theme.ok : undefined}
          color={selected === 'y' ? theme.selectedInk : theme.ok}
          bold={selected === 'y'}
        >
          {formatConfirmChoice('y', selected === 'y')}
        </Text>
        <Text
          backgroundColor={selected === 'n' ? theme.danger : undefined}
          color={selected === 'n' ? theme.selectedInk : theme.danger}
          bold={selected === 'n'}
        >
          {formatConfirmChoice('n', selected === 'n')}
        </Text>
        <Text
          backgroundColor={selected === 'always' ? theme.info : undefined}
          color={selected === 'always' ? theme.selectedInk : theme.info}
          bold={selected === 'always'}
        >
          {formatConfirmChoice('always', selected === 'always')}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.faint}>
          {t('confirm.hint')}
          {remainingSeconds !== null
            ? ` · ${t('confirm.secondsLeft', { count: remainingSeconds })}`
            : ''}
        </Text>
      </Box>
    </Box>
  );
}
