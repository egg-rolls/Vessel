/**
 * Attention 面板的共享视图辅助：状态类型、页面 origin、行跳转。
 *
 * 纯搬移自 AttentionPanel.tsx，逻辑不变。
 */
import type { Route } from '../../app/router';
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import type { NodeView } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';

export type AttentionStatus = 'pending' | 'orphaned';

export function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** 有 session 去会话；否则有 team 去该节点的 Team；都没有则不跳转。 */
export function interactionRoute(item: ListedInteraction, node: NodeView): Route | null {
  if (item.session_id) return { domain: 'chat', sessionId: item.session_id };
  if (item.team_id) {
    return { domain: 'teams', nodeKey: nodeKeyOf(node), teamId: item.team_id };
  }
  return null;
}
