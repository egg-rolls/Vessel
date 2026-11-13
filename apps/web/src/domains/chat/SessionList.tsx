import { Fragment, useEffect, useRef, useState } from 'react';
import { ActionMenu } from '../../components/ActionMenu';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { StatusGlyph } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { IconButton, Tooltip } from '../../components/Tooltip';
import { Button, CountBadge, Input, SearchInput, SidebarShell } from '../../components/ui';
import type { NodeRoster } from '../../gateway/team-roster';
import type { SessionInfo } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { closedAgentSessionIds } from '../../state/archive-visibility';
import { groupSessionsByDay, normalizeSessionTitle, sessionTitle } from '../../state/sessions';

// 会话列表的「已停用 · 待移除」徽标集合：实现在零依赖模块里（门禁探针也要用），
// 这里只做转发，保持原有 import 路径对消费方不变。
export { closedAgentSessionIds };

/**
 * 会话 → agent 地址 `name@node:team`。
 *
 * 只认当前节点的 roster，且成员必须显式 `role: 'member'`、带 session_id / name /
 * team_id；temporary / 旧 gateway 缺字段一律不显示第二行。
 */
export function sessionAgentAddresses(rosters: readonly NodeRoster[]): ReadonlyMap<string, string> {
  const addresses = new Map<string, string>();
  for (const roster of rosters) {
    if (!roster.node.current || !roster.node.name) continue;
    for (const entry of roster.rosters) {
      const teamId = entry.team.team_id;
      if (!teamId) continue;
      for (const member of entry.members) {
        if (member.role !== 'member') continue;
        if (!member.session_id || !member.name) continue;
        addresses.set(member.session_id, `${member.name}@${roster.node.name}:${teamId}`);
      }
    }
  }
  return addresses;
}

/**
 * 会话 → 「所属 agent 已停用」。
 *
 * 为什么按 roster 反查：`SessionInfo` 不带 agent 归属，只有 `teams.get` 的成员行握着
 * `session_id`。反查口径与 `sessionAgentAddresses` 一致（只认当前节点），并且
 * **反查不到就不标**——会话可能在别的节点、可能被 roster 窗口截断、旧 gateway 也可能
 * 没有这条记录，漏标只是少一个徽标，误标却会让人以为自己的会话要没了。
 *
 * 会话本身永不隐藏（0.51 裁决）：agent 没了但历史还在，隐藏等于把找回入口弄丢。
 */

export function SessionList({
  sessions,
  hiddenCount,
  selectedId,
  draftActive,
  pendingBySession,
  pendingAskCount,
  onOpenPending,
  agentAddresses,
  agentLabels,
  agentRetiredLabels,
  defaultSession,
  primarySessionIds,
  query,
  onQueryChange,
  searchSnippets,
  loading,
  error,
  onRetry,
  hasToken,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onViewRuns,
  onShowMore,
  compact,
  onCloseDrawer,
  onOpenConnection,
  writesDisabled,
  renameSignal,
}: {
  sessions: readonly SessionInfo[];
  hiddenCount: number;
  selectedId: string | null;
  draftActive: boolean;
  /** 每个会话的待处理权限/提问数量；其他会话只显示徽标，不渲染卡片。 */
  pendingBySession?: ReadonlyMap<string, number>;
  /** 当前会话待回答的 ask 条数（会话分区「待批」按钮的计数）。 */
  pendingAskCount?: number;
  /** 打开待批汇集页（带当前会话作为默认展开项）。 */
  onOpenPending?: () => void;
  /** session_id → `name@node:team`；只包含显式 member 的当前节点 roster。 */
  agentAddresses?: ReadonlyMap<string, string>;
  /**
   * session_id → `名字@primary`：非 team 成员（临时成员 / 未加入 Team / 不在本 team 的
   * agent）的 primary body 会话。只在拿不到节点地址时顶上，团队成员一个都没有。
   */
  agentLabels?: ReadonlyMap<string, string>;
  /** 已退役 body 的会话：'名字（旧身体）'，灰色（0.52）。 */
  agentRetiredLabels?: ReadonlyMap<string, string>;
  /**
   * 0.27 默认会话入口（`main` 的 primary body）：只在它还没出现在列表行里时补一行，
   * 让空态也有明确的“默认会话”可点。`bodyCount` 用于提示同 agent 还有别的 body。
   */
  defaultSession?: { sessionId: string; label: string; bodyCount: number };
  /** 0.27：属于某 agent primary body 的会话（`bodies[].primary`）；缺省不显示徽标。 */
  primarySessionIds?: ReadonlySet<string>;
  query: string;
  onQueryChange: (value: string) => void;
  /** 服务端搜索命中的片段；query 非空时优先展示。 */
  searchSnippets?: ReadonlyMap<string, string>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasToken: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onRename: (sessionId: string, title: string) => Promise<boolean>;
  onDelete: (session: SessionInfo) => void;
  onViewRuns: (sessionId: string) => void;
  onShowMore: () => void;
  compact: boolean;
  onCloseDrawer: () => void;
  onOpenConnection: () => void;
  /** 断线时禁用重命名/删除，保留只读动作。 */
  writesDisabled: boolean;
  /** 命令面板触发当前会话行内重命名；每次递增。 */
  renameSignal: number;
}) {
  useLocale();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const committing = useRef(false);
  const renameRef = useRef<HTMLInputElement | null>(null);
  // 搜索中不插入默认会话行，避免“无匹配”被一条非搜索结果掩盖；
  // 是否已在列表里出现由调用方判断（它拿得到完整列表，这里只有窗口化的行）。
  const showDefault = defaultSession !== undefined && !query.trim();

  useEffect(() => {
    if (!editingId) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [editingId]);

  const startRename = (session: SessionInfo) => {
    setEditingId(session.session_id);
    setDraft(sessionTitle(session));
    setRenameError(null);
  };

  // 命令面板 → 行内重命名；只在 signal 变化时触发，轮询刷新不会重开编辑器。
  const lastRenameSignal = useRef(0);
  useEffect(() => {
    if (renameSignal === lastRenameSignal.current) return;
    lastRenameSignal.current = renameSignal;
    if (writesDisabled || !selectedId) return;
    const target = sessions.find((session) => session.session_id === selectedId);
    if (!target) return;
    setEditingId(target.session_id);
    setDraft(sessionTitle(target));
    setRenameError(null);
  }, [renameSignal, sessions, selectedId, writesDisabled]);

  const cancelRename = () => {
    setEditingId(null);
    setDraft('');
    setRenameError(null);
  };

  const commitRename = async (sessionId: string) => {
    if (committing.current) return;
    const title = normalizeSessionTitle(draft);
    if (!title) {
      setRenameError(t('chat.sessionList.renameEmpty'));
      return;
    }
    committing.current = true;
    const ok = await onRename(sessionId, title);
    committing.current = false;
    if (ok) cancelRename();
    else setRenameError(t('chat.sessionList.renameFailed'));
  };

  const copyId = (sessionId: string) => {
    if (!navigator.clipboard?.writeText) {
      toast.error(t('common.clipboardUnsupported'));
      return;
    }
    void navigator.clipboard
      .writeText(sessionId)
      .then(() => toast.success(t('chat.session.copiedId')))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  return (
    <SidebarShell
      as="div"
      title={t('chat.sessionList.title')}
      actions={
        <>
          {pendingAskCount !== undefined && pendingAskCount > 0 && onOpenPending !== undefined && (
            <Button
              type="button"
              size="small"
              onClick={onOpenPending}
              aria-label={t('pending.entry.label', { count: pendingAskCount })}
            >
              {t('pending.entry')}
              <CountBadge count={pendingAskCount} />
            </Button>
          )}
          <Button type="button" size="small" variant="primary" onClick={onNew}>
            {t('chat.sessionList.new')}
          </Button>
          {compact && (
            <IconButton label={t('nav.closeSessions')} onClick={onCloseDrawer}>
              ×
            </IconButton>
          )}
        </>
      }
      controls={
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={t('chat.sessionList.search')}
          ariaLabel={t('chat.sessionList.search')}
        />
      }
    >
      {error && sessions.length > 0 && (
        <StaleNotice message={t('common.staleData', { detail: error })} onRetry={onRetry} />
      )}
      {error && sessions.length === 0 ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : !hasToken ? (
        <EmptyState
          title={t('chat.sessionList.noConnection')}
          action={
            <Button type="button" onClick={onOpenConnection}>
              {t('common.configureConnection')}
            </Button>
          }
        />
      ) : loading && sessions.length === 0 ? (
        <LoadingState label={t('chat.sessionList.loading')} />
      ) : sessions.length === 0 && !showDefault ? (
        query.trim() ? (
          <EmptyState
            title={t('chat.sessionList.noMatch', { query: query.trim() })}
            action={
              <Button type="button" onClick={() => onQueryChange('')}>
                {t('common.clearSearch')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={t('chat.sessionList.empty')}
            action={
              <Button type="button" variant="primary" onClick={onNew}>
                {t('common.newSession')}
              </Button>
            }
          />
        )
      ) : (
        <>
          {showDefault && defaultSession && (
            <div
              className={`session-row default ${
                defaultSession.sessionId === selectedId ? 'active' : ''
              }`.trim()}
            >
              <button
                type="button"
                className="session-main"
                aria-current={defaultSession.sessionId === selectedId ? 'true' : undefined}
                onClick={() => onSelect(defaultSession.sessionId)}
              >
                <span className="session-title">
                  <span className="session-title-text">{defaultSession.label}</span>
                </span>
                <span className="session-agent">
                  {defaultSession.bodyCount > 1
                    ? t('team.member.liveBodies', { count: defaultSession.bodyCount })
                    : t('team.member.currentBody')}
                </span>
              </button>
            </div>
          )}
          {draftActive && (
            <div className="session-row draft active">
              <div className="session-main">
                <span className="session-title">{t('chat.draft.title')}</span>
                <span className="session-preview">{t('chat.draft.meta')}</span>
              </div>
            </div>
          )}
          {groupSessionsByDay(sessions).map((group) => (
            <Fragment key={group.key || 'unknown'}>
              {group.label && <div className="sidebar-group-label">{group.label}</div>}
              {group.sessions.map((session) => {
                const active = session.session_id === selectedId;
                const editing = editingId === session.session_id;
                const title = sessionTitle(session);
                const pendingCount = pendingBySession?.get(session.session_id) ?? 0;
                const agentAddress = agentAddresses?.get(session.session_id);
                // 四级第二行（0.52）：
                // 1) 节点地址（只有 roster 有 `node:team`，团队成员的显示一个字都不变）；
                // 2) **会话自带归属**（`session.agent`，additive）：现役 ⇒ `名字@primary` 主题色，
                //    已退役 body ⇒ 同样文本、灰色（颜色承载状态，不另造一套读法）。
                //    这是唯一不依赖反查的一档 ——
                //    rotate 之前的旧身体会话、跨节点会话、agent 已从 roster 消失的会话都靠它；
                // 3) 老 gateway 没下发归属 ⇒ 回落到 roster 反查（`agentLabels` / `agentRetiredLabels`）；
                // 4) 都查不到 ⇒ 原来的 primary 徽标。
                const ownAgent = session.agent;
                const ownAgentName = ownAgent?.name?.trim();
                const agentLabel =
                  agentAddress || ownAgentName ? undefined : agentLabels?.get(session.session_id);
                // 文本对现役与旧身体**一致**（`名字@primary`）：用户 2026-11-13 否掉「名字（旧身体）」——
                // 第二行讲归属，不讲状态；状态交给颜色（现役主题色 / 旧身体 primary 灰）。
                const ownAgentTitle =
                  agentAddress || ownAgentName === undefined
                    ? undefined
                    : `${ownAgentName}@${t('team.member.primaryBadge')}`;
                const ownAgentLive = ownAgent?.primary === true;
                const agentRetiredLabel =
                  agentAddress || ownAgentTitle || agentLabel
                    ? undefined
                    : agentRetiredLabels?.get(session.session_id);
                const agentPrimaryBadge =
                  !agentAddress &&
                  !ownAgentTitle &&
                  !agentLabel &&
                  !agentRetiredLabel &&
                  primarySessionIds?.has(session.session_id) === true;
                const snippet = query.trim() ? searchSnippets?.get(session.session_id) : undefined;
                const preview =
                  snippet ??
                  (session.preview && session.preview !== session.title ? session.preview : '');
                // preview 只进 title tooltip，不再占一行布局。
                const titleTooltip = preview ? `${title} — ${preview}` : title;
                return (
                  <div
                    className={`session-row group ${active ? 'active' : ''}`.trim()}
                    key={session.session_id}
                  >
                    {editing ? (
                      <div className="session-rename">
                        <Input
                          ref={renameRef}
                          value={draft}
                          aria-label={t('chat.sessionList.idLabel')}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void commitRename(session.session_id);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                          onBlur={() => void commitRename(session.session_id)}
                        />
                        {renameError && (
                          <span className="text-xs text-danger leading-snug" role="alert">
                            {renameError}
                          </span>
                        )}
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-main"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => onSelect(session.session_id)}
                        >
                          <span className="session-title">
                            <StatusGlyph status={session.status} />
                            <Tooltip label={titleTooltip}>
                              <span className="session-title-text">{title}</span>
                            </Tooltip>
                            {/* 已命名（title_source='manual'）：只给字形 + tooltip，
                                中性灰、无背景，和状态字形同级，不抢标题注意力。 */}
                            {session.title_source === 'manual' && (
                              <Tooltip label={t('chat.sessionList.named')}>
                                <span
                                  className="flex-none font-mono text-2xs leading-none text-muted"
                                  role="img"
                                  aria-label={t('chat.sessionList.named')}
                                >
                                  ✎
                                </span>
                              </Tooltip>
                            )}
                            {pendingCount > 0 && (
                              <Tooltip label={t('chat.session.pending', { count: pendingCount })}>
                                <span className="session-pending-badge">
                                  <span aria-hidden="true">{pendingCount}</span>
                                  <span className="sr-only">
                                    {t('chat.session.pending', { count: pendingCount })}
                                  </span>
                                </span>
                              </Tooltip>
                            )}
                          </span>
                          {agentAddress && (
                            <span className="session-agent session-agent-address">
                              {agentAddress}
                            </span>
                          )}
                          {ownAgentTitle && (
                            <span
                              className={
                                ownAgentLive
                                  ? 'session-agent session-agent-address'
                                  : 'session-agent session-agent-primary'
                              }
                            >
                              {ownAgentTitle}
                            </span>
                          )}
                          {agentLabel && (
                            // 非 team 成员（临时成员 / 未加入 Team / 不在本 team 的 agent）：
                            // 拿不到节点地址，但用户得看得出卡片是谁的 —— primary 一词仍复用
                            // t('team.member.primaryBadge')，不新增 i18n key。
                            // 现役 ⇒ 主题色（与节点地址同一抹），表达「还活着、可派活」。
                            <span className="session-agent session-agent-address">
                              {agentLabel}
                            </span>
                          )}
                          {agentRetiredLabel && (
                            // 已退役 body 的会话：rotate 之前的旧身体。灰色，与 primary 徽标同档 ——
                            // 它只说明「这具身体当时是谁」，不再代表一个能派活的对象。
                            <span className="session-agent session-agent-primary">
                              {agentRetiredLabel}
                            </span>
                          )}
                          {agentPrimaryBadge && (
                            <span className="session-agent session-agent-primary">
                              {t('team.member.primaryBadge')}
                            </span>
                          )}
                        </button>
                        <ActionMenu
                          className="items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-compact:opacity-100"
                          label={t('chat.sessionList.actions', { title })}
                          items={[
                            {
                              id: 'rename',
                              label: t('chat.sessionList.rename'),
                              disabled: writesDisabled,
                              onSelect: () => startRename(session),
                            },
                            {
                              id: 'copy',
                              label: t('chat.session.copyId'),
                              onSelect: () => copyId(session.session_id),
                            },
                            {
                              id: 'runs',
                              label: t('chat.sessionList.viewRuns'),
                              onSelect: () => onViewRuns(session.session_id),
                            },
                            {
                              id: 'delete',
                              label: t('chat.sessionList.delete'),
                              danger: true,
                              disabled: writesDisabled,
                              onSelect: () => onDelete(session),
                            },
                          ]}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
          {hiddenCount > 0 && (
            <button type="button" className="load-more" onClick={onShowMore}>
              {t('chat.sessionList.showMore', { count: hiddenCount })}
            </button>
          )}
        </>
      )}
    </SidebarShell>
  );
}
