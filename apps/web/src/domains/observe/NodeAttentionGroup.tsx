/**
 * Attention 多节点聚合中的一个节点分组：独立分页、独立失败、独立只读提示。
 *
 * 纯搬移自 AttentionPanel.tsx，逻辑不变。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AttentionRow } from './AttentionRow';
import { ATTENTION_PAGE_SIZE, appendInteractions, isAttentionAuthError } from './attention';
import { type AttentionStatus, interactionRoute, pageOrigin } from './attention-shared';

/** 多节点聚合中的一个节点分组：独立分页、独立失败、独立只读提示。 */
export function NodeAttentionGroup({
  node,
  displayName,
  status,
  refreshSeq,
  navigate,
}: {
  node: NodeView;
  displayName: string;
  status: AttentionStatus;
  refreshSeq: number;
  navigate: (route: Route) => void;
}) {
  useLocale();
  const { hasToken, epoch, tenantEpoch, tenantId } = useConnection();
  const { fetchAttention } = useNodes();
  const [more, setMore] = useState<{
    items: ListedInteraction[];
    nextCursor?: string;
  } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** 每个节点自己的分页身份；切节点 / 状态 / tenant / epoch / 手动刷新都重置。 */
  const pageKey = `${node.name}:${epoch}:${tenantEpoch}:${tenantId ?? ''}:${status}:${refreshSeq}`;
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;

  const tenantParam = tenantId ? { tenant_id: tenantId } : {};
  const resource = useResource({
    load: () =>
      fetchAttention(node, {
        status,
        limit: ATTENTION_PAGE_SIZE,
        order: 'newest',
        ...tenantParam,
      }),
    enabled: hasToken,
    deps: [node.name, node.url, epoch, tenantEpoch, tenantId, status, refreshSeq],
  });
  useRefreshSignal(() => {
    setMore(null);
    setMoreError(null);
    resource.reload();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些键就是分页身份
  useEffect(() => {
    setMore(null);
    setMoreError(null);
  }, [pageKey]);

  const [settledKey, setSettledKey] = useState(pageKey);
  useEffect(() => {
    if (resource.state.status === 'success' || resource.state.status === 'error') {
      setSettledKey(pageKey);
    }
  }, [resource.state, pageKey]);
  const current = settledKey === pageKey;

  const firstPage = current ? resourceData(resource.state) : undefined;
  const items = useMemo(
    () => (current ? appendInteractions(firstPage?.interactions ?? [], more?.items ?? []) : []),
    [current, firstPage, more],
  );
  const nextCursor = more ? more.nextCursor : firstPage?.next_cursor;
  const total = firstPage?.total ?? items.length;
  const firstError = current && resource.state.status === 'error' ? resource.state : undefined;
  const authError =
    firstError !== undefined && isAttentionAuthError(firstError.code, firstError.error);

  const loadMore = async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const keyAtStart = pageKeyRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchAttention(node, {
        status,
        limit: ATTENTION_PAGE_SIZE,
        order: 'newest',
        cursor: nextCursor,
        ...tenantParam,
      });
      if (pageKeyRef.current !== keyAtStart) return;
      setMore((prev) => ({
        items: appendInteractions(prev?.items ?? [], page.interactions),
        ...(page.next_cursor !== undefined ? { nextCursor: page.next_cursor } : {}),
      }));
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : String(error));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const firstLoading =
    !current ||
    (items.length === 0 &&
      (resource.state.status === 'loading' || resource.state.status === 'idle'));

  return (
    <section className="flex flex-col gap-2" aria-label={displayName}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{displayName}</span>
        {node.current && (
          <span className="rounded-full border border-line px-1.5 py-px text-xs uppercase tracking-wider text-muted">
            {t('observe.attention.currentNode')}
          </span>
        )}
        <span className="truncate font-mono text-muted">
          {displayGatewayUrl(node.url, pageOrigin())}
        </span>
        <span className="ml-auto tabular-nums text-muted">
          {t('observe.attention.total', { count: total })}
        </span>
      </div>
      {!node.current && (
        <p className="m-0 text-sm text-faint">{t('observe.attention.remoteReadonly')}</p>
      )}

      {firstLoading ? (
        <LoadingState label={t('observe.attention.loading')} rows={2} />
      ) : authError ? (
        <NotEnabledState
          title={t('observe.attention.forbidden')}
          reason={t('observe.attention.forbiddenReason')}
        />
      ) : firstError && items.length === 0 ? (
        <ErrorState message={firstError.error} onRetry={resource.reload} />
      ) : (
        <>
          {firstError && (
            <StaleNotice message={t('observe.attention.stale')} onRetry={resource.reload} />
          )}
          {items.length === 0 ? (
            <EmptyState
              title={
                status === 'pending'
                  ? t('observe.attention.empty.pending')
                  : t('observe.attention.empty.orphaned')
              }
              description={t('observe.attention.emptyHint')}
            />
          ) : (
            <div className="attention-list">
              <div className="attention-head" aria-hidden="true">
                <span>{t('observe.attention.col.kind')}</span>
                <span>{t('observe.attention.col.request')}</span>
                <span>{t('observe.attention.col.tool')}</span>
                <span>{t('observe.attention.col.agent')}</span>
                <span>{t('observe.attention.col.team')}</span>
                <span>{t('observe.attention.col.time')}</span>
              </div>
              <ul className="attention-items">
                {items.map((item) => {
                  // 只有当前节点的会话可以跳转；其它节点行只读。
                  const target = node.current ? interactionRoute(item, node) : null;
                  return (
                    <AttentionRow
                      key={item.request_id}
                      item={item}
                      readonly={!node.current}
                      {...(target ? { onOpen: () => navigate(target) } : {})}
                    />
                  );
                })}
              </ul>
            </div>
          )}

          {nextCursor && (
            <Button
              variant="plain"
              className="mx-auto mt-2 rounded-full px-3.5 py-2 text-xs text-muted"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? t('observe.attention.loadingMore') : t('observe.attention.loadMore')}
            </Button>
          )}
          {moreError && <ErrorState message={moreError} onRetry={() => void loadMore()} />}
        </>
      )}
    </section>
  );
}
