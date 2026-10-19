/**
 * 底部按键提示（由 ViewAction 生成，不硬编码业务键）
 * @module @vessel/tui
 */

import { Text } from 'ink';
import { theme } from '../theme.js';
import type { ViewAction } from '../views/types.js';

export interface KeyHintsProps {
  actions: ViewAction[];
  /** 附加提示（如 "↑↓/jk move"） */
  extra?: string;
  /** 当前选中行上不可用的动作键；用 `(n/a)` 标记，不依赖颜色 */
  disabledKeys?: string[];
}

/** 纯函数：`↑↓ move · enter resume · r rename · x delete (n/a) · esc close` */
export function formatKeyHints(
  actions: ViewAction[],
  extra?: string,
  disabledKeys: string[] = [],
): string {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  for (const action of actions) {
    const disabled = disabledKeys.includes(action.key) ? ' (n/a)' : '';
    parts.push(`${action.key} ${action.label}${disabled}`);
  }
  parts.push('esc close');
  return parts.join(' · ');
}

export function KeyHints({ actions, extra, disabledKeys = [] }: KeyHintsProps) {
  // 提示必须固定单行：换行会多占 1 行，把底栏顶出预算。
  return (
    <Text color={theme.faint} wrap="truncate-end">
      {formatKeyHints(actions, extra, disabledKeys)}
    </Text>
  );
}
