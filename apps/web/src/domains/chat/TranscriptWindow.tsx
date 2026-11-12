import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { Button, type MessageAction, MessageActions, useMessageCopy } from '../../components/ui';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import type { ErrorVisibility } from '../../state/error-visibility';
import type { RunGroup, StoredEvent } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { SESSION_NOT_FOUND_MESSAGE as NOT_FOUND_MESSAGE } from '../../stores/sessionStore';
import { AgentMessageCard } from './AgentMessageCard';
import { AskAnswerCard } from './AskAnswerCard';
import { ChatWelcome } from './ChatWelcome';
import { EnvCard } from './EnvCard';
import { NoticeRow } from './EventRow';
import { hasReasoningCard, ReasoningBlock } from './ReasoningBlock';
import { StreamCard } from './StreamCard';
import {
  AssistantText,
  QueuedNotice,
  type QueuedSubmission,
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
  type TranscriptItem,
} from './transcript-items';
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
 * - F5 / 重连会带 `since: 0` 回放整段 run（gateway 的订阅回放 + `EventStore#endBackfill`
 *   整批合并），那种**一次到货一大批**不是追加，播了就是整屏闪一下。
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
  visibleQueued,
  transcriptWindow,
  transcriptMessages,
  historyIndex,
  isHiddenMessage,
  noticeKindOf,
  messageIndexOffset,
  sessionFailure,
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
  onCancelQueued,
  onConfigureConnection,
  onGoChat,
  onEditMessage,
  onRetryMessage,
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
  /** 历史窗口之外还有更早的消息（滚到顶自动前插，不再有按钮 / 提示）。 */
  hasEarlier: boolean;
  visibleGroups: readonly RunGroup[];
  renderedGroups: readonly RunGroup[];
  visibleQueued: readonly QueuedSubmission[];
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
  onLoadEarlier: () => void;
  onCancelQueued: (runId: string) => void;
  onConfigureConnection: () => void;
  onGoChat: () => void;
  onEditMessage: (keepMessages: number, text: string) => void;
  onRetryMessage: (keepMessages: number, text: string) => void;
}) {
  // 打开 / 切换会话的 reset key：detail 到达（hydrate）会再触发一次稳定贴底；
  // 加载更早历史不改变这两个字段，因此不会跳底。
  const resetKey = selectedId ? `${selectedId}:${detailSessionId ?? ''}` : null;
  const followKey = `${snapshotVersion}:${renderedGroups.length}:${visibleQueued.length}`;
  const { scrollRef, getElement, pinned, onScroll, scrollToBottom, userIntentProps } =
    useStickyBottom({
      resetKey,
      followKey,
      sendTick,
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
    onLoadEarlier();
  }, [hasEarlier, getElement, onLoadEarlier]);

  // 布局阶段回填：前插内容在上方长高多少，就把 scrollTop 推高多少。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 分页长度是回填的显式触发器
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
  }, [transcriptWindow.shown.length, getElement, requestEarlier]);

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
        queued: visibleQueued,
        windowStartTs,
        historyIndex,
        isHidden: isHiddenMessage,
        noticeKindOf,
        // 子 agent 详情占位时（liveGroups 被清空）不补主会话的失败卡：那一屏讲的是另一个 run。
        ...(activeAgent ? {} : { sessionFailure }),
      }),
    [
      transcriptMessages,
      messageIndexOffset,
      activeAgent,
      renderedGroups,
      visibleQueued,
      windowStartTs,
      historyIndex,
      isHiddenMessage,
      noticeKindOf,
      sessionFailure,
    ],
  );

  // 入场门：只有挂载之后**新追加**的 item 播入场（判据见 useEnteringItems 的头注释）。
  // 历史消息（Transcript 里的 `message` item）不进门 —— 历史加载是回填，不是追加。
  const isEntering = useEnteringItems(items, resetKey);

  // 「助手」发言人名：挂在该 run **第一个**正文 / 思考项上（一个 run 只出现一次）。
  // 与历史态的 groupStart 是同一口径：连续同发言人不重复。签名换成「这一项带头」的
  // key 集合，渲染时 O(1) 判定，不用在 renderItem 里回头找前一项。
  const speakerKeys = useMemo(() => {
    const named = new Set<string>();
    const claimed = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'run-text' && item.kind !== 'run-reasoning') continue;
      if (claimed.has(item.runId)) continue;
      claimed.add(item.runId);
      named.add(item.key);
    }
    return named;
  }, [items]);

  // 工具栏挂点（**一个 run 只挂一处**，判据与历史侧同一个 `hasReasoningCard`）：
  // - 该 run 有思考卡 ⇒ 挂在那张卡右上角（卡自己渲染「复制思考」，见 ReasoningBlock）。
  //   正文这一侧**不挂**：以前 live 的 `run-text` / `run-reasoning` 是两个独立 item、
  //   互相看不见，工具栏只可能落在正文上，于是「有思考卡的一轮」让人看到正文右上角的
  //   工具条 —— 现在按 run 汇总，卡在屏幕上就由卡接管。
  // - 该 run 没有思考卡 ⇒ 挂在该 run **第一段正文**上（`.msg-actions`，行为不变）。
  //
  // 只看 item 流，不看 group 的原始字段：verbosity 把思考项过滤掉（minimal）时这里
  // 也自然认为「没有卡」，工具栏回到正文 —— 屏幕上没有卡就不该把工具条挂在看不见的地方。
  const bodyToolbarKeys = useMemo(() => {
    const withCard = new Set<string>();
    const firstText = new Map<string, string>();
    for (const item of items) {
      if (item.kind === 'run-reasoning') {
        if (hasReasoningCard(item.text)) withCard.add(item.runId);
        continue;
      }
      if (item.kind !== 'run-text' || item.text.trim().length === 0) continue;
      if (!firstText.has(item.runId)) firstText.set(item.runId, item.key);
    }
    const anchors = new Set<string>();
    for (const [runId, key] of firstText) {
      if (!withCard.has(runId)) anchors.add(key);
    }
    return anchors;
  }, [items]);

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
      if (item.kind === 'tool') return verbosity !== 'minimal' && item.runId === latest.runId;
      return false;
    });
  }, [activeAgent, items, renderedGroups, verbosity]);

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
      case 'ask-answer':
        // 「待批答复」：数据仍是那条 user 消息，呈现是一张卡（人是在待批页回答的）。
        return <AskAnswerCard card={item.card} ts={item.ts} defaultOpen={cardsDefaultOpen} />;
      case 'run-text': {
        // 正文只有一个形态：流式（`streaming`）与落盘都走 AssistantText → Markdown，
        // 外层 class / 内层块结构完全相同；run 结束时只是 streaming 翻成 false
        // （key 在 flush 前后不变，见 check-transcript-items 的 F2），DOM 原地复用。
        // 折叠与入场也收在 AssistantText 里（`entering` = 事件流追加的新 item；
        // 容器在 streaming 翻转前后不变，所以 `.msg-enter` 只播挂载那一次）。
        // `speaker`：这一项是该 run 的第一块内容 ⇒ 上方补「助手」发言人名
        // （run 运行期也要看得见，历史消息那条走 Transcript 的 groupStart）。
        //
        // `actions`：工具栏**只在这个 run 没有思考卡时**才落在正文上（判据见上面的
        // `bodyToolbarKeys`）。有思考卡的一轮由卡接管（`ReasoningBlock` 自己渲染
        // 「复制思考」+ 调用方给的这一段消息工具栏），正文右上角保持干净。
        // 不跟 `streaming` 开关显隐：窄屏（≤1023px）这一行是常备行，等到落定才出现
        // 会让正文在 run 结束那一帧长高一截；行在，高度就恒定。
        const textActions: MessageAction[] = bodyToolbarKeys.has(item.key)
          ? [
              {
                id: 'copy',
                label: t('chat.message.copy'),
                onSelect: () => copy(item.text),
              },
            ]
          : [];
        const textToolbar =
          textActions.length > 0 ? <MessageActions actions={textActions} /> : undefined;
        return (
          <AssistantText
            text={item.text}
            streaming={item.streaming}
            entering={isEntering(item.key)}
            speaker={speakerKeys.has(item.key)}
            actions={textToolbar}
          />
        );
      }
      case 'run-reasoning':
        // 思考卡：首次出现走 `.motion-appear`（只动透明度），展开 / 收起由
        // ReasoningBlock 内部的 `.motion-disclosure` 负责（见 styles/motion.css）。
        // 工具栏（含「复制思考」）由卡自己贴在右上角，这里不传 `actions`：live 的
        // 思考卡就是这一轮的唯一挂点（判据同 `bodyToolbarKeys`）。
        return (
          <ReasoningBlock
            text={item.text}
            streaming={item.streaming}
            startedAt={item.startedAt}
            endedAt={item.endedAt}
            entering={isEntering(item.key)}
            speaker={speakerKeys.has(item.key)}
          />
        );
      case 'tool':
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
              startedAt: item.startedAt,
            }}
            verbosity={verbosity}
            defaultOpen={cardsDefaultOpen}
            entering={isEntering(item.key)}
          />
        );
      case 'notice':
        return <NoticeRow event={item.event} defaultOpen={cardsDefaultOpen} />;
      case 'run-failure':
        // 失败卡：文案 / 数据在 RunFailureCard（与子 agent transcript 共用同一组件）。
        return <RunFailureCard failure={item} defaultOpen={cardsDefaultOpen} />;
      case 'runtime-notice': {
        const env = item.env;
        if (env !== undefined) {
          // 环境信息卡（vessel:notice）：与「来自 agent X」卡同一张卡、同一套展开机制。
          // 卡头 scope 标签 + 条数、summary 首行、展开看全部原文（见 EnvCard.tsx）。
          return <EnvCard env={env} ts={item.ts} defaultOpen={cardsDefaultOpen} />;
        }
        // 其它运行时提示（vessel:source / subscription …）：沿用整段文本的 notice 卡。
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
      case 'queued':
        return (
          <QueuedNotice
            item={{
              runId: item.runId,
              input: item.input,
              ...(item.queuePosition !== undefined ? { queuePosition: item.queuePosition } : {}),
              submittedAt: item.submittedAt,
              cancelling: item.cancelling,
              cancelled: item.cancelled,
            }}
            onCancel={onCancelQueued}
            defaultOpen={cardsDefaultOpen}
          />
        );
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
          ) : !hasTranscript &&
            visibleGroups.length === 0 &&
            visibleQueued.length === 0 &&
            !activeAgent ? (
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
              renderItem={renderItem}
              onEditMessage={onEditMessage}
              onRetryMessage={onRetryMessage}
            />
          ) : null}

          {/* run 在跑但还没有任何可见内容：一句「正在思考」（判据见上面的 showThinking）。
              它是会话滚动区的直接子项，排在整条 item 流之后（正在跑的 run 永远是最后一段）。 */}
          {showThinking && <ThinkingHint />}

          {activeAgent && (
            <SubagentTranscript
              agent={activeAgent}
              entries={entries}
              errorLevel={errorLevel}
              verbosity={verbosity}
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
  );
}
