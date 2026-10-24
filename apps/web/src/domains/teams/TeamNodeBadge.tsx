/** Team 所属节点的徽标；只显示人类可读名称，不铺开原始 node_id。 */
import type { NodeView } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';

export function TeamNodeBadge({ node }: { node: NodeView }) {
  useLocale();
  const nodeNames = useNodeNames();
  return (
    <div className="teams-detail-node">
      <span className="teams-node-badge">{nodeNames.get(nodeKeyOf(node)) ?? '—'}</span>
      {node.current && (
        <span className="teams-node-current">{t('observe.attention.currentNode')}</span>
      )}
    </div>
  );
}
