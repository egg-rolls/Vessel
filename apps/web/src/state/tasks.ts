/** 只读任务板 / agent 树的纯选择器（无 React 依赖）。 */
import type { AgentCard, TaskEntry } from '../gateway/types';

export function sortTasks(tasks: readonly TaskEntry[]): TaskEntry[] {
  return [...tasks].sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
}

export interface AgentCardRow {
  card: AgentCard;
  depth: number;
}

/**
 * 按 parent_id 深度优先展开；父节点缺失 / 成环时挂到根，保证每个节点只出现一次。
 */
export function flattenAgentCards(nodes: readonly AgentCard[]): AgentCardRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, AgentCard[]>();
  const roots: AgentCard[] = [];
  for (const node of nodes) {
    const parentId = node.parent_id;
    if (parentId !== undefined && parentId !== node.id && byId.has(parentId)) {
      const list = children.get(parentId);
      if (list) list.push(node);
      else children.set(parentId, [node]);
    } else {
      roots.push(node);
    }
  }

  const rows: AgentCardRow[] = [];
  const seen = new Set<string>();
  const visit = (card: AgentCard, depth: number) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    rows.push({ card, depth });
    for (const child of children.get(card.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const node of nodes) {
    if (!seen.has(node.id)) visit(node, 0);
  }
  return rows;
}
