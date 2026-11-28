import { memo, type ReactNode, useMemo } from 'react';
import { Markdown } from '../../components/Markdown';
import {
  type MessageAction,
  MessageActions,
  MessageFold,
  useMessageCopy,
} from '../../components/ui';
import { formatClock, localDayKey, localDayLabel } from '../../format';
import type { Message } from '../../gateway/types';
import { t } from '../../i18n';
import { runtimeMessageKind } from '../../state/runtime-visibility';
import { AgentMessageCard, agentMessageSender } from './AgentMessageCard';
import { BlockView, MessageBlocks } from './block-views';
import { isIndexUserMessage } from './conversation-index';
import { liftBlocks } from './lift-blocks';
import { hasReasoningCard, ReasoningBlock } from './ReasoningBlock';
import { isCardInputMessage, type TranscriptItem } from './transcript-items';

/**
 * 这条历史消息自己要显示的思考文本（thinking 模式的 reasoning_content）。
 *
 * 历史侧的思考**挂在消息 item 内部**渲染，不单独造 item：
 * - 不双出：被 live 认领的 assistant 消息照常保留（位置 / 操作按钮以历史为准），
 *   让位的是 live 侧同文段的 `run-reasoning` item（transcript-items.ts 的
 *   claimedReasoning）；能走到这里的消息一定没有同文的 live 思考项。
 * - 不另造 item 也就不碰排序/去重：思考跟着所属消息的时间戳走，位置固定在正文上方 ——
 *   与 live 里「思考 item 排在正文 item 之前」是同一个顺序语义。
 *
 * 没有正文、也没有 tool_calls 的消息同样走这里：只渲思考块（没有空正文节点、没有空气泡）。
 *
 * 「有没有思考卡」走 `hasReasoningCard`（唯一判据，与思考卡自己那个「复制思考」按钮
 * 同一份），所以「有思考卡」在渲染与按钮两处只有一个答案。
 */
function historyReasoning(message: Message): string | undefined {
  if (message.role !== 'assistant') return undefined;
  const text = message.reasoning_content;
  return hasReasoningCard(text) ? text : undefined;
}

/**
 * 该助手消息之前最近的一条**人打的字**（重试要用它的绝对下标）。
 *
 * 三类不算用户输入：运行时上下文（`vessel:*`）、A2A 投递（`agent:<alias>` → agent 卡）、
 * rotate 交接嘱托（`rotate:handoff[:<epoch>]` → 交接卡）。后两类是**卡片**：把它们的正文
 * 当 retry / edit 的锚点，等于让 agent 的话（或一段交接书）被人改写后再作为「真实发生过
 * 的用户输入」重发 —— 身份判定与建 item 共用 `transcript-items.ts` 的 `isCardInputMessage`。
 * 找不到就返回 undefined（不给重试）。
 */
function previousUserMessage(
  message: Message,
  allMessages: readonly Message[] | undefined,
  indexOffset: number,
  indexOf: ReadonlyMap<Message, number>,
): { text: string; index: number } | undefined {
  if (message.role !== 'assistant' || !allMessages) return undefined;
  const currentIndex = indexOf.get(message) ?? -1;
  if (currentIndex < 0) return undefined;
  for (let cursor = currentIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = allMessages[cursor];
    if (candidate?.role !== 'user') continue;
    if (runtimeMessageKind(candidate) !== undefined) continue;
    if (isCardInputMessage(candidate)) continue;
    return { text: candidate.content, index: cursor + indexOffset };
  }
  return undefined;
}

/**
 * 历史消息渲染（item 流里的 `message` 一类）。
 *
 * 工具消息不再走这里：它们在建 item 时就被配对成 `tool` item，
 * 与运行态共用同一张卡（见 transcript-items.ts）。
 *
 * **行级 memo**（st-F1）：props 全是稳定引用 / 原始值（message 是不可变快照、
 * previousUser 按消息缓存、回调 useCallback 稳定），流式期未变化的历史行整行
 * 跳过重渲染 —— 每帧只重渲染真正变化的那一行。
 */
const TranscriptMessage = memo(function TranscriptMessage({
  message,
  messageIndex,
  previousUser,
  source,
  cardsDefaultOpen,
  showReasoning = true,
  onCopy,
  onEdit,
  onRetry,
  onQuote,
  onJumpQuote,
  quoteTargets,
}: {
  message: Message;
  /** 该消息在  的  里的绝对下标；缺失时不提供撤回。 */
  messageIndex: number | undefined;
  /** 该助手消息前一条真实用户输入及其下标。 */
  previousUser?: { text: string; index: number };
  /** A2A 消息的回信地址（由被吸收的 vessel:source 行提供）。 */
  source?: string;
  cardsDefaultOpen: boolean;
  /** 思考过程可见（q-msg-visibility：minimal 档 / toggle 关闭时 false）。 */
  showReasoning?: boolean;
  onCopy: (text: string) => void;
  onEdit: (keepMessages: number, text: string) => void;
  onRetry: (keepMessages: number, text: string) => void;
  /** 引用这条消息（q-message-quote）；缺省不渲染「引用」动作。 */
  onQuote?: (message: Message) => void;
  /** 引用块点击跳转原消息；缺省引用块纯展示。 */
  onJumpQuote?: (messageId: string) => void;
  /** 无 id 信封的定位用历史窗口（allMessages 同一引用，memo 稳定）。 */
  quoteTargets?: readonly Message[];
}) {
  if (message.role === 'system') return null;
  if (message.role === 'tool') return null;

  // 时间只出现在 hover 工具栏里（与 live 一致）：气泡内不放。助手消息的例外见下
  // （有思考卡 ⇒ 时间上移到卡头，工具栏不再重复）。
  const clock = formatClock(message.timestamp);

  if (message.role === 'user') {
    const meta = clock !== '' ? clock : undefined;
    const hasMeta = meta !== undefined;
    // A2A 投递：runtime 给这条输入写了 ，渲染成 agent 卡而不是用户气泡。
    const agentSender = agentMessageSender(message);
    if (agentSender !== undefined) {
      return (
        <AgentMessageCard
          sender={agentSender.alias}
          senderKind={agentSender.kind}
          content={message.content}
          ts={message.timestamp}
          {...(source !== undefined ? { source } : {})}
          defaultOpen={cardsDefaultOpen}
        />
      );
    }
    // 块提升（块 P0）：一次 liftBlocks 收编 quote / session-ref / image / file 解析；
    // 不是信封时 blocks 为空、body = 原文（零回归）。顺序由注册表 order 决定。
    const { blocks, body } = liftBlocks(message, { messages: quoteTargets });
    const actions: MessageAction[] = [];
    // 工具图片注入（media view 等）：整条消息成卡（注册表 image 块），替代
    // 「[tool image]…」文本 dump；原始注记收进卡内折叠区（组件内部不动）。
    const imageBlock = blocks.find((block) => block.type === 'image');
    if (imageBlock !== undefined) {
      return <BlockView block={imageBlock} />;
    }
    if (message.content.trim().length > 0) {
      actions.push({
        id: 'copy',
        label: t('chat.message.copy'),
        onSelect: () => onCopy(message.content),
      });
      if (messageIndex !== undefined) {
        actions.push({
          id: 'edit',
          label: t('chat.message.edit'),
          onSelect: () => onEdit(messageIndex, message.content),
        });
      }
      if (onQuote !== undefined) {
        actions.push({
          id: 'quote',
          label: t('chat.quote.action'),
          onSelect: () => onQuote(message),
        });
      }
    }
    return (
      <div className="msg-user group flex max-w-full flex-col items-end gap-1">
        {/* 块按注册表顺序在气泡上方：先「回复哪一句」（quote），再会话引用卡，
            再「带了什么文件」（refs chip）。不改正文，也不影响 copy / edit。
            0.56：图片引用同时显示投递三态（从事件派生，服务端随历史下发）。 */}
        <MessageBlocks blocks={blocks} render={{ onJumpQuote }} />
        {/* 正文全部被块消费（如只有 vessel-ref token）时不留空气泡。 */}
        {body.length > 0 && (
          <div className="msg-bubble">
            <MessageFold>{body}</MessageFold>
          </div>
        )}
        {hasMeta || actions.length > 0 ? (
          <MessageActions className="justify-end" actions={actions} meta={meta} />
        ) : null}
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  // 块提升（块 P0）：AI 回复也可以带信封引用用户消息（双向同形）；session-ref
  // 信封同样提升成卡。一次 liftBlocks，未知正文原样渲染（零回归）。
  const { blocks, body } = liftBlocks(message, { messages: quoteTargets });
  // 思考块就在这个 item 里渲：被 live 认领的消息走不到这里（见 historyReasoning）。
  // q-msg-visibility：思考过程 toggle / minimal 档关闭时不渲（与 live 同一判定）。
  const reasoning = showReasoning ? historyReasoning(message) : undefined;
  // 时间归属：这一条**有**思考卡 ⇒ 时间在卡头（`ReasoningBlock` 的 `time`），正文下方
  // 的工具栏不再重复渲染。判据与 live 同源（`hasReasoningCard`；live 侧先在
  // `TranscriptWindow` 里按 run 汇总，再落到同一道门槛）。
  const meta = reasoning === undefined && clock !== '' ? clock : undefined;
  const actions: MessageAction[] = [];
  if (message.content.trim().length > 0) {
    actions.push({
      id: 'copy',
      label: t('chat.message.copy'),
      onSelect: () => onCopy(message.content),
    });
    if (onQuote !== undefined) {
      actions.push({
        id: 'quote',
        label: t('chat.quote.action'),
        onSelect: () => onQuote(message),
      });
    }
  }
  if (calls.length === 0 && previousUser !== undefined && previousUser.text.trim().length > 0) {
    actions.push({
      id: 'retry',
      label: t('chat.message.retry'),
      onSelect: () => onRetry(previousUser.index, previousUser.text),
    });
  }
  // 消息工具栏（复制 / 重试 / 时间）的位置按「是不是 run 结束消息」分两档
  // （q-message-toolbar，用户提案）：
  // - **run 结束消息**（无 tool_calls 的那条，带重试）：保持**正文下方一行、左对齐**；
  // - **非 run 结束消息**（带 tool_calls 的中间段，工具栏只有复制）：`placement="side"`
  //   浮在卡右上角内部（absolute，不占下方空间），避免正文下方空开一行造成割裂。
  // 判据与 live 侧同源：live 的「最后一段正文」落盘后就是无 tool_calls 的这条
  // （见 TranscriptWindow / RunItems 的 lastTextKey）。思考卡上不挂工具栏（用户明确
  // 去掉）；卡头只有一个独立的「复制思考」小按钮（见 `ReasoningBlock.tsx`）。
  // 显隐（hover / focus-within / 触屏常显）在 `MessageActions` 自己身上。
  // 时间不在这里的例外只有一个：上面那条 `meta`（有思考卡时为空，时间已上移卡头）。
  const isRunEnd = calls.length === 0;
  return (
    <div className="msg-assistant group relative max-w-full">
      {/* 块在最前：这条回复「针对哪一句」先于思考与正文（注册表顺序）。 */}
      <MessageBlocks blocks={blocks} render={{ onJumpQuote }} />
      {/* 思考在正文之前：与 live 一致（run 里 reasoning item 先于 text item）。
          `time` = 这条消息的时刻：有思考卡时，这一轮的时间只出现在卡头最右。 */}
      {reasoning !== undefined && (
        <ReasoningBlock text={reasoning} streaming={false} time={message.timestamp} />
      )}
      {/* 助手正文无底色气泡包裹 ⇒ 不折（与 live 的 `AssistantText` 同一口径）。 */}
      {body && <Markdown className="msg-text" text={body} />}
      {meta !== undefined || actions.length > 0 ? (
        <MessageActions
          className={isRunEnd ? 'mt-1' : undefined}
          placement={isRunEnd ? 'bottom' : 'side'}
          actions={actions}
          meta={meta}
        />
      ) : null}
    </div>
  );
});

/** 一条 item → 渲染节点。非消息类由调用方给（复用各自的组件）。 */
export type TranscriptItemRenderer = (item: TranscriptItem) => ReactNode;

/**
 * 非消息 item 的行容器（**行级 memo**，st-F1）：item 引用与渲染器引用都不变时
 * 整行跳过。渲染器（TranscriptWindow 的 renderItem）是 useCallback 稳定身份，
 * 其捕获的可见性 / 名字表等经渲染上下文 memo 稳定；item 引用由装配面的增量
 * 缓存保证（未变化 run 的 item 跨帧同对象）。渲染不出节点的 item 不留空 wrapper。
 */
const TranscriptItemRow = memo(function TranscriptItemRow({
  item,
  render,
}: {
  item: TranscriptItem;
  render: TranscriptItemRenderer;
}) {
  const node = render(item);
  if (node === null || node === undefined) return null;
  return <div className="transcript-row">{node}</div>;
});

/** item.ts → 本地日历日 key（按 item 对象缓存：item 不可变，ts 恒定）。 */
const DAY_KEY_CACHE = new WeakMap<TranscriptItem, string | null>();

function dayKeyOf(item: TranscriptItem): string | null {
  if (item.ts === undefined) return null;
  const cached = DAY_KEY_CACHE.get(item);
  if (cached !== undefined) return cached;
  const key = localDayKey(item.ts);
  DAY_KEY_CACHE.set(item, key);
  return key;
}

/**
 * item 流 → 消息区。
 *
 * 入场动画的边界（判据见 `TranscriptWindow` 的 `useEnteringItems`）：
 * - **只播「追加」不播「回填」**：`renderItem` 渲染的事件流项由调用方决定要不要挂入场类
 *   （`.msg-enter` / `.motion-appear`）；会话页在挂载 / F5 回放那一批上不播，之后的追加才播；
 * - **历史消息不播**：历史加载是「回填 / 换页」不是「追加」，而且 live 落盘后会把位置
 *   让给历史消息（`run:<runId>:input` 由 `msg:<runId>:<role>:<ts>` 接管，key 不同 =
 *   DOM 节点重建），两边都播就是同一段正文淡入两次。
 */
export function Transcript({
  items,
  allMessages,
  messageIndexOffset = 0,
  cardsDefaultOpen = false,
  showReasoning = true,
  renderItem,
  onEditMessage,
  onRetryMessage,
  onQuoteMessage,
  onJumpQuote,
}: {
  items: readonly TranscriptItem[];
  /** 已加载的完整消息窗口（未做可见性过滤），用于回溯窗口外的前一条用户输入。 */
  allMessages?: readonly Message[];
  /**  在完整  里的绝对下标。 */
  messageIndexOffset?: number;
  cardsDefaultOpen?: boolean;
  /** 思考过程可见（q-msg-visibility；缺省 true = 改动前行为）。 */
  showReasoning?: boolean;
  /** 非消息类 item（正文 / 思考 / 工具 / notice / 排队）的渲染器。 */
  renderItem: TranscriptItemRenderer;
  onEditMessage: (keepMessages: number, text: string) => void;
  onRetryMessage: (keepMessages: number, text: string) => void;
  /** 引用一条消息（q-message-quote）；缺省不渲染「引用」动作。 */
  onQuoteMessage?: (message: Message) => void;
  /** 引用块点击跳转原消息（data-quote-anchor）；缺省引用块纯展示。 */
  onJumpQuote?: (messageId: string) => void;
}) {
  const copy = useMessageCopy();
  // 每条消息都要知道自己在完整窗口里的绝对下标；一次建表，避免每渲染 O(n) 查找
  // （2000 条实测 2.83ms/渲染，流式 20Hz 就是 56ms/s）。
  const indexOf = useMemo(() => {
    const map = new Map<Message, number>();
    const list = allMessages ?? [];
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index];
      if (message !== undefined) map.set(message, index);
    }
    return map;
  }, [allMessages]);
  // 「前一条真实用户输入」按消息对象缓存（allMessages 引用不变时跨帧复用）：
  // 回溯查找只在历史窗口变化时跑一遍，不再每渲染对每条 assistant 消息重走。
  // 消息是不可变快照，previousUser 只依赖窗口内容 ⇒ 按对象 memo  sound。
  const previousUserOf = useMemo(() => {
    const map = new Map<Message, { text: string; index: number } | undefined>();
    const list = allMessages ?? [];
    for (const message of list) {
      if (message.role !== 'assistant') continue;
      map.set(message, previousUserMessage(message, allMessages, messageIndexOffset, indexOf));
    }
    return map;
  }, [allMessages, messageIndexOffset, indexOf]);
  if (items.length === 0) return null;

  const nodes: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const item of items) {
    const day = dayKeyOf(item);
    if (day && day !== lastDay) {
      nodes.push(
        <div
          className="mt-3.5 mb-2.5 flex items-center justify-center gap-2.5 py-1 font-mono text-2xs uppercase tracking-widest text-faint"
          key={`day-${day}`}
        >
          <span>{localDayLabel(item.ts ?? 0)}</span>
        </div>,
      );
      lastDay = day;
    }
    if (item.kind === 'message') {
      const message = item.message;
      // system / tool 在 TranscriptMessage 里返回 null：不进 DOM，也不留空锚点
      // （空 wrapper 会白占一个 flex gap）。索引映射同一判据，见 conversation-index.ts。
      if (message.role === 'system' || message.role === 'tool') continue;
      const sourceIndex = indexOf.get(message);
      const messageIndex =
        sourceIndex !== undefined && sourceIndex >= 0
          ? sourceIndex + messageIndexOffset
          : undefined;
      const previousUser = previousUserOf.get(message);
      nodes.push(
        // data-index-entry-key：会话索引竖条的跳转锚点（见 useConversationIndex.ts）。
        // 只给「人打的字」挂（与索引映射同一判据 isIndexUserMessage）：AI 回复 / 卡
        // 不带锚点，视口追踪天然只认 user 消息。wrapper 保留（flex 子项布局不变）。
        // transcript-row：视口外行跳过 layout/paint（content-visibility，见 chat.css）。
        <div
          key={item.key}
          className="transcript-row"
          data-index-entry-key={isIndexUserMessage(message) ? item.key : undefined}
          // data-quote-anchor：引用块跳转锚点（q-message-quote）。与索引锚点不同：
          // 所有带稳定身份的消息都挂（AI 回复也可被引用），按 message_id 定位。
          data-quote-anchor={message.message_id}
        >
          <TranscriptMessage
            message={message}
            messageIndex={messageIndex}
            {...(previousUser !== undefined ? { previousUser } : {})}
            {...(item.sourceText !== undefined ? { source: item.sourceText } : {})}
            cardsDefaultOpen={cardsDefaultOpen}
            showReasoning={showReasoning}
            onCopy={copy}
            onEdit={onEditMessage}
            onRetry={onRetryMessage}
            onQuote={onQuoteMessage}
            onJumpQuote={onJumpQuote}
            quoteTargets={allMessages}
          />
        </div>,
      );
      continue;
    }
    // 非消息 item（正文 / 思考 / 工具 / notice / 排队）不给索引锚点：索引只认 user 消息。
    // 行级 memo：item / render 引用不变 ⇒ 整行跳过（流式期每帧只动脏行）。
    nodes.push(<TranscriptItemRow key={item.key} item={item} render={renderItem} />);
  }
  // 垂直节奏（q-chat-spacing）：行间距统一 --space-2（8px，gap-2）——思考 / 正文 /
  // 卡片相邻等距且紧凑。角色切换的更大一档由 chat.css 的行级 :has 规则补（8+8=16）。
  return <div className="flex flex-col gap-2 py-1.5 pb-2.5">{nodes}</div>;
}
