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

/** 纯函数：按 filter 模糊匹配命令（substring，大小写不敏感） */
export function filterCommands(commands: CommandItem[], filter: string): CommandItem[] {
  if (!filter) return commands;
  const lower = filter.toLowerCase();
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(lower) || cmd.description.toLowerCase().includes(lower),
  );
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
