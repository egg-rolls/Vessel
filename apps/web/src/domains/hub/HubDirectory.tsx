/**
 * Hub 目录视图：只读展示 Hub 上报的节点元数据（CONTRACT-0.49 §8）。
 *
 * 不显示 token；配对 / join / token 管理归 Nodes 与 CLI（DECISION-041）。
 */

import { EmptyState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button, DataTable, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type {
  HubDirectory as HubDirectoryData,
  HubNodeRecord,
  HubNodeStatus,
  HubPointerFrame,
} from '../../gateway/platform/hub-types';
import { t } from '../../i18n';

const NODE_STATUS: Record<HubNodeStatus, { kind: string; labelKey: string }> = {
  connecting: { kind: 'pending', labelKey: 'hub.node.status.connecting' },
  healthy: { kind: 'connected', labelKey: 'hub.node.status.healthy' },
  unreachable: { kind: 'unreachable', labelKey: 'hub.node.status.unreachable' },
  incompatible: { kind: 'unavailable', labelKey: 'hub.node.status.incompatible' },
  unauthorized: { kind: 'failed', labelKey: 'hub.node.status.unauthorized' },
  identity_mismatch: { kind: 'failed', labelKey: 'hub.node.status.identityMismatch' },
};

function nodeName(node: HubNodeRecord): string {
  return node.name ?? node.alias ?? node.node_id;
}

function dataPlaneLabel(node: HubNodeRecord): string {
  if (node.data_plane === 'direct') return t('hub.directory.dataPlane.direct');
  if (node.data_plane === 'unreachable') return t('hub.directory.dataPlane.unreachable');
  return '—';
}

export function HubDirectory({
  directory,
  url,
  live,
  reconnecting,
  pointer,
  onDisconnect,
  onRetry,
}: {
  directory: HubDirectoryData;
  url: string;
  live: boolean;
  reconnecting: boolean;
  pointer: HubPointerFrame | null;
  onDisconnect(): void;
  onRetry(): void;
}) {
  const versionLabel =
    directory.version !== undefined
      ? ` · ${t('hub.directory.version', { version: directory.version })}`
      : '';
  return (
    <div className="flex flex-col gap-3">
      {!live && (
        <StaleNotice
          message={reconnecting ? t('hub.directory.reconnecting') : t('hub.directory.connecting')}
          onRetry={onRetry}
        />
      )}
      {pointer !== null && (
        <p className="text-sm text-info" role="status" aria-live="polite">
          {t('hub.directory.pointer', { node: pointer.node_id })}
        </p>
      )}

      <Section
        title={t('hub.directory.title')}
        description={`${t('hub.directory.description', { url, hub: directory.hub_id })}${versionLabel}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRetry}>{t('common.retry')}</Button>
            <Button onClick={onDisconnect}>{t('hub.connect.clear')}</Button>
          </div>
        }
      >
        {directory.nodes.length === 0 ? (
          <EmptyState title={t('hub.directory.empty')} description={t('hub.directory.emptyHint')} />
        ) : (
          <DataTable<HubNodeRecord>
            columns={[
              {
                key: 'name',
                header: t('hub.directory.col.name'),
                cellClassName: 'font-mono',
                cell: (node) => nodeName(node),
              },
              {
                key: 'status',
                header: t('hub.directory.col.status'),
                cell: (node) => {
                  const meta = NODE_STATUS[node.status];
                  return <StatusChip status={meta.kind} label={t(meta.labelKey)} />;
                },
              },
              {
                key: 'teams',
                header: t('hub.directory.col.teams'),
                hide: 'compact',
                cellClassName: 'font-mono',
                cell: (node) => node.counts.teams,
              },
              {
                key: 'agents',
                header: t('hub.directory.col.agents'),
                hide: 'compact',
                cellClassName: 'font-mono',
                cell: (node) => node.counts.agents,
              },
              {
                key: 'liveAgents',
                header: t('hub.directory.col.liveAgents'),
                hide: 'compact',
                cellClassName: 'font-mono',
                cell: (node) => node.counts.live_agents,
              },
              {
                key: 'lastSeen',
                header: t('hub.directory.col.lastSeen'),
                hide: 'wide',
                cellClassName: 'font-mono',
                cell: (node) => formatTimestamp(node.last_seen) || '—',
              },
              {
                key: 'dataPlane',
                header: t('hub.directory.col.dataPlane'),
                hide: 'compact',
                cell: dataPlaneLabel,
              },
            ]}
            rows={directory.nodes}
            rowKey={(node) => node.node_id}
          />
        )}
      </Section>
    </div>
  );
}
