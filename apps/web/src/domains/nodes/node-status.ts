/**
 * 节点健康展示（G3c）：当前节点用 `health.get`，其它平台节点用
 * `platform.nodes.list` 的 `status`。两者都缺省时保持 pending。
 */

import type { NodeView } from '../../gateway/NodeProvider';
import { t } from '../../i18n';
import type { NodeHealthEntry } from '../../stores/nodeStore';

export type NodeStatusKind = 'connected' | 'unreachable' | 'pending';

export function nodeStatusKind(
  entry: NodeHealthEntry | undefined,
  node: Pick<NodeView, 'status'>,
): NodeStatusKind {
  if (entry?.health) return 'connected';
  if (entry?.error) return 'unreachable';
  if (node.status === 'up') return 'connected';
  if (node.status === 'down') return 'unreachable';
  return 'pending';
}

export function nodeStatusLabel(
  entry: NodeHealthEntry | undefined,
  node: Pick<NodeView, 'status'>,
): string {
  if (entry?.health) return t('nodes.health.ok');
  if (entry?.error) return t('nodes.health.error');
  if (node.status === 'up') return t('nodes.health.ok');
  if (node.status === 'down') return t('nodes.health.error');
  if (node.status === 'unknown') return t('nodes.health.unknown');
  return t('nodes.health.loading');
}
