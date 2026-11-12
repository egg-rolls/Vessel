/**
 * 「待批」汇集页：所有待回答的 ask 提问按 agent / 会话聚簇。
 *
 * 数据源：useConnection().asks（interactionStore 的 pending ask，实时事件 +
 * 既有 interactions.list(status=pending) 补回）。不新开 store、不新增 RPC。
 *
 * 三条展示面各管一段，互不替代：
 * - 会话：Composer 槽位的 AskCard（原同步等待行为不变）+ 会话栏「待批」入口；
 * - 团队：TeamPendingBar（成员会话的请求）；
 * - 本页：所有来源的总汇集，带聚类与**逐题回复**（每题独立勾选，可只回复其中几题）。
 */
import { useMemo, useState } from 'react';
import { EmptyState } from '../../components/States';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { PageFrame } from '../settings/PageFrame';
import { asksForSession, groupPendingAsks } from './cluster';
import { PendingClusterCard } from './PendingClusterCard';

/** 空串表示「用户手动收起了默认展开项」，与「未操作」区分开。 */
const COLLAPSED = '';

export function PendingView({ sessionId }: { sessionId?: string }) {
  useLocale();
  const { asks } = useConnection();
  const [override, setOverride] = useState<string | null>(null);

  const clusters = useMemo(() => groupPendingAsks(asks), [asks]);

  // 从某个会话的「待批」入口进来时，默认展开那一簇；不做过滤（待批显示总的）。
  const focusKey = useMemo(() => {
    if (sessionId === undefined || sessionId === '') return null;
    const hit = clusters.find(
      (cluster) =>
        cluster.sessionId === sessionId || asksForSession(cluster.requests, sessionId).length > 0,
    );
    return hit?.key ?? null;
  }, [clusters, sessionId]);

  const expandedKey = override ?? focusKey;

  return (
    <PageFrame title={t('pending.title')} subtitle={t('pending.subtitle')}>
      {clusters.length === 0 ? (
        // 空态：内容在页内水平 + 垂直居中（复用既有 EmptyState，不自建一套）。
        // `text-center` 由外壳继承到标题 / 说明，`min-h-60` 给出垂直居中的高度基准
        // （与 `NotEnabledState variant="page"` 同一口径）。
        <div className="flex min-h-60 flex-col items-center justify-center text-center">
          <EmptyState title={t('pending.empty')} description={t('pending.empty.hint')} />
        </div>
      ) : (
        clusters.map((cluster) => (
          <PendingClusterCard
            key={cluster.key}
            cluster={cluster}
            expanded={cluster.key === expandedKey}
            onToggle={() => setOverride(expandedKey === cluster.key ? COLLAPSED : cluster.key)}
          />
        ))
      )}
    </PageFrame>
  );
}
