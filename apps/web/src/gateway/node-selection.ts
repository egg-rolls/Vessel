/**
 * 平台模式节点选择（G3c，CONTRACT-0.49-node-g3 §7）。
 *
 * `platform.nodes.list` 是平台模式唯一节点来源。选择顺序：
 * 持久化 `node_id`（仍存在且 up）→ 第一个 up → 第一个节点。
 *
 * 持久化只写 sessionStorage，值是 `node_id`；不写 localStorage / URL / 日志。
 * 这不是 token：token 仍由 `nodes.ts` 按 `node_id` 分槽存放。
 */
import type { PlatformNodeSummary } from './types/platform';

export const NODE_SELECTION_KEY = 'vessel.node-selection';

/** `null` = 按顺序选中的节点就是期望节点；否则表示发生回退的原因。 */
export type NodeSelectionFallback = 'missing' | 'down';

export interface PlatformNodeSelection {
  node: PlatformNodeSummary;
  fallback: NodeSelectionFallback | null;
}

function sessionStore(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** 读取持久化选择；值就是 `node_id`（不是展示名）。 */
export function readSelectedNodeId(): string | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const value = store.getItem(NODE_SELECTION_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function writeSelectedNodeId(nodeId: string | null): void {
  const store = sessionStore();
  if (!store) return;
  try {
    if (nodeId === null) store.removeItem(NODE_SELECTION_KEY);
    else store.setItem(NODE_SELECTION_KEY, nodeId);
  } catch {
    // 隐私模式 / 配额满：选择只在当前页面生命周期内生效。
  }
}

function firstUp(nodes: readonly PlatformNodeSummary[]): PlatformNodeSummary | undefined {
  return nodes.find((node) => node.status === 'up');
}

/**
 * 纯选择函数。
 *
 * - `preferredNodeId` 存在且（`requirePreferredUp` 为 false 或状态为 up）→ 直接用；
 * - 期望节点已不在列表 → 回退 `missing`；
 * - 期望节点存在但非 up 且要求 up → 回退 `down`；
 * - 回退目标按「第一个 up → 第一个节点」。
 *
 * `requirePreferredUp = false` 用于用户显式切换：用户点了哪个就尝试哪个，
 * 不在切换瞬间二次猜测。
 */
export function resolvePlatformNodeSelection(
  nodes: readonly PlatformNodeSummary[],
  preferredNodeId: string | null,
  requirePreferredUp = true,
): PlatformNodeSelection | null {
  if (nodes.length === 0) return null;

  let fallback: NodeSelectionFallback | null = null;
  if (preferredNodeId) {
    const preferred = nodes.find((node) => node.node_id === preferredNodeId);
    if (preferred && (!requirePreferredUp || preferred.status === 'up')) {
      return { node: preferred, fallback: null };
    }
    fallback = preferred ? 'down' : 'missing';
  }

  const node = firstUp(nodes) ?? nodes[0];
  return node === undefined ? null : { node, fallback };
}
