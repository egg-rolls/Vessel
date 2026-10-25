/** Team 所属节点的徽标；只显示人类可读名称，不铺开原始 node_id。 */
import type { NodeView } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';

export function TeamNodeBadge({ node }: { node: NodeView }) {
  useLocale();
  const nodeNames = useNodeNames();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="whitespace-nowrap rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">
        {nodeNames.get(nodeKeyOf(node)) ?? '—'}
      </span>
      {node.current && (
        <span className="whitespace-nowrap rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-ink">
          {t('observe.attention.currentNode')}
        </span>
      )}
    </div>
  );
}
