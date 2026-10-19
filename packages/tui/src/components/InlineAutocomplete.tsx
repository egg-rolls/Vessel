/**
 * 内联命令补全组件
 *
 * 纯视觉组件 —— 不用 useInput，不捕获键盘。
 * 键盘处理由父组件 InkRepl 的 useInput 完成。
 * 当过滤结果为空时返回 null（不渲染任何东西）。
 */

import { Box, Text, useStdout } from 'ink';
import { useMemo } from 'react';
import { theme } from '../theme.js';
import { computeDialogWidth, displayWidth, truncateToWidth } from '../utils/dialog.js';

export interface CommandItem {
  name: string;
  description: string;
  usage?: string;
}

interface InlineAutocompleteProps {
  /** 全部可选命令列表（已格式化为 "/<name>"） */
  commands: CommandItem[];
  /** 用户当前输入中 "/" 之后的部分（空字符串 = 刚输入 "/"，显示全部） */
  filter: string;
  /** 当前高亮索引 */
  selectedIndex: number;
  /** 矮终端下可见条数上限；默认 MAX_VISIBLE_COMMANDS */
  maxVisible?: number;
}

/**
 * 首屏优先展示的常用命令（按此顺序）。
 * `/` 打开补全时条目很多，这四个必须出现在第一屏；其余保持注册顺序。
 */
export const DISCOVERY_PRIORITY = ['/help', '/new', '/history', '/clear'] as const;

/** 纯函数：把常用命令提到最前；其余保持原有（注册）顺序（sort 稳定）。 */
export function sortCommandsForDiscovery(commands: CommandItem[]): CommandItem[] {
  const rank = new Map<string, number>(
    DISCOVERY_PRIORITY.map((name, index) => [name, index] as const),
  );
  return [...commands].sort((a, b) => {
    const aRank = rank.get(a.name);
    const bRank = rank.get(b.name);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return 0;
  });
}

/** 纯函数：按 filter 模糊匹配命令（substring，大小写不敏感）。命令名匹配排在前，描述匹配排在后。 */
export function filterCommands(commands: CommandItem[], filter: string): CommandItem[] {
  // 空 filter = 浏览全部命令：常用命令置顶，保证第一屏可见。
  if (!filter) return sortCommandsForDiscovery(commands);
  const lower = filter.toLowerCase();
  const filtered = commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(lower) || cmd.description.toLowerCase().includes(lower),
  );
  // 命令名匹配优先于描述匹配
  return filtered.sort((a, b) => {
    const aName = a.name.toLowerCase().includes(lower);
    const bName = b.name.toLowerCase().includes(lower);
    if (aName && !bName) return -1;
    if (!aName && bName) return 1;
    return 0;
  });
}

/** 补全框最多可见的条数（超出时围绕选中项滚动） */
export const MAX_VISIBLE_COMMANDS = 8;
/** 选中项上方保留的条数 */
const VISIBLE_BEFORE_SELECTED = 3;

export interface VisibleCommandWindow {
  /** 切片起点（含） */
  start: number;
  /** 切片终点（不含） */
  end: number;
}

/**
 * 纯函数：计算补全框可见窗口，围绕 selectedIndex 滚动。
 * 结果始终落在 [0, total] 内；total=0 时返回空窗口。
 */
export function getVisibleCommandWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number = MAX_VISIBLE_COMMANDS,
): VisibleCommandWindow {
  if (total <= 0 || maxVisible <= 0) return { start: 0, end: 0 };
  const size = Math.min(maxVisible, total);
  const maxStart = Math.max(0, total - size);
  const start = Math.min(Math.max(0, selectedIndex - VISIBLE_BEFORE_SELECTED), maxStart);
  return { start, end: start + size };
}

/** Enter 键的"补全 vs 执行"决策结果 */
export type CommandEnterDecision =
  | { readonly action: 'complete'; readonly commandName: string }
  | { readonly action: 'execute' };

/**
 * 纯函数：决定 Enter 应补全命令名还是执行。
 *
 * 规则（仅在命令名阶段--`/` 开头且无空格--考虑补全）：
 * - 输入精确匹配某命令名 -> 执行（如 `/resume`）
 * - 输入未完成、且补全列表有选中项 -> 补全到选中命令名，不执行（如 `/res` -> `/resume`）
 * - 其它（带参数、无匹配、非命令）-> 执行
 *
 * 抽成纯函数便于单测；历史上 `isCompleted` 的双斜杠 bug 即此处逻辑出错。
 */
export function decideCommandEnter(
  value: string,
  allCommands: CommandItem[],
  filteredCommands: CommandItem[],
  autocompleteIndex: number,
): CommandEnterDecision {
  if (value.startsWith('/') && !value.includes(' ')) {
    const isExact = allCommands.some((cmd) => cmd.name === value);
    if (!isExact) {
      const selected = filteredCommands[autocompleteIndex];
      if (selected && selected.name !== value) {
        return { action: 'complete', commandName: selected.name };
      }
    }
  }
  return { action: 'execute' };
}

export function InlineAutocomplete({
  commands,
  filter,
  selectedIndex,
  maxVisible = MAX_VISIBLE_COMMANDS,
}: InlineAutocompleteProps) {
  const { stdout } = useStdout();
  const width = computeDialogWidth(stdout.columns);
  const filtered = useMemo(() => filterCommands(commands, filter), [commands, filter]);

  if (filtered.length === 0) return null;

  const { start, end } = getVisibleCommandWindow(filtered.length, selectedIndex, maxVisible);
  // 内容区宽度 = 弹窗宽度 - 边框(2) - 左右内边距(2)；行 = 标记(2) + 命令名 + " · " + 描述
  const contentWidth = Math.max(1, width - 4);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
      width={width}
      overflow="hidden"
    >
      {filtered.slice(start, end).map((cmd, offset) => {
        const i = start + offset;
        const active = i === selectedIndex;
        const descriptionBudget = Math.max(1, contentWidth - 2 - displayWidth(cmd.name) - 3);
        return (
          <Box key={cmd.name}>
            <Text color={active ? theme.brand : theme.muted} bold={active}>
              {active ? '› ' : '  '}
              {cmd.name}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {' · '}
              {truncateToWidth(cmd.description, descriptionBudget)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
