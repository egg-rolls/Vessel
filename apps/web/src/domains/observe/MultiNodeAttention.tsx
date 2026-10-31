/**
 * Attention 多节点视图：每个节点独立加载；某个节点 401 / 网络失败只影响该分组。
 *
 * 纯搬移自 AttentionPanel.tsx，逻辑不变。
 */
import { useState } from 'react';
import type { Route } from '../../app/router';
import { NotEnabledState } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import type { AttentionStatus } from './attention-shared';
import { NodeAttentionGroup } from './NodeAttentionGroup';

/** 多节点：每个节点独立加载；某个节点 401 / 网络失败只影响该分组。 */
export function MultiNodeAttention({ navigate }: { navigate: (route: Route) => void }) {
  useLocale();
  const { hasToken } = useConnection();
  const { nodes } = useNodes();
  const nodeNames = useNodeNames();
  const [status, setStatus] = useState<AttentionStatus>('pending');
  const [refreshSeq, setRefreshSeq] = useState(0);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('observe.attention.noToken')}
        reason={t('observe.attention.noTokenReason')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.attention.nodesHint')}
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <SegmentedTabs<AttentionStatus>
          label={t('observe.attention.statusLabel')}
          tabs={[
            { id: 'pending', label: t('observe.attention.status.pending') },
            { id: 'orphaned', label: t('observe.attention.status.orphaned') },
          ]}
          value={status}
          onChange={setStatus}
          panelId="attention-panel"
        />
        <Button size="small" onClick={() => setRefreshSeq((value) => value + 1)}>
          {t('observe.attention.refresh')}
        </Button>
      </div>

      <div
        id="attention-panel"
        role="tabpanel"
        aria-label={t('observe.attention.panelLabel')}
        className="flex flex-col gap-4.5"
      >
        {nodes.map((node) => (
          <NodeAttentionGroup
            key={`${node.current ? 'current' : 'extra'}:${node.name}`}
            node={node}
            displayName={nodeNames.get(nodeKeyOf(node)) ?? '—'}
            status={status}
            refreshSeq={refreshSeq}
            navigate={navigate}
          />
        ))}
      </div>
    </div>
  );
}
