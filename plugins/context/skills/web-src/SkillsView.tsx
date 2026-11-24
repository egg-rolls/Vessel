/**
 * Skills library master-detail view (design §8). One page, two tiers:
 * iframe (PluginRpcClient) and embed (host.rpc) share this component.
 *
 * - Trust badges are server-derived (trustState rule); the frontend only consumes.
 * - trust_set is the only trust write path; rescan rebuilds the index.
 * - Refresh strategy: refetch after mutations + manual refresh + window focus.
 *   No host event subscription (P1 adds no events, design §7).
 * - Content preview is the human surface (§9.5): no trust gate, no loads write.
 *   P1 renders markdown as <pre> (plugin-ui has no embed-reachable markdown
 *   renderer yet; design §8.3 open question 2 — no third-party runtime dep).
 * - 工具页面样式对齐（q-skills-ui）：TableToolbar 单行紧凑工具栏（搜索 + 来源 /
 *   标签下拉 + 重扫 / 刷新），表格 + 分页脚注包进透黑底细线卡片；控件局部 GHOST
 *   覆盖（shared.tsx，不动 plugin-ui 共享组件）；unknown_id 走 MissingSkill
 *   优雅降级，错误一律内联告警卡，不渲染裸错误文本。
 */

import {
  Badge,
  type BadgeTone,
  Button,
  DataTable,
  type DataTableColumn,
  KeyValueList,
  PageScaffold,
  SearchInput,
  Section,
  Select,
  TableToolbar,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Translator } from './i18n';
import {
  EmptyState,
  ErrorState,
  GHOST_BUTTON_CLASS,
  GHOST_CONTROL_CLASS,
  GHOST_PANEL_CLASS,
  isUnknownIdError,
  LoadingState,
  type LoadState,
  toError,
  type ViewProps,
} from './shared';
import type {
  GetResult,
  ListResult,
  LoadsResult,
  RescanResult,
  SkillEntryDto,
  SkillSource,
  TrustSetResult,
  TrustState,
} from './types';

const PAGE_LIMIT = 50;

const TRUST_TONE: Record<TrustState, BadgeTone> = {
  trusted: 'success',
  stale: 'warn',
  unknown: 'neutral',
  revoked: 'danger',
};

function trustLabel(t: Translator, trust: TrustState | undefined): string {
  switch (trust) {
    case 'trusted':
      return t('trust.trusted');
    case 'stale':
      return t('trust.stale');
    case 'revoked':
      return t('trust.revoked');
    default:
      return t('trust.unknown');
  }
}

function TrustBadge({ trust, t }: { trust: TrustState | undefined; t: Translator }) {
  const state = trust ?? 'unknown';
  return <Badge tone={TRUST_TONE[state]}>{trustLabel(t, state)}</Badge>;
}

/** 会话短 id（前 8 位，审计展示用） */
function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/**
 * 选中技能已不存在（unknown_id）时的优雅降级：说明 + 重扫 / 返回列表动作，
 * 不渲染裸错误文本；id 仅作 faint 标识展示。
 */
function MissingSkill({
  id,
  t,
  busy,
  onRescan,
  onBack,
}: {
  id: string;
  t: Translator;
  busy: boolean;
  onRescan: () => void;
  onBack: () => void;
}) {
  return (
    <Section
      title={t('detail.missing.title')}
      description={t('detail.missing.description')}
      actions={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Button size="small" className={GHOST_BUTTON_CLASS} disabled={busy} onClick={onRescan}>
            {t('skills.rescan')}
          </Button>
          <Button size="small" className={GHOST_BUTTON_CLASS} onClick={onBack}>
            {t('detail.backToList')}
          </Button>
        </span>
      }
    >
      <p className="font-mono text-xs text-faint wrap-anywhere">{id}</p>
    </Section>
  );
}

interface Notice {
  kind: 'saved' | 'error';
  text: string;
}

export function SkillsView({ client, refreshKey, t }: ViewProps) {
  const [listState, setListState] = useState<LoadState<ListResult>>({ status: 'loading' });
  const [loadsState, setLoadsState] = useState<LoadState<LoadsResult>>({ status: 'loading' });
  const [detailState, setDetailState] = useState<LoadState<GetResult> | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'' | SkillSource>('');
  const [tag, setTag] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  /** 内部刷新计数：mutation / 手动刷新 / 聚焦统一驱动 */
  const [innerRefresh, setInnerRefresh] = useState(0);

  const refresh = useCallback(() => setInnerRefresh((value) => value + 1), []);

  const loadList = useCallback(async (): Promise<void> => {
    setListState({ status: 'loading' });
    try {
      const data = await client.call<ListResult>('list', {
        ...(query !== '' ? { query } : {}),
        ...(source !== '' ? { source } : {}),
        ...(tag !== '' ? { tag } : {}),
        offset,
        limit: PAGE_LIMIT,
      });
      setListState({ status: 'ready', data });
    } catch (error) {
      setListState({ status: 'error', error: toError(error) });
    }
  }, [client, query, source, tag, offset]);

  const loadLoads = useCallback(async (): Promise<void> => {
    try {
      const data = await client.call<LoadsResult>('loads');
      setLoadsState({ status: 'ready', data });
    } catch (error) {
      setLoadsState({ status: 'error', error: toError(error) });
    }
  }, [client]);

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      setDetailState({ status: 'loading' });
      try {
        const data = await client.call<GetResult>('get', { id });
        setDetailState({ status: 'ready', data });
      } catch (error) {
        setDetailState({ status: 'error', error: toError(error) });
      }
    },
    [client],
  );

  // 列表：过滤 / 分页 / 刷新驱动；query 输入去抖 250ms
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh counters are explicit refetch triggers.
  useEffect(() => {
    const timer = setTimeout(() => void loadList(), query !== '' ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadList, refreshKey, innerRefresh, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh counters are explicit refetch triggers.
  useEffect(() => {
    void loadLoads();
  }, [loadLoads, refreshKey, innerRefresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh counters are explicit refetch triggers.
  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
  }, [loadDetail, selectedId, refreshKey, innerRefresh]);

  // 页面聚焦重拉（设计 §8.2；不订阅宿主事件）
  useEffect(() => {
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 过滤变化回到第一页
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are explicit reset triggers.
  useEffect(() => {
    setOffset(0);
  }, [query, source, tag]);

  const items = listState.status === 'ready' ? listState.data.items : [];
  const total = listState.status === 'ready' ? listState.data.total : 0;

  /** 每技能加载会话计数（loads RPC 派生；列表徽标 + 详情清单共用） */
  const loadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (loadsState.status !== 'ready') return counts;
    for (const session of loadsState.data.sessions) {
      const seen = new Set<string>();
      for (const load of session.loaded) {
        if (seen.has(load.id)) continue;
        seen.add(load.id);
        counts.set(load.id, (counts.get(load.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [loadsState]);

  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    for (const item of items) for (const itemTag of item.tags) tags.add(itemTag);
    if (tag !== '') tags.add(tag);
    return [...tags].sort();
  }, [items, tag]);

  async function runRescan(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await client.call<RescanResult>('rescan');
      if (result.error !== undefined) {
        setNotice({ kind: 'error', text: result.error.message });
      } else {
        setNotice({
          kind: 'saved',
          text: t('skills.rescanDone', {
            added: result.added?.length ?? 0,
            removed: result.removed?.length ?? 0,
            changed: result.changed?.length ?? 0,
          }),
        });
        refresh();
      }
    } catch (error) {
      setNotice({ kind: 'error', text: toError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function runTrustSet(id: string, action: 'trust' | 'revoke'): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await client.call<TrustSetResult>('trust_set', { id, action });
      if (result.error !== undefined) {
        if (isUnknownIdError(result.error)) {
          // 技能已不存在：友好提示 + 重拉（详情面板随之走 MissingSkill 降级）。
          setNotice({ kind: 'error', text: t('detail.missing.title') });
          refresh();
        } else {
          setNotice({ kind: 'error', text: result.error.message });
        }
      } else {
        setNotice({ kind: 'saved', text: t('trust.saved') });
        refresh();
      }
    } catch (error) {
      setNotice({ kind: 'error', text: toError(error).message });
    } finally {
      setBusy(false);
    }
  }

  const columns: readonly DataTableColumn<SkillEntryDto>[] = [
    {
      key: 'name',
      header: t('skills.title'),
      cell: (row) => (
        <button
          type="button"
          onClick={() => setSelectedId(row.id)}
          className="inline-flex cursor-pointer flex-wrap items-center gap-1.5 bg-transparent p-0 text-left text-ink hover:text-accent"
        >
          <span className="font-medium">{row.name}</span>
          <Badge>{row.source}</Badge>
          {(loadCounts.get(row.id) ?? 0) > 0 ? (
            <Badge tone="info">{t('loads.count', { n: loadCounts.get(row.id) ?? 0 })}</Badge>
          ) : null}
        </button>
      ),
    },
    {
      key: 'trust',
      header: t('trust.title'),
      cell: (row) => <TrustBadge trust={row.trust} t={t} />,
    },
    {
      key: 'description',
      header: t('detail.content'),
      hide: 'compact',
      cell: (row) => <span className="text-muted">{row.description}</span>,
    },
  ];

  const detail = detailState?.status === 'ready' ? detailState.data : undefined;
  const detailEntry = detail?.entry;
  const detailTrust = detail?.trust ?? 'unknown';
  const detailLoads =
    loadsState.status === 'ready' && selectedId !== null
      ? loadsState.data.sessions.flatMap((session) =>
          session.loaded
            .filter((load) => load.id === selectedId)
            .map((load) => ({ ...load, sessionId: session.sessionId })),
        )
      : [];

  return (
    <PageScaffold title={t('skills.title')} subtitle={t('skills.subtitle')}>
      <TableToolbar label={t('skills.toolbar')}>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('skills.searchPlaceholder')}
          ariaLabel={t('skills.searchAria')}
          className={`grow basis-60 max-w-search ${GHOST_CONTROL_CLASS}`}
        />
        <Select
          value={source}
          onChange={(event) => setSource(event.target.value as '' | SkillSource)}
          aria-label={t('detail.source')}
          className={`w-36 ${GHOST_CONTROL_CLASS}`}
        >
          <option value="">{t('skills.sourceAll')}</option>
          <option value="project">project</option>
          <option value="user">user</option>
          <option value="library">library</option>
        </Select>
        <Select
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          aria-label={t('detail.tags')}
          className={`w-40 ${GHOST_CONTROL_CLASS}`}
        >
          <option value="">{t('skills.tagAll')}</option>
          {tagOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        <Button className={GHOST_BUTTON_CLASS} onClick={() => void runRescan()} disabled={busy}>
          {t('skills.rescan')}
        </Button>
        <Button className={GHOST_BUTTON_CLASS} onClick={refresh}>
          {t('common.refresh')}
        </Button>
        {listState.status === 'ready' ? (
          <span className="ml-1.5 inline-block rounded-full border border-line bg-transparent px-1.5 py-0.5 font-mono text-xs text-muted">
            {items.length}/{total}
          </span>
        ) : null}
      </TableToolbar>

      {notice !== null ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-md border border-line px-3 py-2 text-sm wrap-anywhere ${notice.kind === 'error' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid gap-4 min-wide:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="min-w-0">
          {listState.status === 'loading' ? (
            <LoadingState label={t('common.loading')} />
          ) : listState.status === 'error' ? (
            <ErrorState
              error={listState.error}
              onRetry={() => void loadList()}
              title={t('common.loadError')}
              retryLabel={t('common.retry')}
            />
          ) : total === 0 ? (
            query !== '' || source !== '' || tag !== '' ? (
              <EmptyState title={t('skills.noMatch')} description={t('skills.searchPlaceholder')} />
            ) : (
              <EmptyState
                title={t('skills.empty.title')}
                description={t('skills.empty.description')}
              />
            )
          ) : (
            <div className={`overflow-hidden rounded-md ${GHOST_PANEL_CLASS}`}>
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(row) => row.id}
                activeKey={selectedId ?? undefined}
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-sm text-muted">
                <span>
                  {t('skills.page', { from: offset + 1, to: offset + items.length, total })}
                </span>
                <Button
                  size="small"
                  className={GHOST_BUTTON_CLASS}
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
                >
                  {t('common.prev')}
                </Button>
                <Button
                  size="small"
                  className={GHOST_BUTTON_CLASS}
                  disabled={offset + items.length >= total}
                  onClick={() => setOffset(offset + PAGE_LIMIT)}
                >
                  {t('common.next')}
                </Button>
                <span className="text-faint">
                  {t('skills.generatedAt', { ts: listState.data.generatedAt })}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0">
          {selectedId === null || detailState === null ? (
            <Section title={t('skills.title')} description={t('detail.empty')} />
          ) : detailState.status === 'loading' ? (
            <LoadingState label={t('common.loading')} />
          ) : detailState.status === 'error' ? (
            isUnknownIdError({ message: detailState.error.message }) ? (
              <MissingSkill
                id={selectedId}
                t={t}
                busy={busy}
                onRescan={() => void runRescan()}
                onBack={() => {
                  setSelectedId(null);
                  setDetailState(null);
                }}
              />
            ) : (
              <ErrorState
                error={detailState.error}
                onRetry={() => void loadDetail(selectedId)}
                title={t('common.loadError')}
                retryLabel={t('common.retry')}
              />
            )
          ) : detailEntry === undefined ? (
            isUnknownIdError(detail?.error) ? (
              <MissingSkill
                id={selectedId}
                t={t}
                busy={busy}
                onRescan={() => void runRescan()}
                onBack={() => {
                  setSelectedId(null);
                  setDetailState(null);
                }}
              />
            ) : (
              <Section title={t('detail.contentError')}>
                <p role="alert" className="text-sm text-muted wrap-anywhere">
                  {detail?.error?.message ?? selectedId}
                </p>
              </Section>
            )
          ) : (
            <div className="flex flex-col gap-4">
              <Section
                title={detailEntry.name}
                description={detailEntry.description}
                actions={<TrustBadge trust={detailTrust} t={t} />}
              >
                <KeyValueList
                  items={[
                    { label: t('detail.source'), value: detailEntry.source },
                    { label: t('detail.path'), value: detailEntry.absPath },
                    ...(detailEntry.version !== undefined
                      ? [{ label: t('detail.version'), value: detailEntry.version }]
                      : []),
                    {
                      label: t('detail.tags'),
                      value: detailEntry.tags.length > 0 ? detailEntry.tags.join(', ') : '—',
                    },
                    {
                      label: t('detail.frontmatter'),
                      value: t(`frontmatter.${detailEntry.frontmatter}`),
                    },
                    { label: t('detail.bytes'), value: String(detailEntry.bytes) },
                  ]}
                />
                {detailEntry.warnings !== undefined && detailEntry.warnings.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5 text-sm text-warn">
                    {detailEntry.warnings.map((warning) => (
                      <li key={warning} className="wrap-anywhere">
                        {warning}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Section>
              {detailTrust === 'stale' ? (
                <p role="alert" className="rounded-sm bg-warn-soft px-3 py-2 text-sm text-warn">
                  {t('trust.staleBanner')}
                </p>
              ) : detailTrust === 'revoked' ? (
                <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
                  {t('trust.revokedBanner')}
                </p>
              ) : null}
              <Section title={t('detail.content')}>
                {detail?.error !== undefined ? (
                  <div
                    role="alert"
                    className="rounded-sm border border-line bg-danger-soft px-3 py-2 text-sm text-danger"
                  >
                    <p className="font-medium">{t('detail.contentError')}</p>
                    <p className="mt-1 wrap-anywhere">{detail.error.message}</p>
                  </div>
                ) : (
                  <>
                    {detail?.truncated === true ? (
                      <p className="mb-2 text-sm text-warn">{t('detail.contentTruncated')}</p>
                    ) : null}
                    <pre className="max-h-96 overflow-auto rounded-sm bg-sunken p-3 font-mono text-xs leading-relaxed text-ink whitespace-pre-wrap wrap-anywhere">
                      {detail?.content ?? ''}
                    </pre>
                  </>
                )}
                {detailEntry.auxFiles !== undefined && detailEntry.auxFiles.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-ink">{t('detail.aux')}</p>
                    <p className="text-xs text-faint">{t('detail.auxHint')}</p>
                    <ul className="mt-1 list-disc pl-5 font-mono text-xs text-muted">
                      {detailEntry.auxFiles.map((aux) => (
                        <li key={aux} className="wrap-anywhere">
                          {aux}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>
              <Section title={t('trust.title')} actions={<TrustBadge trust={detailTrust} t={t} />}>
                {detailTrust === 'unknown' ? (
                  <p className="text-sm text-muted">{t('trust.unknownHint')}</p>
                ) : null}
                {detail?.trustRecord !== undefined ? (
                  <KeyValueList
                    items={[
                      {
                        label: t('trust.pinnedHash'),
                        value: (
                          <span className="font-mono text-xs">
                            {detail.trustRecord.sha256 === ''
                              ? '—'
                              : shortId(detail.trustRecord.sha256)}
                          </span>
                        ),
                      },
                      { label: t('trust.recordedAt'), value: detail.trustRecord.recordedAt },
                      { label: t('trust.origin'), value: detail.trustRecord.origin },
                    ]}
                  />
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="small"
                    disabled={busy || detailTrust === 'trusted'}
                    onClick={() => void runTrustSet(detailEntry.id, 'trust')}
                  >
                    {t('trust.trustButton')}
                  </Button>
                  <Button
                    variant="danger"
                    size="small"
                    disabled={busy || detailTrust === 'revoked'}
                    onClick={() => void runTrustSet(detailEntry.id, 'revoke')}
                  >
                    {t('trust.revokeButton')}
                  </Button>
                </div>
              </Section>
              <Section title={t('loads.title')}>
                {detailLoads.length === 0 ? (
                  <p className="text-sm text-muted">{t('loads.none')}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {detailLoads.map((load) => (
                      <li
                        key={`${load.sessionId}-${load.loadedAt}-${load.runId}`}
                        className="flex flex-wrap items-center gap-2 text-muted"
                      >
                        <Badge>{shortId(load.sessionId)}</Badge>
                        <span>{load.loadedAt}</span>
                        <span className="font-mono text-xs text-faint">
                          {t('loads.runId')} {shortId(load.runId)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          )}
        </div>
      </div>
    </PageScaffold>
  );
}
