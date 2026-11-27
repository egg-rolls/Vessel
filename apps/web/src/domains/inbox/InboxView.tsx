/**
 * agent 级收件箱视图（P1-B，q-inbox-agent-view；用户裁定「inbox 都是 agent 级别的
 * 消息，不应该有会话级别的显示」）。
 *
 * **口径**：读 `agents.inbox{ agent_id }`（**不带 `session_id`**）⇒ 服务端归属过滤
 * 短路（`service.ts#inboxSnapshot`：`sessionId === undefined || …`），返回该 agent
 * 全量 unread（held + unread，含无 `session_id` 的 wake/quiet 条目）。`unread` /
 * `pending` 计数本就是 agent 维度（过滤前），直接作头部统计。数据忠实还原服务端
 * 真相，**不做会话过滤** —— 会话级过滤是 PendingStrip（run-queue 提示）的事，
 * 不是收件箱的事（设计审计 `docs/dev/plans/inbox-agent-view-design.md` §0）。
 *
 * **防串台**：agent 级全量天然含所有会话的条目 ⇒ 每行标注归属（有 `session_id` ⇒
 * 短 id + 去会话链接；缺省 ⇒ 「无归属（wake/quiet）」），agent 选择器显式切换。
 *
 * **SWR（红线：事件触发重读，零 interval）**：
 * - live 触发器 `useAgentInboxRefreshTick`（agent 级匹配：主判据 `agent.inbox.changed`
 *   按 `data.agent_id`；补充词汇入队帧 / inbox 工具终态帧，§6.4），250ms 去抖后重读；
 * - 零 interval（§6.5 用户理想裁定）：兜底面 = resync 点 R1-R7 —— epoch 重读（R1）、
 *   回可见 `resyncOnVisible`（R2）、全局刷新信号（R3）、写后重读（R5）、切 agent（R6）、
 *   live 事件（R7）。事件丢失的静默缺口由 R2/R3 承接（已知代价，设计 §10 如实记录）。
 * - **数据永远来自那次 RPC**，事件只当触发器（条带三条硬口径逐字继承）。
 *
 * **写操作**复用现有 RPC、与条带同一套来源分档：human 源「取消」（recall 真删）/
 * 「我已处理」（claim，不可逆）；非 human 源 held「留档」（recall → unhold）。
 * 与条带的差别：写成功后**立即重读对齐**（不做乐观本地减法）—— 本页没有条带那套
 * 「读数缓存 + 客户端 pending 对账」的包袱，一次 RPC 往返就是真相，数据永远
 * 来自读。不给「收回编辑」：本页没有草稿槽（设计审计 §1）。
 *
 * **消费后消失是真相不是缺陷**：inbox read 消费后条目不再回（`inbox.ts` consumed
 * 永不回）；「已消费消息的可见承接」归 P1-A，不在本单扩面。
 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import type { Route } from '../../app/router';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, CountBadge, Select, useEnteringItemKeys } from '../../components/ui';
import { useConnection, useEventSnapshot } from '../../gateway/ConnectionProvider';
import type {
  AgentClaimResponse,
  AgentInboxEntry,
  AgentInboxResponse,
  AgentRecallResponse,
  AgentSummary,
} from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { errorMessage } from '../chat/errors';
import { MAIN_AGENT_ID } from '../chat/main-session';
import { orderPendingEntries, pendingIdentityOf, shortSenderId } from '../chat/pending-strip';
import { useAgentInboxRefreshTick } from './agent-inbox-refresh';
import { InboxRow } from './InboxRow';

// #/inbox 独立路由已删（用户裁定：收件箱统一进会话页面板，深链回落 chat）。
// 本组件暂留待数据源改造步复用或废弃；route 形状本地保留，不再来自全局 Route 联合。
type InboxRoute = { domain: 'inbox'; agentId?: string };

/** live 触发 → 重读的去抖（条带同款）：事件 burst 只换一次读。 */
const REFRESH_DEBOUNCE_MS = 250;

/** roster 条目的 canonical id（`id` 优先，`agent_id` 兜底 —— 与 main-session 同款）。 */
function agentIdOf(summary: AgentSummary): string {
  return summary.id ?? summary.agent_id ?? '';
}

/** 卡头身份：与条带同一份纯函数 + 同一组 i18n 字面（不新造同义词）。 */
function identityOf(entry: { from: string; from_name?: string }): string | undefined {
  return pendingIdentityOf(entry, {
    humanLabel: t('chat.pending.identity.human'),
    askLabel: t('chat.pending.identity.ask'),
    bashLabel: t('chat.pending.identity.bash'),
    systemLabel: t('chat.pending.identity.system'),
    agentLabel: (name) => t('chat.pending.identity.agent', { name }),
  });
}

export function InboxView({
  route,
  navigate,
}: {
  route: InboxRoute;
  navigate: (route: Route) => void;
}) {
  const { client, hasToken, epoch } = useConnection();
  const snapshot = useEventSnapshot();
  const toast = useToast();
  const agentId = route.agentId ?? MAIN_AGENT_ID;

  // ── roster：agent 选择器 + 工具帧归属用的 body sessions ──
  // 零 interval（§6.5）：roster 增删靠 epoch 重读 + 回可见 resync + 全局刷新承接。
  const roster = useResource<readonly AgentSummary[]>({
    load: () => client.listAgents(),
    enabled: hasToken,
    deps: [epoch],
    resyncOnVisible: true,
  });
  const agents = resourceData(roster.state) ?? [];
  const selected = agents.find((entry) => agentIdOf(entry) === agentId);
  const agentSessions = useMemo(() => {
    const sessions = new Set<string>();
    if (selected?.session_id) sessions.add(selected.session_id);
    for (const body of selected?.bodies ?? []) {
      const id = body.session_id ?? body.body_id;
      if (id) sessions.add(id);
    }
    return sessions;
  }, [selected]);

  // ── inbox 真相：agent 级全量（不带 session_id）──
  // 零 interval（§6.5 用户理想裁定）：live 触发（R7）+ epoch/agent 切换（R1/R6）+
  // 回可见 resync（R2）+ 全局刷新（R3）+ 写后重读（R5）承接全部兜底，不留定时器。
  const inbox = useResource<AgentInboxResponse>({
    load: () => client.inbox({ agent_id: agentId, include_held: true }),
    enabled: hasToken,
    deps: [agentId, epoch],
    resyncOnVisible: true,
  });
  const data = resourceData(inbox.state);
  // 排序复用条带纯函数（held 在前、ts 升序）；sort 只重排不改元素，
  // 断言回 AgentInboxEntry 以保留 session_id 等 additive 字段。
  const entries = useMemo(
    () => orderPendingEntries(data?.entries ?? []) as AgentInboxEntry[],
    [data],
  );
  // 入场判定（motion.css 契约 ①，条带同款语义）：首屏整批 = 历史不播，live 追加
  // 的新 message_id 才挂 `.motion-appear`；换 agent / 重连（epoch）重认首屏。
  const isEntering = useEnteringItemKeys(
    entries,
    (entry) => entry.message_id,
    `${agentId}:${epoch}`,
  );

  // ── SWR：live 触发（agent 级）→ 去抖重读；数据永远来自 RPC ──
  const tick = useAgentInboxRefreshTick(snapshot.entries, agentId, agentSessions);
  useEffect(() => {
    if (tick === 0) return;
    const timer = window.setTimeout(() => inbox.reload(), REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [tick, inbox.reload]);

  const manualRefresh = useCallback(() => {
    inbox.reload();
    roster.reload();
  }, [inbox.reload, roster.reload]);
  useRefreshSignal(manualRefresh);

  // ── 展开 peek 全文（只读 message_ids；正文不可变，按 id 缓存）──
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [textById, setTextById] = useState<ReadonlyMap<string, string>>(new Map());
  const [peekingIds, setPeekingIds] = useState<ReadonlySet<string>>(new Set());
  const [peekErrorById, setPeekErrorById] = useState<ReadonlyMap<string, string>>(new Map());
  // 换 agent：展示态全部重置（缓存不跨 agent 复用）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentId 是触发器不是被读值 —— 换 agent 必须重跑重置（setter 恒稳，body 不读 agentId）
  useEffect(() => {
    setExpandedIds(new Set());
    setTextById(new Map());
    setPeekingIds(new Set());
    setPeekErrorById(new Map());
  }, [agentId]);

  const toggleExpand = useCallback(
    (messageId: string) => {
      const opening = !expandedIds.has(messageId);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(messageId)) next.delete(messageId);
        else next.add(messageId);
        return next;
      });
      if (!opening || textById.has(messageId) || peekingIds.has(messageId)) return;
      setPeekingIds((prev) => new Set(prev).add(messageId));
      void (async () => {
        try {
          const body = await client.inbox({ agent_id: agentId, message_ids: [messageId] });
          const found = (body?.entries ?? []).find((entry) => entry.message_id === messageId);
          const text = found?.text;
          if (typeof text === 'string') {
            setTextById((prev) => new Map(prev).set(messageId, text));
            setPeekErrorById((prev) => {
              const next = new Map(prev);
              next.delete(messageId);
              return next;
            });
          } else {
            setPeekErrorById((prev) =>
              new Map(prev).set(
                messageId,
                t('inbox.peekFailed', { detail: t('inbox.peekMissing') }),
              ),
            );
          }
        } catch (error) {
          setPeekErrorById((prev) =>
            new Map(prev).set(messageId, t('inbox.peekFailed', { detail: errorMessage(error) })),
          );
        } finally {
          setPeekingIds((prev) => {
            const next = new Set(prev);
            next.delete(messageId);
            return next;
          });
        }
      })();
    },
    [expandedIds, textById, peekingIds, client, agentId],
  );

  // ── 写操作：来源分档与条带 / 服务端同一判据；成功 / 失败都立即重读对齐 ──
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const markBusy = useCallback((messageId: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);

  /** human 源「取消」：recall 真删。 */
  const handleCancel = useCallback(
    async (messageId: string) => {
      markBusy(messageId, true);
      try {
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (deleted.includes(messageId)) toast.success(t('inbox.cancelled'));
        else toast.error(t('inbox.cancelRejected'));
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        markBusy(messageId, false);
        inbox.reload();
      }
    },
    [client, agentId, markBusy, inbox.reload, toast],
  );

  /** human 源「我已处理」：claim，不可逆（consumed 后不再投递、不再出现）。 */
  const handleClaim = useCallback(
    async (messageId: string) => {
      markBusy(messageId, true);
      try {
        const result = await client.rpc<AgentClaimResponse>('agents.claim', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const claimed = Array.isArray(result?.claimed) ? result.claimed : [];
        if (claimed.includes(messageId)) {
          toast.success(t('inbox.claimTaken'));
        } else {
          const skip = (result?.skipped ?? []).find((entry) => entry.message_id === messageId);
          const reason =
            skip?.reason === 'consumed'
              ? t('chat.pending.claimSkipped.consumed')
              : t('chat.pending.claimSkipped.notFound');
          toast.error(t('inbox.claimSkipped', { reason }));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        markBusy(messageId, false);
        inbox.reload();
      }
    },
    [client, agentId, markBusy, inbox.reload, toast],
  );

  /** 非 human 源 held「留档」：recall → unhold（条目退回 unread，模型仍能 read）。 */
  const handleUnhold = useCallback(
    async (messageId: string) => {
      markBusy(messageId, true);
      try {
        const result = await client.rpc<AgentRecallResponse>('agents.recall', {
          agent_id: agentId,
          message_ids: [messageId],
        });
        const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
        if (deleted.includes(messageId)) toast.success(t('inbox.unheld'));
        else toast.error(t('inbox.unholdRejected'));
      } catch (error) {
        toast.error(t('inbox.unholdFailed', { detail: errorMessage(error) }));
      } finally {
        markBusy(messageId, false);
        inbox.reload();
      }
    },
    [client, agentId, markBusy, inbox.reload, toast],
  );

  const openSession = useCallback(
    (sessionId: string) => navigate({ domain: 'chat', sessionId }),
    [navigate],
  );

  // ── 选择器选项：roster 全量；深链的 agent 不在 roster 时也保留（RPC 会如实报错）──
  const options = useMemo(() => {
    const list = agents
      .map((entry) => ({ id: agentIdOf(entry), name: entry.name?.trim() || agentIdOf(entry) }))
      .filter((option) => option.id !== '');
    if (!list.some((option) => option.id === agentId)) {
      list.unshift({ id: agentId, name: agentId });
    }
    return list;
  }, [agents, agentId]);

  if (!hasToken) {
    return (
      <NotEnabledState
        variant="page"
        title={t('common.notConnected')}
        reason={t('inbox.noTokenReason')}
      />
    );
  }

  const error = inbox.state.status === 'error' ? inbox.state.error : undefined;
  const errorCode = inbox.state.status === 'error' ? inbox.state.code : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('nav.domain.inbox')} subtitle={t('inbox.subtitle')}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-sm text-muted">{t('inbox.agentLabel')}</span>
          <Select
            value={agentId}
            aria-label={t('inbox.agentLabel')}
            onChange={() => navigate({ domain: 'chat' })}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name === option.id
                  ? option.id
                  : `${option.name} (${shortSenderId(option.id)})`}
              </option>
            ))}
          </Select>
          {data && (
            <>
              <CountBadge
                count={data.unread}
                label={t('inbox.unreadCount', { count: data.unread })}
              />
              <CountBadge
                count={data.pending}
                tone="accent"
                label={t('inbox.pendingCount', { count: data.pending })}
              />
              <span className="text-xs text-faint">
                {t('inbox.entryCount', { count: entries.length })}
              </span>
            </>
          )}
          <span className="flex-1" />
          <Button onClick={manualRefresh} disabled={inbox.state.status === 'loading'}>
            {t('common.refresh')}
          </Button>
        </div>

        {inbox.state.status === 'loading' && !data && <LoadingState />}
        {error && !data && errorCode === 'not_found' && (
          <EmptyState
            title={t('inbox.notFound')}
            description={error}
            action={<Button onClick={manualRefresh}>{t('common.retry')}</Button>}
          />
        )}
        {error && !data && errorCode !== 'not_found' && (
          <ErrorState message={error} onRetry={manualRefresh} />
        )}
        {data && (
          <>
            {error && <StaleNotice message={error} onRetry={manualRefresh} />}
            {entries.length === 0 ? (
              <EmptyState title={t('inbox.empty')} description={t('inbox.emptyHint')} />
            ) : (
              <div className="flex flex-col gap-2.5">
                {entries.map((entry) => (
                  <InboxRow
                    key={entry.message_id}
                    entry={entry}
                    client={client}
                    identity={identityOf(entry)}
                    busy={busyIds.has(entry.message_id)}
                    expanded={expandedIds.has(entry.message_id)}
                    entering={isEntering(entry.message_id)}
                    text={textById.get(entry.message_id)}
                    peeking={peekingIds.has(entry.message_id)}
                    peekError={peekErrorById.get(entry.message_id)}
                    onToggleExpand={toggleExpand}
                    onCancel={handleCancel}
                    onClaim={handleClaim}
                    onUnhold={handleUnhold}
                    onOpenSession={openSession}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </PageScaffold>
    </div>
  );
}
