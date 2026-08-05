/**
 * 内联命令补全组件
 *
 * 纯视觉组件 —— 不用 useInput，不捕获键盘。
 * 键盘处理由父组件 InkRepl 的 useInput 完成。
 * 当过滤结果为空时返回 null（不渲染任何东西）。
 */

import { Box, Text } from 'ink';
import { useMemo } from 'react';

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
}

/** 纯函数：按 filter 模糊匹配命令（substring，大小写不敏感）。命令名匹配排在前，描述匹配排在后。 */
export function filterCommands(commands: CommandItem[], filter: string): CommandItem[] {
  if (!filter) return commands;
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

export function InlineAutocomplete({ commands, filter, selectedIndex }: InlineAutocompleteProps) {
  const filtered = useMemo(() => filterCommands(commands, filter), [commands, filter]);

  if (filtered.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {filtered.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === selectedIndex ? 'cyan' : 'white'} bold={i === selectedIndex}>
            {i === selectedIndex ? '❯ ' : '  '}
            {cmd.name}
          </Text>
          <Text color="gray"> — {cmd.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
