/**
 * 内联命令补全组件
 *
 * 纯视觉组件 —— 不用 useInput，不捕获键盘。
 * 键盘处理由父组件 InkRepl 的 useInput 完成。
 * 当过滤结果为空时返回 null（不渲染任何东西）。
 */

import { Box, Text, useStdout, useWindowSize } from 'ink';
import { useMemo } from 'react';
import type { CommandCategory } from '../commands/commands.js';
import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { computeDialogWidth, displayWidth, truncateToWidth } from '../utils/dialog.js';

export interface CommandItem {
  name: string;
  description: string;
  usage?: string;
  category?: CommandCategory;
  keywords?: string[];
  /** hidden 命令不进入补全（visibleList 已过滤，这里再兜一层） */
  hidden?: boolean;
  /** 当前上下文是否可用；false 显示不可用原因标签 */
  available?: boolean;
  /** 不可用原因（如 'RPC required'）；缺省显示 'unavailable' */
  unavailableHint?: string;
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
  /** 最近成功执行的命令名（不含斜杠），空 query 时优先 */
  recent?: string[];
}

/**
 * 首屏优先展示的常用命令（按此顺序）。
 * `/resume` 是唯一会话入口，必须排第一。
 */
export const DISCOVERY_PRIORITY = ['/resume', '/new', '/help', '/history', '/clear'] as const;

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: 'SESSION',
  run: 'RUN',
  inspect: 'INSPECT',
  config: 'CONFIG',
  system: 'SYSTEM',
};

function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const ch of text) {
    if (ch === query[index]) index += 1;
    if (index >= query.length) return true;
  }
  return query.length === 0;
}

/**
 * 纯函数：命令模糊评分。
 * name 前缀 100 / name 子串 80 / keywords 前缀 60 / keywords 子串 50 /
 * description 子串 30 / 子序列 20；不匹配 0。
 */
export function scoreCommand(query: string, command: CommandItem): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = command.name.toLowerCase();
  if (name.startsWith(`/${q}`) || name.startsWith(q)) return 100;
  if (name.includes(q)) return 80;

  const keywords = (command.keywords ?? []).map((keyword) => keyword.toLowerCase());
  if (keywords.some((keyword) => keyword.startsWith(q))) return 60;
  if (keywords.some((keyword) => keyword.includes(q))) return 50;

  if (command.description.toLowerCase().includes(q)) return 30;

  if (isSubsequence(q, name.slice(1))) return 20;
  return 0;
}

function discoveryRank(name: string): number {
  const index = (DISCOVERY_PRIORITY as readonly string[]).indexOf(name);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function recentRank(name: string, recent: string[]): number {
  const index = recent.indexOf(name.startsWith('/') ? name.slice(1) : name);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

/** 纯函数：把常用/最近命令提到最前；其余保持原有（注册）顺序（sort 稳定）。 */
export function sortCommandsForDiscovery(
  commands: CommandItem[],
  recent: string[] = [],
): CommandItem[] {
  return [...commands].sort((a, b) => {
    const aRecent = recentRank(a.name, recent);
    const bRecent = recentRank(b.name, recent);
    if (aRecent !== bRecent) return aRecent - bRecent;
    const aRank = discoveryRank(a.name);
    const bRank = discoveryRank(b.name);
    if (aRank !== bRank) return aRank - bRank;
    return 0;
  });
}

export interface CommandFilterOptions {
  recent?: string[];
}

/** 纯函数：按 filter 模糊匹配命令；hidden 不出现。 */
export function filterCommands(
  commands: CommandItem[],
  filter: string,
  options: CommandFilterOptions = {},
): CommandItem[] {
  const visible = commands.filter((command) => !command.hidden);
  const recent = options.recent ?? [];

  // 空 filter = 浏览全部命令：最近使用 > 常用命令 > 注册顺序。
  if (!filter) return sortCommandsForDiscovery(visible, recent);

  const scored = visible
    .map((command, index) => ({ command, index, score: scoreCommand(filter, command) }))
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aRecent = recentRank(a.command.name, recent);
    const bRecent = recentRank(b.command.name, recent);
    if (aRecent !== bRecent) return aRecent - bRecent;
    const aRank = discoveryRank(a.command.name);
    const bRank = discoveryRank(b.command.name);
    if (aRank !== bRank) return aRank - bRank;
    return a.index - b.index;
  });

  return scored.map((entry) => entry.command);
}

export type AutocompleteRow =
  | { kind: 'header'; key: string; label: string; category: CommandCategory }
  | { kind: 'command'; key: string; command: CommandItem; index: number };

/**
 * 纯函数：把（已排序的）命令列表展开成可渲染行，在 category 变化处插入组头。
 * 组头不是可选项：`index` 始终指向命令在扁平列表中的位置，选中索引不会漂移。
 * 组头也占用 `maxVisible` 行数，避免矮终端里补全框溢出。
 */
export function buildAutocompleteRows(commands: CommandItem[], headings = true): AutocompleteRow[] {
  const rows: AutocompleteRow[] = [];
  let previous: CommandCategory | null = null;

  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    if (!command || command.hidden) continue;
    const category = command.category ?? 'system';
    if (headings && category !== previous) {
      rows.push({
        kind: 'header',
        key: `header-${index}-${category}`,
        label: CATEGORY_LABELS[category],
        category,
      });
    }
    previous = category;
    rows.push({
      kind: 'command',
      key: `command-${command.name}`,
      command,
      index,
    });
  }

  return rows;
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
  recent = [],
}: InlineAutocompleteProps) {
  const { stdout } = useStdout();
  // useStdout 不订阅 resize：优先 useWindowSize，保证补全框宽度即时跟随窗口。
  const windowSize = useWindowSize();
  const width = computeDialogWidth(windowSize.columns > 0 ? windowSize.columns : stdout.columns);
  const filtered = useMemo(
    () => filterCommands(commands, filter, { recent }),
    [commands, filter, recent],
  );

  if (filtered.length === 0) return null;

  // 命令名阶段（无过滤词）按 category 插入组头；输入过滤词后只保留扁平排名。
  const rows = buildAutocompleteRows(filtered, filter.length === 0);
  const selectedRowIndex = Math.max(
    0,
    rows.findIndex((row) => row.kind === 'command' && row.index === selectedIndex),
  );
  const { start, end } = getVisibleCommandWindow(rows.length, selectedRowIndex, maxVisible);
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
      {rows.slice(start, end).map((row) => {
        if (row.kind === 'header') {
          return (
            <Text key={row.key} color={theme.faint} bold wrap="truncate-end">
              {row.label}
            </Text>
          );
        }

        const cmd = row.command;
        const active = row.index === selectedIndex;
        const availability =
          cmd.available === false
            ? ` (${cmd.unavailableHint ?? t('autocomplete.unavailable')})`
            : '';
        const descriptionBudget = Math.max(
          1,
          contentWidth - 2 - displayWidth(cmd.name) - 3 - displayWidth(availability),
        );
        return (
          <Box key={row.key}>
            <Text color={active ? theme.brand : theme.muted} bold={active}>
              {active ? '› ' : '  '}
              {cmd.name}
            </Text>
            <Text color={theme.faint} wrap="truncate-end">
              {' · '}
              {truncateToWidth(cmd.description, descriptionBudget)}
              {availability}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
