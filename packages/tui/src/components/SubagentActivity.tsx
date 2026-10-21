/**
 * 子 agent 活动展示（0.18：agent-registry 派生）
 * @module @vessel-agent/tui
 *
 * 数据源与下栏 `sub N` 相同：`agent.*` 事件经 `reduceAgentRegistry` 折叠。
 * live 区只显示仍在运行的成员，行首树形缩进；已结束成员进入 history（agent item）。
 */

import { Box, Text } from 'ink';
import type { AgentNode } from '../repl/agent-registry.js';
import { theme } from '../theme.js';
import { lineKey } from '../utils/text-layout.js';

/** live 区最多显示的成员行数 */
export const MAX_SUBAGENT_LINES = 3;

function isActive(node: AgentNode): boolean {
  return node.state === 'running' || node.state === 'waiting_permission';
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** 纯函数：活跃成员 -> live 活动行（树形缩进，新节点在前） */
export function buildSubagentLines(
  nodes: readonly AgentNode[],
  max = MAX_SUBAGENT_LINES,
): string[] {
  const priority = (node: AgentNode): number => (node.state === 'waiting_permission' ? 1 : 0);
  const active = nodes
    .filter(isActive)
    .sort((a, b) => priority(b) - priority(a) || b.startedAt - a.startedAt)
    .slice(0, Math.max(1, max));
  return active.map((node) => {
    const indent = '  '.repeat(Math.max(0, Math.min(3, node.depth)));
    const task = node.task ? ` · ${truncate(node.task, 40)}` : '';
    const tool = node.currentTool ? ` · ${node.currentTool}` : '';
    return `${indent}↳ agent ${node.id} · ${node.state}${tool}${task}`;
  });
}

export function SubagentActivity({ nodes }: { nodes: readonly AgentNode[] }) {
  const lines = buildSubagentLines(nodes);
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, index) => (
        <Text key={lineKey(index)} color={theme.info} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
