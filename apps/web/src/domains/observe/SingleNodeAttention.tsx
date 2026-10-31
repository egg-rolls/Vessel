/**
 * Attention 单节点视图：与 0.22 的收件箱行为一致。
 *
 * 纯搬移自 AttentionPanel.tsx，逻辑不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import { useNodes } from '../../gateway/NodeProvider';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { AttentionRow } from './AttentionRow';
import { ATTENTION_PAGE_SIZE, appendInteractions, isAttentionAuthError } from './attention';
import { type AttentionStatus, interactionRoute } from './attention-shared';

/** 单节点：与 0.22 的收件箱行为一致。 */
export function SingleNodeAttention({ navigate }: { navigate: (route: Route) => void }) {
  useLocale();
  const { hasToken, epoch, tenantEpoch, tenantId } = useConnection();
  const { current: node, fetchAttention } = useNodes();
  const [status, setStatus] = useState<AttentionStatus>('pending');
  /** 加载更多得到的后续页（只存追加部分）。 */
  const [more, setMore] = useState<{
    items: ListedInteraction[];
    nextCursor?: string;
  } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** 分页身份：切状态 / tenant / epoch / 节点后，旧的在途“加载更多”不得落地。 */
  const pageKey = `${epoch}:${tenantEpoch}:${tenantId ?? ''}:${status}:${node?.name ?? ''}`;
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;

  const tenantParam = tenantId ? { tenant_id: tenantId } : {};
  const resource = useResource({
    load: () =>
      node
        ? fetchAttention(node, {
            status,
            limit: ATTENTION_PAGE_SIZE,
            order: 'newest',
            ...tenantParam,
          })
        : Promise.reject(new Error('no current node')),
    enabled: hasToken && node !== null,
    deps: [epoch, tenantEpoch, tenantId, status, node?.name ?? ''],
  });
  // 手动 Refresh 与全局刷新都丢掉追加页 / cursor，避免已答行残留在 more 里。
  const refreshAll = useCallback(() => {
    setMore(null);
    setMoreError(null);
    resource.reload();
  }, [resource.reload]);
  useRefreshSignal(refreshAll);

  // 状态 / tenant / epoch 变化：丢掉上一轮追加的页，从第一页重新开始。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些键就是分页身份
  useEffect(() => {
    setMore(null);
    setMoreError(null);
  }, [epoch, tenantEpoch, tenantId, status]);

  // 分页身份变化后，旧请求的数据在 effect 落地前必须先隐藏，避免串状态。
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
  // 一旦加载过后续页，就由后续页的 cursor 决定是否还有更多。
  const nextCursor = more ? more.nextCursor : firstPage?.next_cursor;
  const total = firstPage?.total ?? items.length;
  const firstError = current && resource.state.status === 'error' ? resource.state : undefined;
  const authError =
    firstError !== undefined && isAttentionAuthError(firstError.code, firstError.error);

  const loadMore = async () => {
    if (!node || !nextCursor || loadingMoreRef.current) return;
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

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('observe.attention.noToken')}
        reason={t('observe.attention.noTokenReason')}
      />
    );
  }
  if (authError) {
    return (
      <NotEnabledState
        title={t('observe.attention.forbidden')}
        reason={t('observe.attention.forbiddenReason')}
      />
    );
  }

  const firstLoading =
    !current ||
    (items.length === 0 &&
      (resource.state.status === 'loading' || resource.state.status === 'idle'));

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.attention.hint')}
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
        <Button size="small" onClick={refreshAll} disabled={resource.refreshing}>
          {resource.refreshing ? t('observe.attention.refreshing') : t('observe.attention.refresh')}
        </Button>
        <span className="text-muted">{t('observe.attention.total', { count: total })}</span>
      </div>

      <div id="attention-panel" role="tabpanel" aria-label={t('observe.attention.panelLabel')}>
        {firstLoading ? (
          <LoadingState label={t('observe.attention.loading')} />
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
                    const target = node ? interactionRoute(item, node) : null;
                    return (
                      <AttentionRow
                        key={item.request_id}
                        item={item}
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
      </div>
    </div>
  );
}
