/**
 * Observe → Attention：待处理收件箱（DECISION-038 §2.4）。
 *
 * 单节点时保持原体验；配置了额外节点后按节点只读聚合（S9.4）：
 * 每个节点独立分页 / 独立失败，只有当前节点的会话可以跳转。
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
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { ATTENTION_PAGE_SIZE, appendInteractions, isAttentionAuthError } from './attention';

type AttentionStatus = 'pending' | 'orphaned';

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** 有 session 去会话；否则有 team 去该节点的 Team；都没有则不跳转。 */
function interactionRoute(item: ListedInteraction, node: NodeView): Route | null {
  if (item.session_id) return { domain: 'chat', sessionId: item.session_id };
  if (item.team_id) {
    return { domain: 'teams', nodeKey: nodeKeyOf(node), teamId: item.team_id };
  }
  return null;
}

function AttentionRow({
  item,
  onOpen,
  readonly,
}: {
  item: ListedInteraction;
  onOpen?: () => void;
  readonly?: boolean;
}) {
  const createdAt = new Date(item.created_at);
  const iso = Number.isNaN(createdAt.getTime()) ? undefined : createdAt.toISOString();
  const cells = (
    <>
      <span className="attention-kind mono">{item.kind}</span>
      <span className="attention-request mono" title={item.request_id}>
        {item.request_id}
      </span>
      <span className="attention-cell mono">{item.tool ?? '—'}</span>
      <span className="attention-cell mono">{item.agent_id ?? '—'}</span>
      <span className="attention-cell mono">{item.team_id ?? '—'}</span>
      <time className="attention-time mono" {...(iso ? { dateTime: iso } : {})}>
        {formatTimestamp(item.created_at) || '—'}
      </time>
    </>
  );

  return (
    <li className="attention-item">
      {onOpen ? (
        <button type="button" className="attention-row attention-row-open" onClick={onOpen}>
          {cells}
        </button>
      ) : (
        <div
          className="attention-row"
          {...(readonly ? { title: t('observe.attention.remoteRowHint') } : {})}
        >
          {cells}
        </div>
      )}
    </li>
  );
}

/** 单节点：与 0.22 的收件箱行为一致。 */
function SingleNodeAttention({ navigate }: { navigate: (route: Route) => void }) {
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
    <div className="settings-section">
      <p className="section-desc">{t('observe.attention.hint')}</p>
      <div className="filter-bar">
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
        <button
          type="button"
          className="btn btn-small"
          onClick={refreshAll}
          disabled={resource.refreshing}
        >
          {resource.refreshing ? t('observe.attention.refreshing') : t('observe.attention.refresh')}
        </button>
        <span className="dim">{t('observe.attention.total', { count: total })}</span>
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
              <button
                type="button"
                className="load-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? t('observe.attention.loadingMore') : t('observe.attention.loadMore')}
              </button>
            )}
            {moreError && <ErrorState message={moreError} onRetry={() => void loadMore()} />}
          </>
        )}
      </div>
    </div>
  );
}

/** 多节点聚合中的一个节点分组：独立分页、独立失败、独立只读提示。 */
function NodeAttentionGroup({
  node,
  status,
  refreshSeq,
  navigate,
}: {
  node: NodeView;
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
    <section className="attention-node" aria-label={node.name}>
      <div className="attention-node-head">
        <span className="attention-node-name">{node.name}</span>
        {node.current && (
          <span className="attention-node-badge">{t('observe.attention.currentNode')}</span>
        )}
        <span className="mono dim attention-node-url">
          {displayGatewayUrl(node.url, pageOrigin())}
        </span>
        <span className="dim attention-node-total">
          {t('observe.attention.total', { count: total })}
        </span>
      </div>
      {!node.current && (
        <p className="attention-readonly">{t('observe.attention.remoteReadonly')}</p>
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
            <button
              type="button"
              className="load-more"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? t('observe.attention.loadingMore') : t('observe.attention.loadMore')}
            </button>
          )}
          {moreError && <ErrorState message={moreError} onRetry={() => void loadMore()} />}
        </>
      )}
    </section>
  );
}

/** 多节点：每个节点独立加载；某个节点 401 / 网络失败只影响该分组。 */
function MultiNodeAttention({ navigate }: { navigate: (route: Route) => void }) {
  useLocale();
  const { hasToken } = useConnection();
  const { nodes } = useNodes();
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
    <div className="settings-section">
      <p className="section-desc">{t('observe.attention.nodesHint')}</p>
      <div className="filter-bar">
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
        <button
          type="button"
          className="btn btn-small"
          onClick={() => setRefreshSeq((value) => value + 1)}
        >
          {t('observe.attention.refresh')}
        </button>
      </div>

      <div
        id="attention-panel"
        role="tabpanel"
        aria-label={t('observe.attention.panelLabel')}
        className="attention-nodes"
      >
        {nodes.map((node) => (
          <NodeAttentionGroup
            key={`${node.current ? 'current' : 'extra'}:${node.name}`}
            node={node}
            status={status}
            refreshSeq={refreshSeq}
            navigate={navigate}
          />
        ))}
      </div>
    </div>
  );
}

export function AttentionPanel({ navigate }: { navigate: (route: Route) => void }) {
  useLocale();
  const { nodes } = useNodes();
  return nodes.length > 1 ? (
    <MultiNodeAttention navigate={navigate} />
  ) : (
    <SingleNodeAttention navigate={navigate} />
  );
}
