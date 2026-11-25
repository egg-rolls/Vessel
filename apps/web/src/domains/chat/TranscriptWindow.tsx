import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { Button, MessageActions, useMessageCopy } from '../../components/ui';
import { formatClock } from '../../format';
import type { Message, ProjectionSummary } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import type { ErrorVisibility } from '../../state/error-visibility';
import type { RunGroup, StoredEvent } from '../../state/events';
import { useRuntimeVisibility } from '../../state/runtime-visibility';
import type { Verbosity } from '../../state/visibility';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { AgentMessageCard } from './AgentMessageCard';
import { AskAnswerCard } from './AskAnswerCard';
import type { AnsweredAsk } from './ask-answered';
import { ChatWelcome } from './ChatWelcome';
import { ConversationIndex } from './ConversationIndex';
import { reasoningVisible, toolVisible } from './chat-visibility';
import { indexEntriesOfItems } from './conversation-index';
import { EnvCard } from './EnvCard';
import { NoticeRow } from './EventRow';
import { isStripCoveredInboxNotice } from './env-notice';
import { InboxReadCard } from './InboxReadCard';
import { PendingBubble } from './PendingBubble';
import { inConversationStream } from './pending-placement';
import type { PendingSend } from './pending-sends';
import { hasReasoningCard, ReasoningBlock } from './ReasoningBlock';
import { RotateHandoffCard } from './RotateHandoffCard';
import { StreamCard } from './StreamCard';
import {
  AssistantText,
  PromptContextCard,
  RunFailureCard,
  ThinkingHint,
  UserBubble,
} from './StreamItems';
import { SubagentTranscript } from './SubagentTranscript';
import { ToolCard } from './ToolCard';
import { Transcript } from './Transcript';
import {
  buildTranscriptItems,
  type HistoryIndex,
  type RunFailure,
  type SessionPromptContext,
  type TranscriptItem,
} from './transcript-items';
import { useConversationIndex } from './useConversationIndex';
import { useStickyBottom } from './useStickyBottom';

/** 距顶多少像素内触发前插一页。 */
const EARLIER_TRIGGER_PX = 200;
/** 一页填不满视口时的连续补页上限（避免短会话无限请求）。 */
const AUTO_PAGE_BUDGET = 20;

/**
 * 首屏到货多少条以内算「真的追加」（见 `useEnteringItems`）。
 * 1–2 条覆盖「发送 → 用户气泡（+ 首段正文）」；再多就是回填 / 回放。
 */
const FIRST_SCREEN_APPEND_MAX = 2;

interface EnteringGate {
  /** 上次 reset 用的身份（换会话 / detail 到达）：变了就重新认「首屏」。 */
  reset: string | null;
  /** 已经判定过的 key。跨 reset 保留：旧 key 再出现（换会话回来、verbosity 切换）不重播。 */
  seen: Set<string>;
  /** 还没见过本 reset 后的第一屏有内容的列表。 */
  first: boolean;
  /** 判为「追加」的 key（判定一次就固化，类名不中途摘掉）。 */
  entering: Set<string>;
}

/**
 * 入场门（会话页）：只有**本次挂载之后新追加**的 item 才播入场动画。
 *
 * 为什么不直接用 `components/ui/useEnteringItemKeys`（Team 页那套）：它把「第一屏整批」
 * 一律当历史。会话页有两处对不上：
 * - 会话页常常是从空开始的 —— 新会话的第一条消息（用户气泡）本身就是**追加**，
 *   按「首屏」处理会把「发送即有入场」吞掉；
 * - F5 / 刷新会一次到货一整段（`EventStore#applyTimelineRange` 按**一个区间**整批并入，
 *   实时流是之后才接上的），那种**一次到货一大批**不是追加，播了就是整屏闪一下。
 *
 * 判据（只对本次 reset 后的第一屏生效一次）：一屏一次到货「够多」（≥3 条）⇒ 回填 / 回放，
 * 不播；从空到 1–2 条 ⇒ 真的追加，播（新会话的第一条消息 + 首段正文就落在这个区间）。
 * 之后出现的 key 一律算追加。
 *
 * 记账写在渲染期（Set 只增不改、幂等）：被 React 丢弃的渲染不会跑 effect，而写在 effect
 * 里会让那批 key 在下一帧仍算「新追加」。判定一旦为 true 就留在节点上 —— 半路摘类名会把
 * 播到一半的动画掐断；React 按稳定 key 复用节点，所以留下也不会重播。
 */
function useEnteringItems(
  items: readonly TranscriptItem[],
  reset: string | null,
): (key: string) => boolean {
  const store = useRef<EnteringGate | null>(null);

  let gate = store.current;
  if (gate === null) {
    gate = { reset, seen: new Set(), first: true, entering: new Set() };
    store.current = gate;
  } else if (gate.reset !== reset) {
    // 身份变了只重新认「首屏」：`seen` 跨 reset 保留，已经播过的 key 再出现不再播。
    gate.reset = reset;
    gate.first = true;
  }

  if (items.length > 0) {
    if (gate.first) {
      gate.first = false;
      // 首屏到货的条数够少：那是「真的追加」（新会话的第一条消息 / 首段正文），要播。
      // 一次落一大批才是回填 / 回放（F5、重连、切会话）。
      if (items.length <= FIRST_SCREEN_APPEND_MAX) {
        for (const item of items) {
          if (gate.seen.has(item.key)) continue;
          gate.entering.add(item.key);
        }
      }
      for (const item of items) gate.seen.add(item.key);
    } else {
      for (const item of items) {
        if (gate.seen.has(item.key)) continue;
        gate.seen.add(item.key);
        gate.entering.add(item.key);
      }
    }
  }

  const entering = gate.entering;
  return (key: string) => entering.has(key);
}

/**
 * 会话滚动区：空态 / 错误态 / 历史消息 / 实时 run 与排队 notice / 子 agent。
 *
 * 吸附滚动见 `useStickyBottom`：打开/切会话等布局稳定后贴底；pinned 时跟随
 * 新内容（~100ms 节流、无 smooth）；用户上滚脱离；加载更早历史不触发贴底。
 * 发送受理（`sendTick`）是唯一会强制贴底的非内容事件：立即到位并恢复跟随。
 *
 * 历史分页是**无感**的：没有「加载更早」按钮，也没有「仅显示最近 N 条」提示；
 * 滚到顶部阈值内自动前插一页，并用 `scrollHeight` 差值回填 `scrollTop` 保住视觉锚点。
 *
 * 「更早」有**两条轴**，滚到顶时各推一步（`onLoadEarlier`）：历史消息分页（会话记录）与
 * 事件时间线段（首屏只加载尾部窗口，见 `EventStore#hasEarlier`）。两条共用这一个滚动
 * 触发器与同一个锚点回填 —— **不新增任何控件 / 提示条**（用户口径：前端要清爽）。
 */
export function TranscriptWindow({
  hasToken,
  selectedId,
  activeAgent,
  draftActive,
  restorePending,
  hydrateError,
  hydrating,
  hydrateStale,
  hasTranscript,
  hasEarlier,
  visibleGroups,
  renderedGroups,
  transcriptWindow,
  transcriptMessages,
  historyIndex,
  isHiddenMessage,
  noticeKindOf,
  messageIndexOffset,
  sessionFailure,
  sessionSystemContext,
  projectionSummary,
  answeredAsks,
  detailNotice,
  onDismissDetailNotice,
  earlierError,
  onDismissEarlierError,
  onRetryEarlier,
  verbosity,
  cardsDefaultOpen,
  errorLevel,
  entries,
  snapshotVersion,
  detailSessionId,
  sendTick,
  onRetryDetail,
  onLoadEarlier,
  onConfigureConnection,
  onGoChat,
  onEditMessage,
  onRetryMessage,
  pendingSends,
  onRetryPending,
  onDismissPending,
}: {
  hasToken: boolean;
  selectedId: string | null;
  activeAgent: AgentNode | undefined;
  draftActive: boolean;
  restorePending: boolean;
  hydrateError: string | null;
  hydrating: boolean;
  hydrateStale: string | null;
  hasTranscript: boolean;
  /**
   * 更早还有内容（滚到顶自动前插，不再有按钮 / 提示）。
   *
   * 两条轴任一为真即为真：历史消息窗口（本地窗口外还有消息 / 服务端还有上一页）**或**
   * 事件时间线还没补到 seq 1（首屏只加载尾部窗口，见 `EventStore#hasEarlier`）。
   */
  hasEarlier: boolean;
  visibleGroups: readonly RunGroup[];
  renderedGroups: readonly RunGroup[];
  transcriptWindow: { shown: Message[]; hiddenCount: number };
  transcriptMessages: readonly Message[];
  /** 历史侧 item / 反查表（调用侧按 messages 引用 memo，见 useChatTranscript）。 */
  historyIndex: HistoryIndex;
  /** runtime 上下文可见性判定（隐藏的消息不产 item，但仍参与下标与认领）。 */
  isHiddenMessage: (message: Message) => boolean;
  /** 运行时提示卡的分类（vessel:* 种类；undefined = 普通消息）。 */
  noticeKindOf: (message: Message) => string | undefined;
  /** `transcriptMessages[0]` 在完整 `state.messages` 里的绝对下标（撤回 / 重试用）。 */
  messageIndexOffset: number;
  /**
   * 会话记录里的最近一次失败（`sessions.get` 的 run 快照）。
   *
   * 历史消息不带失败信息，事件缓冲又有界 —— 刷新 / 切会话后只能靠它把「这一轮失败了」
   * 留在时间线上；与事件流里的失败卡按 runId 去重（见 transcript-items.ts）。
   */
  sessionFailure?: RunFailure;
  /**
   * 整会话投影汇总（additive 0.54 `sessions.get.session.projection_summary`）。
   *
   * 只喂给**展开后的投影卡**（累计数不进卡片头，spec §3.0）；缺省 = 这个会话没有被投影的条目。
   */
  projectionSummary?: ProjectionSummary;
  /**
   * 会话记录里的「模型这一轮看到了什么系统消息」（`sessions.get.system_context`）。
   *
   * 只在事件流里**没有同 hash 的卡**时才补（刷新 / 进程重启后事件回放窗口里没它了）。
   * 与 `sessionFailure` 同一取舍：粒度是最近一条，更早轮次不回补。
   */
  sessionSystemContext?: SessionPromptContext;
  /**
   * 本会话的服务端已答记录（`useAnsweredAsks` 读回、`answeredAsks` 映射，按回答时间升序）。
   *
   * 它们是**时间线内部的普通一员**（item kind `ask-answered`），位置由 `answered_at`
   * 与消息 item 一起排序决定；不是滚动区末尾的额外一段（0.51 用户裁决）。
   */
  answeredAsks?: readonly AnsweredAsk[];
  /**
   * 0.56 乐观渲染：本地待确认的用户气泡（点击那一帧就在屏上，回显到达即撤）。
   *
   * 它**不是** `TranscriptItem` 的一员：不进 item 流、不进消息身份认领集合、不参与
   * 历史 / 实时身份判定（见 `pending-sends.ts` 的三条硬约束）。所以这里是「整条 item
   * 流之后追加的一段」，与「正在思考」同一层。
   */
  pendingSends: readonly PendingSend[];
  onRetryPending: (pending: PendingSend) => void;
  onDismissPending: (pending: PendingSend) => void;
  /** 历史前缀被改写的一次性提示（i18n key）；null = 无。 */
  detailNotice: string | null;
  onDismissDetailNotice: () => void;
  /** 「加载更早」失败的原始细节；就地可关闭 notice + 重试，不用 toast。 */
  earlierError: string | null;
  onDismissEarlierError: () => void;
  onRetryEarlier: () => void;
  verbosity: Verbosity;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  cardsDefaultOpen: boolean;
  errorLevel: ErrorVisibility;
  entries: readonly StoredEvent[];
  snapshotVersion: number;
  detailSessionId: string | undefined;
  /** 发送受理序号（每次受理自增）：变化即贴底，见 `useStickyBottom` 的 `sendTick`。 */
  sendTick: number;
  onRetryDetail: () => void;
  /**
   * 加载更早的一屏（历史消息分页 + 事件时间线段各推一步，见 `useChatTranscript`）。
   *
   * 返回 Promise 时，滚动区会在它落地后检查「有没有长高」并据此收口锚点 —— 时间线那一段
   * 前插的是 item，不改变历史消息窗口长度，锚点回填靠的就是这个信号。
   */
  onLoadEarlier: () => void | Promise<void>;
  onConfigureConnection: () => void;
  onGoChat: () => void;
  onEditMessage: (keepMessages: number, text: string) => void;
  onRetryMessage: (keepMessages: number, text: string) => void;
}) {
  // q-msg-visibility：消息显示 toggle 读同一份 configStore 快照（与 useChatTranscript
  // 的 visibility 同源）；不经 ChatView props 链，避免与滚动容器改动相互踩踏。
  const { messageVisibility } = useRuntimeVisibility();
  const showReasoning = reasoningVisible(verbosity, messageVisibility.reasoning);

  // 可见窗口首条消息的 ts：比它更早的 live item 由 buildTranscriptItems 夹到末尾
  // （turn 锚点 / 窗口夹取 / 伪 run 拆条都在那里，由 check-transcript-items 守）。
  const windowStartTs = transcriptWindow.shown[0]?.timestamp;

  // 单一 item 流：历史消息、live 事件、排队提交先合成 item，再按 kind 选组件渲染。
  // 身份 / 去重 / 排序都在 transcript-items.ts（纯函数 + 门禁），这里只做渲染映射。
  const items = useMemo(
    () =>
      buildTranscriptItems({
        messages: transcriptMessages,
        messageIndexOffset,
        liveGroups: activeAgent ? [] : renderedGroups,
        windowStartTs,
        historyIndex,
        isHidden: isHiddenMessage,
        noticeKindOf,
        // 子 agent 详情占位时（liveGroups 被清空）不补主会话的失败卡 / 系统消息卡 / 已答提问：
        // 那一屏讲的是另一个 run。几路补的都按自己的身份去重（见 transcript-items.ts）。
        ...(activeAgent ? {} : { sessionFailure, sessionSystemContext, answeredAsks }),
      }),
    [
      transcriptMessages,
      messageIndexOffset,
      activeAgent,
      renderedGroups,
      windowStartTs,
      historyIndex,
      isHiddenMessage,
      noticeKindOf,
      sessionFailure,
      sessionSystemContext,
      answeredAsks,
    ],
  );

  // 打开 / 切换会话的 reset key：detail 到达（hydrate）会再触发一次稳定贴底；
  // 加载更早历史不改变这两个字段，因此不会跳底。
  const resetKey = selectedId ? `${selectedId}:${detailSessionId ?? ''}` : null;
  // 跟随触发器：流式版本 / 组数之外，还必须覆盖 **item 流自身的变化**（条数 + 末项身份）。
  // detail 刷新重建 item 流时没有新事件、组数也不变 —— 旧 followKey 对此是盲区：
  // 重建把内容高度瞬时改变后贴底跟随不触发，滑块停在被夹下去的位置（跳离底部回不来）。
  // 与 Team 页 teamFollowKey（末条消息身份）同一口径；未 pinned 时跟随不动，阅读不打断。
  const lastItemKey = items.length > 0 ? (items[items.length - 1]?.key ?? '') : '';
  const followKey = `${snapshotVersion}:${renderedGroups.length}:${items.length}:${lastItemKey}`;
  const { scrollRef, getElement, pinned, onScroll, scrollToBottom, userIntentProps } =
    useStickyBottom({
      resetKey,
      followKey,
      sendTick,
    });

  // 会话索引竖条（minimap）：item 流 → 索引条目，视口追踪 + 点击跳转见
  // useConversationIndex。子 agent 详情页讲的是另一个 run（锚点不在这一屏），不画。
  const indexEntries = useMemo(() => indexEntriesOfItems(items), [items]);
  const { activeKey: indexActiveKey, jumpTo: indexJumpTo } = useConversationIndex({
    getElement,
    entryKeys: indexEntries.map((entry) => entry.key),
    resetKey,
  });

  // 前插锚点：请求前记录 (scrollHeight, scrollTop)，布局落地后按高度差回填 scrollTop。
  // 这样历史消息只会在视口上方长出来，用户看到的行不移动；stickyBottom 的 pinned
  // 不受影响（程序化回填不改变 followKey / resetKey，且内容高度变化不算用户上滚）。
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  /** 锚点兜底计时器：没有产生新分页时不要让锚点卡住后续请求。 */
  const anchorTimerRef = useRef<number | undefined>(undefined);
  /** 连续自动补页的次数，防止「一页填不满视口」时无限请求。 */
  const autoPagesRef = useRef(0);

  const requestEarlier = useCallback(() => {
    if (!hasEarlier || anchorRef.current !== null) return;
    const element = getElement();
    if (!element) return;
    const anchor = { height: element.scrollHeight, top: element.scrollTop };
    anchorRef.current = anchor;
    window.clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = window.setTimeout(() => {
      // 没有新消息落地（请求失败 / detail 恰好没变化）时释放锚点，避免永久卡住。
      // 3000ms 覆盖「加载更早」的服务端往返；本地扩窗仍在下一帧立即回填。
      if (anchorRef.current === anchor) anchorRef.current = null;
    }, 3000);
    const settled = onLoadEarlier();
    if (!(settled instanceof Promise)) return;
    // 事件时间线那一段前插的是 **item**（历史消息窗口长度不变），所以上面的布局回填
    // effect 不一定被触发。落地后两帧内按同一套口径收口：长高多少就推多少 scrollTop；
    // 一点都没长（这一段没有可见内容）就把锚点放掉 —— 否则下一次滚到顶会被扣住 3 秒。
    // 成功与失败都要收口：请求失败时锚点不能留着（那会让滚动加载卡 3 秒）。
    const settle = (): void => {
      window.setTimeout(() => {
        window.requestAnimationFrame(() => {
          if (anchorRef.current !== anchor) return; // 布局 effect 已经收口
          anchorRef.current = null;
          window.clearTimeout(anchorTimerRef.current);
          const live = getElement();
          if (!live) return;
          const grown = live.scrollHeight - anchor.height;
          if (grown <= 0) return;
          live.scrollTop = anchor.top + grown;
          autoPagesRef.current += 1;
        });
      }, 0);
    };
    void settled.then(settle, settle);
  }, [hasEarlier, getElement, onLoadEarlier]);

  // 前插触发器：历史消息页长度变化，或 item 流的**首项**变了。
  // 后者是事件时间线那一段的特征（更早的段前插 ⇒ 首项换人；追加不会改变首项），
  // 没有它，「滚动加载的更早内容」长在视口上方时保不住视觉锚点。
  const firstItemKey = items[0]?.key ?? '';

  // 布局阶段回填：前插内容在上方长高多少，就把 scrollTop 推高多少。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 分页长度 / 首项身份是回填的显式触发器
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    anchorRef.current = null;
    window.clearTimeout(anchorTimerRef.current);
    const element = getElement();
    if (!element) return;
    const grown = element.scrollHeight - anchor.height;
    element.scrollTop = anchor.top + Math.max(0, grown);
    autoPagesRef.current += 1;
    // 一页还没填满视口（没有滚动条）且还有更早的分页：继续补，直到出现滚动条或没有更多。
    if (
      autoPagesRef.current < AUTO_PAGE_BUDGET &&
      element.scrollHeight <= element.clientHeight + 1
    ) {
      requestEarlier();
    }
  }, [transcriptWindow.shown.length, firstItemKey, getElement, requestEarlier]);

  // 入场门：只有挂载之后**新追加**的 item 播入场（判据见 useEnteringItems 的头注释）。
  // 历史消息（Transcript 里的 `message` item）不进门 —— 历史加载是回填，不是追加。
  const isEntering = useEnteringItems(items, resetKey);

  // 「这个 run 有没有思考卡」：**按 run 汇总**判定，不看某条消息自己的渲染。
  // live 的思考是**独立 item**（`run-reasoning`），判据门槛与历史态同一个
  // `hasReasoningCard`（非空白文本才算一张卡），只是这边要先把 item 归到 run 上。
  // 用途只有一件：这一轮**有**思考卡 ⇒ 时间已经上移到卡头，正文下方的
  // `MessageActions` 不再重复渲染时间；没有卡的那一轮才把时间放回工具栏。
  const reasoningRuns = useMemo(() => {
    const runs = new Set<string>();
    // 思考被藏（minimal / toggle 关）时不算「有思考卡」：时间留在正文工具栏。
    if (!showReasoning) return runs;
    for (const item of items) {
      if (item.kind !== 'run-reasoning') continue;
      if (!hasReasoningCard(item.text)) continue;
      runs.add(item.runId);
    }
    return runs;
  }, [items, showReasoning]);

  // 「正在思考」：run 已经在跑、但这一轮**还没有任何可见内容**（正文 / 思考 / 工具卡）
  // 时的那一行状态。主会话页以前完全没有这句话 —— 只有子 agent transcript 里有，
  // 于是「发出去还没吐字」的那几秒页面上什么都没有，只能看输入框有没有「停止」。
  //
  // 判据只用既有状态（`group.status === 'running'` + item 流里有没有这个 run 的内容项），
  // 不设定时器、不猜时长：run 一进终态（completed / cancelled / failed），status 就不再是
  // running，这一行随下一次渲染消失（三种终态都不残留）。
  // minimal 档的工具卡是被藏起来的，不能算「已可见内容」，否则这句话会被藏起来的卡顶掉
  // （子 agent 侧同一个坑的说明见 `RunItems` 的 showThinking）。
  const showThinking = useMemo(() => {
    // 子 agent 详情页讲的是另一个 run，那一侧由 `SubagentTranscript` → `RunItems` 负责。
    if (activeAgent) return false;
    const running = renderedGroups.filter((group) => group.status === 'running');
    const latest = running[running.length - 1];
    if (latest === undefined) return false;
    return !items.some((item) => {
      if (item.kind === 'run-text' || item.kind === 'run-reasoning') {
        return item.runId === latest.runId;
      }
      if (item.kind === 'tool') {
        return verbosity !== 'minimal' && messageVisibility.tools && item.runId === latest.runId;
      }
      // 收件箱取走的承接卡是消息不是工具：不受工具开关 / minimal 档影响，永远算可见内容。
      if (item.kind === 'inbox-read') {
        return item.runId === latest.runId;
      }
      return false;
    });
  }, [activeAgent, items, renderedGroups, verbosity, messageVisibility.tools]);

  // 正文 / 思考 item 的复制入口（`chat.message.copy` 那套），与历史消息同一个 hook。
  const copy = useMessageCopy();

  const renderItem = (item: TranscriptItem): ReactNode => {
    switch (item.kind) {
      case 'run-input':
        // 身份在 item 建好时就定了（`sender` 来自 run.started.input_name / user.message.name）：
        // agent 投递直接用同一张 AgentMessageCard，不会先出一帧用户气泡。
        // `entering`：事件流里追加进来的新项才播入场（历史 / 回放不播）。
        return item.sender !== undefined ? (
          <AgentMessageCard
            sender={item.sender}
            {...(item.senderKind !== undefined ? { senderKind: item.senderKind } : {})}
            content={item.text}
            ts={item.ts}
            defaultOpen={cardsDefaultOpen}
            entering={isEntering(item.key)}
          />
        ) : (
          <UserBubble
            text={item.text}
            ts={item.ts}
            entering={isEntering(item.key)}
            refs={item.refs}
          />
        );
      case 'inbox-read':
        // P1-A 症状②承接：被 inbox read 消费的消息（不成为 run input、无回显）在这里
        // 可见。human 源 = 人自己说的话 → 用户气泡（与 run-input 同口径）；agent / system
        // 源 → 收件箱消息卡（read 结果只给 source 这一层身份，没有发送者名，不猜不造）。
        return item.source === 'human' ? (
          <UserBubble text={item.text} ts={item.ts} entering={isEntering(item.key)} />
        ) : (
          <InboxReadCard
            source={item.source}
            content={item.text}
            ts={item.ts}
            defaultOpen={cardsDefaultOpen}
            entering={isEntering(item.key)}
          />
        );
      case 'ask-answer':
        // 「待批答复」：数据仍是那条 user 消息，呈现是一张卡（人是在待批页回答的）。
        return <AskAnswerCard card={item.card} ts={item.ts} defaultOpen={cardsDefaultOpen} />;
      case 'ask-answered':
        // 「提问答复」：sync 提问答完之后的服务端记录（不是消息，没有绝对下标）。
        // 卡与 async 那条共用 AskAnswerCard，只覆写卡头 / 来源文案 —— 数据来源不同
        // （服务端 answered 记录 vs 那条 ask:answer 消息），所以别让人误以为是从待批页提交的。
        //
        // 默认展开交给 cardsDefaultOpen：它现在只是时间线上的普通一员，没有「最新那条」
        // 这个特殊位置（旧的底部区块里最新一条被强制展开，那是那个形态的产物）。
        return (
          <AskAnswerCard
            card={item.card}
            ts={item.ts}
            defaultOpen={cardsDefaultOpen}
            titleLabel={t('chat.askAnswered.title')}
            sourceLabel={t('chat.askAnswered.source')}
            ariaLabel={t('chat.askAnswered.aria')}
          />
        );
      case 'rotate-handoff':
        // 「rotate 交接」：新身体的第一条启动嘱托是发起 rotate 的 agent 写的交接书。
        // **默认展开**（不是 cardsDefaultOpen）：正文就是新身体这一轮唯一的工作指令，
        // 默认折起等于让人看不到新身体在干什么。
        return (
          <RotateHandoffCard
            handoff={item}
            content={item.text}
            ts={item.ts}
            defaultOpen
            entering={isEntering(item.key)}
          />
        );
      case 'run-text': {
        // 正文只有一个形态：流式（`streaming`）与落盘都走 AssistantText → Markdown，
        // 外层 class / 内层块结构完全相同；run 结束时只是 streaming 翻成 false
        // （key 在 flush 前后不变，见 check-transcript-items 的 F2），DOM 原地复用。
        // 折叠与入场也收在 AssistantText 里（`entering` = 事件流追加的新 item；
        // 容器在 streaming 翻转前后不变，所以 `.msg-enter` 只播挂载那一次）。
        //
        // `actions`：这一段的工具栏（复制正文），落在正文**下方一行、左对齐**
        // （`mt-1`）；显隐（hover / focus-within / 触屏常显）由
        // `MessageActions` 自己负责，这里不写。思考卡上不挂工具栏。
        //
        // 时间：这一轮**有**思考卡 ⇒ 时间只在卡头（见 `reasoningRuns`），正文下方
        // 不重复；没有思考卡的那一轮才把时间放回工具栏的 meta。
        const clock = reasoningRuns.has(item.runId) ? '' : formatClock(item.ts);
        return (
          <AssistantText
            text={item.text}
            streaming={item.streaming}
            entering={isEntering(item.key)}
            actions={
              item.text.trim().length > 0 ? (
                <MessageActions
                  className="mt-1"
                  actions={[
                    {
                      id: 'copy',
                      label: t('chat.message.copy'),
                      onSelect: () => copy(item.text),
                    },
                  ]}
                  meta={
                    clock === '' ? undefined : (
                      <time dateTime={new Date(item.ts ?? 0).toISOString()}>{clock}</time>
                    )
                  }
                />
              ) : undefined
            }
          />
        );
      }
      case 'run-reasoning':
        // q-msg-visibility：思考过程 toggle（与历史侧 Transcript 同一判定）。
        if (!showReasoning) return null;
        // 思考卡：首次出现走 `.motion-appear`（只动透明度），展开 / 收起由
        // ReasoningBlock 内部的 `.motion-disclosure` 负责（见 styles/motion.css）。
        // 卡上没有消息工具栏（用户要的），只有一个卡头自带的「复制思考」小按钮，
        // 由组件自己渲染 —— 这里不需要传任何 actions。
        // `time`：这一段自己的时刻（`startedAt`，也是排序依据，只读），渲染在卡头最右。
        return (
          <ReasoningBlock
            text={item.text}
            streaming={item.streaming}
            entering={isEntering(item.key)}
            {...(item.startedAt !== undefined ? { time: item.startedAt } : {})}
          />
        );
      case 'tool':
        // q-msg-visibility：工具卡片 toggle（失败卡永不静默，与 live 同一判定）。
        if (!toolVisible(item.status, verbosity, messageVisibility.tools)) return null;
        return (
          <ToolCard
            card={{
              kind: 'tool',
              key: item.key,
              ...(item.callId !== undefined ? { callId: item.callId } : {}),
              name: item.name,
              status: item.status,
              ...(item.args !== undefined ? { args: item.args } : {}),
              ...(item.output !== undefined ? { result: item.output } : {}),
              ...(item.error !== undefined ? { error: item.error } : {}),
              ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
              ...(item.truncated === true ? { truncated: true } : {}),
              ...(item.truncatedLimitBytes !== undefined
                ? { truncatedLimitBytes: item.truncatedLimitBytes }
                : {}),
              // 0.54 投影：item 上的那份已经按 `tool_call_id` 合并好（见 transcript-items.ts），
              // 这里只搬运，不再按下标找。
              ...(item.projection !== undefined ? { projection: item.projection } : {}),
              startedAt: item.startedAt,
            }}
            verbosity={verbosity}
            defaultOpen={cardsDefaultOpen}
            entering={isEntering(item.key)}
            {...(projectionSummary !== undefined ? { projectionSummary } : {})}
          />
        );
      case 'notice':
        return <NoticeRow event={item.event} defaultOpen={cardsDefaultOpen} />;
      case 'prompt-context':
        // 环境快照卡（环境信息 · 上下文）：模型这一轮真正看到的系统消息
        // （基底 system prompt + Self Card）。
        // 默认折叠（用户口径：默认可见但折叠），展开是两段原文；卡语言与 EnvCard 一致
        // （见 StreamItems.tsx 的 PromptContextCard 头注释）。
        return (
          <PromptContextCard
            context={item}
            defaultOpen={cardsDefaultOpen}
            entering={isEntering(item.key)}
          />
        );
      case 'run-failure':
        // 失败卡：文案 / 数据在 RunFailureCard（与子 agent transcript 共用同一组件）。
        return <RunFailureCard failure={item} defaultOpen={cardsDefaultOpen} />;
      case 'runtime-notice': {
        const env = item.env;
        if (env !== undefined) {
          // 0.55.1：`[inbox] N pending` 这类通知**只给模型看**——人类侧已有输入框上方的
          // 待处理条带（带收回/取消/删除），同一事实渲染两次就是多余。详见
          // `env-notice.ts#isStripCoveredInboxNotice` 的注释（含 unread 的行仍然要留）。
          if (isStripCoveredInboxNotice(env)) return null;
          // 环境信息卡（vessel:notice）：与「来自 agent X」卡同一张卡、同一套展开机制。
          // 卡头 scope 标签 + 条数、summary 首行、展开看全部原文（见 EnvCard.tsx）。
          return <EnvCard env={env} ts={item.ts} defaultOpen={cardsDefaultOpen} />;
        }
        // 其它运行时提示（vessel:subscription / limit …）：沿用整段文本的 notice 卡。
        // （vessel:source 已改走上面的 EnvCard：scope「来源」，见 env-notice.ts。）
        return (
          <StreamCard
            className="runtime-notice-card w-full min-w-0 max-w-full"
            tone="info"
            defaultOpen={cardsDefaultOpen}
            title={
              <span className="font-mono text-2xs tracking-wider text-accent">
                {t('chat.notice.runtime', { kind: item.noticeKind })}
              </span>
            }
            summary={item.text}
          >
            <p className="m-0 min-w-0 px-2.5 pb-2 break-words whitespace-pre-wrap wrap-anywhere text-sm text-muted">
              {item.text}
            </p>
          </StreamCard>
        );
      }
      default:
        return null;
    }
  };

  // 滚到顶部阈值内自动前插一页。用户手势产生的 scroll 才会触发，程序化回填不会
  // （回填把 scrollTop 推高，远离阈值）。
  const handleScroll = useCallback(() => {
    onScroll();
    const element = getElement();
    if (element && element.scrollTop <= EARLIER_TRIGGER_PX) requestEarlier();
  }, [onScroll, getElement, requestEarlier]);

  return (
    <div className="transcript-stage">
      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        {...userIntentProps}
      >
        {!hasToken ? (
          <EmptyState
            title={t('chat.empty.noConnectionTitle')}
            description={t('chat.empty.noConnectionDesc')}
            action={
              <Button type="button" variant="primary" onClick={onConfigureConnection}>
                {t('common.configureConnection')}
              </Button>
            }
          />
        ) : selectedId ? (
          <>
            {hydrateError ? (
              <ErrorState
                message={hydrateError === NOT_FOUND_MESSAGE ? t('chat.notFound') : hydrateError}
                onRetry={onRetryDetail}
                action={
                  hydrateError === NOT_FOUND_MESSAGE ? (
                    <Button type="button" onClick={onGoChat}>
                      {t('breadcrumb.chat')}
                    </Button>
                  ) : undefined
                }
              />
            ) : hydrating && !hasTranscript && items.length === 0 ? (
              // 只有「什么都没有」时才换成 LoadingState：重连 / 重订阅时实时内容还在，
              // 换屏本身就是一次闪烁。
              <LoadingState label={t('chat.loadingHistory')} />
            ) : !hasTranscript && visibleGroups.length === 0 && !activeAgent ? (
              <EmptyState
                title={t('chat.empty.noHistoryTitle')}
                description={t('chat.empty.noHistoryDesc')}
              />
            ) : null}

            {hydrateStale && (
              <StaleNotice
                message={t('chat.staleHistory', { detail: hydrateStale })}
                onRetry={onRetryDetail}
              />
            )}

            {detailNotice && (
              <StaleNotice message={t(detailNotice)} onDismiss={onDismissDetailNotice} />
            )}

            {/* 历史加载失败：就地可关闭 + 重试（历史加载是就地动作，弹 toast 会丢锚点）。
              文案框架本地化，原始细节放在 detail 里，不把英文错误直接当正文。 */}
            {earlierError && (
              <StaleNotice
                message={t('chat.earlierLoadFailed', { detail: earlierError })}
                onRetry={onRetryEarlier}
                onDismiss={onDismissEarlierError}
              />
            )}

            {/* 0.18：历史消息与实时 run 的展开项共享同一个列表，没有 run 边界；
              0.50：实时节点按 run 起始时间插进历史消息之间，不再整块追加在末尾。
              hydrate 期间先只给 LoadingState：重放会先灌进来一批准 live 组，
              详情到达后再被认领（transcript-items.ts）收掉，看起来就是「闪现 + 跳跃」。 */}
            {items.length > 0 ? (
              <Transcript
                items={items}
                allMessages={transcriptMessages}
                messageIndexOffset={messageIndexOffset}
                cardsDefaultOpen={cardsDefaultOpen}
                showReasoning={showReasoning}
                renderItem={renderItem}
                onEditMessage={onEditMessage}
                onRetryMessage={onRetryMessage}
              />
            ) : null}

            {/* 0.56 排队生命周期：**只有 `sending` 在会话流里**。
              判据来自 `pending-placement.ts#inConversationStream`（唯一出处，条带与驱动用
              同一份）：`queued` 只在待处理条带、`failed` 也只在条带（带「重试 / 编辑」）、
              `sent` 之后服务端回显接管成正常用户气泡。
              为什么 `queued` 必须在这里被跳过：它同时存在于服务端 inbox 与这条 pending 里，
              两边都画就是用户点名要删的「同一条消息在会话里又出现一次」。所以这不是「先显示
              再隐藏」，而是**状态一变成 queued 就不该由这一层渲染**。 */}
            {pendingSends.filter(inConversationStream).map((pending) => (
              <PendingBubble
                key={pending.id}
                pending={pending}
                onRetry={onRetryPending}
                onDismiss={onDismissPending}
              />
            ))}

            {/* run 在跑但还没有任何可见内容：一句「正在思考」（判据见上面的 showThinking）。
              它是会话滚动区的直接子项，排在整条 item 流之后（正在跑的 run 永远是最后一段）。 */}
            {showThinking && <ThinkingHint />}

            {activeAgent && (
              <SubagentTranscript
                agent={activeAgent}
                entries={entries}
                errorLevel={errorLevel}
                verbosity={verbosity}
                messageVisibility={messageVisibility}
              />
            )}
          </>
        ) : draftActive ? (
          <ChatWelcome />
        ) : restorePending ? (
          <LoadingState label={t('chat.restoringSession')} />
        ) : null}
        {!pinned && (
          <button type="button" className="to-bottom" onClick={scrollToBottom}>
            {t('chat.toBottom')}
          </button>
        )}
      </div>
      {!activeAgent && (
        <ConversationIndex
          entries={indexEntries}
          activeKey={indexActiveKey}
          onJump={indexJumpTo}
          className="conversation-index-rail"
        />
      )}
    </div>
  );
}
