import { memo, type ReactNode, useMemo, useState } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip, StatusGlyph } from '../../components/StatusChip';
import {
  Button,
  cn,
  type MessageAction,
  MessageActions,
  MessageFold,
  useMessageCopy,
} from '../../components/ui';
import { formatClock } from '../../format';
import { describeGatewayErrorText } from '../../gateway/errors';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { formatErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { AgentMessageCard } from './AgentMessageCard';
import { agentSenderOfName } from './agent-sender';
import { filterTimelineItems, reasoningVisible, runningToolHint } from './chat-visibility';
import { EventRow, NoticeRow } from './EventRow';
import { MessageRefs } from './MessageRefs';
import { AssistantSpeaker, ReasoningBlock } from './ReasoningBlock';
import { StreamCard } from './StreamCard';
import { ToolCard } from './ToolCard';
import { foldToolItems } from './tool-cards';
import { type RunFailure, runFailureOfGroup } from './transcript-items';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/**
 * 失败 run 的详情深链：`#/runs/<runId>?session=…`（独立详情页，不再内联展开）。
 * 与 `RunsView` 的 `useRunsPage` 同一套参数：tab 缺省 live。
 */
export function runDetailHref(group: Pick<RunGroup, 'runId' | 'sessionId'>): string {
  return formatRoute({
    domain: 'runs',
    tab: 'live',
    runId: group.runId,
    ...(group.sessionId ? { sessionId: group.sessionId } : {}),
  });
}

/** 已受理但尚未开始执行的 run（服务端 queued 阶段不发事件）。 */
export interface QueuedSubmission {
  runId: string;
  sessionId?: string;
  input: string;
  queuePosition?: number;
  submittedAt: number;
  cancelling: boolean;
  cancelled: boolean;
}

/** 实时气泡没有操作项：只借 MessageActions 的时间位与 hover 显隐规则。 */
const NO_ACTIONS: readonly MessageAction[] = [];

/**
 * 助手正文的**唯一**容器：`msg-assistant > div.markdown.msg-text`。
 *
 * 为什么必须只有一个：流式与落盘若各写一份外层，run 结束那一刻就会出现
 * 「容器换了一个形态」的跳动（高度 / hover 区 / 块元素的 margin 都会变）。
 * 现在流式（`streaming`）与非流式走完全相同的 DOM：`run-text` item 的 key 在 flush
 * 前后不变（`run:<runId>:text:<n>`，由 check-transcript-items 的 F2 钉死），
 * 所以结束时 React 复用同一批节点，只是把 `streaming` 从 true 翻成 false。
 *
 * 旧的 `<div className="msg-text live-text">` 已删除：`.live-text` 没有任何样式，
 * 保留它反而让流式与落盘的 class 列表不一致。
 *
 * 「唯一容器」还承担**动画**，而且两种出现方式**互斥**（叠在一起会发虚）：
 * - `.msg-enter`（段级：整段淡入 + 4px）只给「事件流里新追加、且一出现就是整段落定」的
 *   item（判定见 `TranscriptWindow.tsx` 的 `useEnteringItems` / `useEnteringItemKeys`）；
 * - `.motion-stream`（块级：正文块首次挂载时淡入 + blur 收敛，见 `styles/motion.css`）
 *   只给**流式出现**的正文 —— 也就是用户要的「先排版、后显示」。
 *
 * 判定按**首帧定格**（`useState` 初值，之后 `streaming` 翻转不改判）：这段正文第一次
 * 出现时是不是流式，决定它用哪一族。不这么做的话，run 结束时 `streaming` 翻成 false
 * 才补上的 `.msg-enter` 会迟到地播一次淡入。`.motion-stream` 本身只在 `streaming` 期间
 * 挂着（收字一结束就摘），免得收尾那一次解析口径变化（未闭合围栏 / 半张表格收成正式块）
 * 造成的块重建被当成「新块」再淡入一遍。
 *
 * 不重播的保证：`.motion-stream` 的动画挂在 `.markdown > *` 上，而 Markdown 的块是按
 * 下标 key 渲染的（`components/Markdown.tsx` 的 `MarkdownBlocks`：`blocks.map((block,
 * index) => <Block key={index} …/>)`，文件头有 biome-ignore 说明），流式增长时前面的块
 * 原地复用、只有真正新出现的块才挂新节点 ⇒ 只有新块播一次，追加文本不重播。
 * 容器本身在 streaming 翻转前后不变（`run:<runId>:text:<n>` 在 flush 前后同 key），
 * 所以挂类的时机也只在挂载 / 收字这两次。
 *
 * **这里不做长消息折叠**（0.50 起收窄折叠作用面）：助手正文是 `.msg-assistant`
 * —— 没有底色气泡包裹的纯正文，按用户裁定「有背景包裹的气泡才收」不折。折叠只留给
 * 有底色的气泡：实时用户气泡 `UserBubble`、历史用户气泡（`Transcript.tsx`）、团队页气泡
 * （`TeamMessageRow`，`.team-message-bubble` 有底色）。不要把 `MessageFold` 加回来 ——
 * 无底正文被裁到 400px + 渐隐没有任何视觉锚点，读者看不到「这是一段被收起的话」。
 *
 * 容器里另有两样东西：
 * - `speaker`：「助手」发言人名，与历史态同一个组件（`AssistantSpeaker`）；
 * - `actions`：这一段的工具栏（复制），由调用方给成 `MessageActions`，落在正文
 *   **下方一行、左对齐**（`mt-1` 在调用方那侧，见 `RunItems` 与 `TranscriptWindow`）。
 *   这里只把它摆在正文之后，不包任何定位壳子：没有覆盖层，所以 hover / focus-within
 *   出现时不会遮住正文（高度会变，这是旧形态的既定取舍，见 styles/domains/chat.css
 *   的工具栏说明）。
 */
export function AssistantText({
  text,
  streaming = false,
  actions,
  entering = false,
  speaker = false,
}: {
  text: string;
  /** 仍在流式收字：节流 + 未闭合块的保守降级（见 components/Markdown.tsx）。 */
  streaming?: boolean;
  /**
   * 这一段的工具栏（复制）。调用方负责给 `MessageActions`（自带 hover / focus-within /
   * 触屏常显的显隐规则）与 `mt-1` 间距。
   */
  actions?: ReactNode;
  /** 本帧才追加进来的项：入场只播一次（判定见 `TranscriptWindow.tsx` 的 `useEnteringItems`）。 */
  entering?: boolean;
  /** 这是这一轮助手的第一块：正文上方补「助手」发言人名（与历史态同一口径）。 */
  speaker?: boolean;
}) {
  // 首帧定格一次「这段正文怎么出现」（惰性初值只跑挂载那一次）：流式出现的走块级
  // `.motion-stream`，整段出现的走段级 `.msg-enter`。两者不同时生效，也不随 streaming
  // 翻转改判 —— 否则 run 结束时才补上的 `.msg-enter` 会迟到地播一次。
  const [reveal] = useState(() => (streaming ? 'stream' : entering ? 'enter' : 'none'));
  return (
    <div
      className={cn(
        'msg-assistant group max-w-full',
        reveal === 'enter' && 'msg-enter',
        // 收字结束就摘类：`streaming` 翻转会让 Markdown 换一次解析口径（未闭合围栏 /
        // 半张表格收成正式块），那一帧若有块重建，带着类就会补播一次级联淡入。
        reveal === 'stream' && streaming && 'motion-stream',
      )}
    >
      {speaker && <AssistantSpeaker />}
      <Markdown className="msg-text" text={text} streaming={streaming} />
      {actions}
    </div>
  );
}

/**
 * 「正在思考」：run 已经在跑、但这一轮还没有任何**可见**内容（正文 / 思考 / 工具卡）
 * 时的那一行状态。主会话页（`TranscriptWindow`）与子 agent（`RunItems`）共用同一份。
 *
 * 判据由调用方给（既有的 `running` 状态 + 「有没有可见内容」），这里不设定时器、
 * 也不猜时长：run 一进终态（completed / cancelled / failed），调用方的 running 就不再
 * 成立，这一行随即消失。「流式中的思考卡」用的是同一个词（`chat.reasoning.thinking`）
 * —— 同一个事实只有一个词，不要在两处各写一句。
 *
 * 动画只用 `styles/motion.css` 的 `.motion-appear`（只动透明度）：出现那一下不推挤
 * 贴底滚动，也不自带方向感。
 */
export function ThinkingHint() {
  return (
    <div className="run-waiting motion-appear text-muted" role="status">
      <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" aria-hidden="true" />
      {t('chat.reasoning.thinking')}
    </div>
  );
}

export function UserBubble({
  text,
  ts,
  entering = false,
  refs,
}: {
  text: string;
  ts?: number;
  /** 本帧才追加进来的项：入场只播一次（判定见 `useEnteringItemKeys`）。 */
  entering?: boolean;
  /** 附件引用（只有路径）：气泡上方一行 chip，与落盘后的历史气泡同一组件。 */
  refs?: readonly MessageRef[];
}) {
  const clock = formatClock(ts);
  return (
    <div
      className={cn(
        'msg-user group flex max-w-full flex-col items-end gap-1',
        entering && 'msg-enter',
      )}
    >
      <MessageRefs refs={refs} />
      <div className="msg-bubble">
        {/* 长气泡折叠与会话页历史气泡、团队页气泡同一套（见 MessageFold）。
            只有这种**有底色气泡**（`.msg-bubble`）才折；无底正文（助手）不折。 */}
        <MessageFold>{text}</MessageFold>
      </div>
      {/* 与落盘后的用户气泡同一套：时间在 hover 元信息位，不在气泡里。 */}
      <MessageActions
        className="justify-end"
        actions={NO_ACTIONS}
        meta={
          clock === '' ? undefined : <time dateTime={new Date(ts ?? 0).toISOString()}>{clock}</time>
        }
      />
    </div>
  );
}

/**
 * 一张 run 失败卡（时间线里「失败」的唯一形态）。
 *
 * 形态：状态 chip + 短 run id（meta）+ 240 字截断的错误摘要（折叠态）+ 展开后的完整
 * 错误原文 / 人话提示 + 「查看运行详情」深链（actions 插槽，始终可见，折叠不影响）。
 * 与工具卡 / 通知卡同一张 `StreamCard`（tone=danger），不再是一段 `<details>` 裸文本，
 * 也不是原始 JSON。
 *
 * 数据来源两条（同 run 只有一张卡，去重在 item 流里做，见 `transcript-items.ts`）：
 * - 事件流 `run.failed`（`runFailureOfGroup`）：有 `errorMeta`，因此能显示 code / 可重试；
 * - 会话记录快照（`sessionFailureOfDetail`）：刷新后仍在，只有错误原文 + 终态时刻。
 *
 * 不做「重试 / 续跑」：这两个动作在既有能力里都有，但入口各自绑定上下文 ——
 * 续跑要求运行记录可恢复（`runs.resume` 的 `run_not_resumable` 判定在运行详情页，
 * 那里才有 run 的 status / checkpoint），重试是重发某条用户消息（要 keepMessages 下标）。
 * 聊天里的失败卡没有这两样事实，硬塞按钮只会造出「点了报错」的假入口；
 * 可操作项统一收敛到运行详情深链（与旧的内联 notice 一致）。
 */
export function RunFailureCard({
  failure,
  defaultOpen = false,
}: {
  failure: RunFailure;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；用户手动开合优先。 */
  defaultOpen?: boolean;
}) {
  const meta = formatErrorMeta(failure.errorMeta);
  const hint = describeGatewayErrorText(failure.error);
  const error =
    failure.error !== undefined && failure.error.trim().length > 0 ? failure.error : undefined;
  // 没有错误原文就不给展开体 ⇒ StreamCard 渲染成纯行头（无 chevron，不响应点击）。
  const body =
    error !== undefined || hint !== null || failure.source === 'session' ? (
      <>
        <pre className="run-error-body">{error ?? t('chat.run.noError')}</pre>
        {hint !== null && <p className="run-error-hint">{hint}</p>}
        {failure.source === 'session' && (
          <p className="run-error-hint">{t('chat.run.failure.fromRecord')}</p>
        )}
      </>
    ) : undefined;
  return (
    <StreamCard
      className="run-failure-card w-full min-w-0 max-w-full"
      tone="danger"
      defaultOpen={defaultOpen}
      ariaLabel={t('chat.run.failure.aria')}
      title={<StatusChip status="failed" label={t('chat.run.failed')} />}
      meta={
        <span title={failure.runId}>
          {t('chat.run.failure.run', { id: truncate(failure.runId, 12) })}
        </span>
      }
      summary={
        error === undefined ? (
          t('chat.run.noError')
        ) : (
          <span className="text-danger">{truncate(error, 240)}</span>
        )
      }
      actions={
        <div className="flex flex-wrap items-center gap-2 px-2.5 pb-1">
          {meta !== '' && (
            <span className="error-meta font-mono tabular-nums">
              {meta}
              {failure.errorMeta?.retryable === true ? ` · ${t('chat.run.retryable')}` : ''}
            </span>
          )}
          <a
            className="ml-auto inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm bg-sunken px-2.5 py-1 text-sm tracking-wide text-ink no-underline transition-colors duration-150 tint-hover tint-press"
            href={runDetailHref(failure)}
          >
            {t('chat.run.detail')}
          </a>
        </div>
      }
    >
      {body}
    </StreamCard>
  );
}

/**
 * 会话流里的实时内容（0.18）。
 *
 * 这里不再有 RunCard / RunSection：一个 run 的输入、正文、思考、工具与错误
 * 直接展开成平铺的消息项，和 `Transcript` 的历史消息共享同一个列表与间距。
 * 失败留一张 `RunFailureCard`（主时间线由 `run-failure` item 渲染，这里是子 agent
 * transcript 的入口）；取消留一条内联 notice；停止入口在底部 Composer 区域。
 */
export const RunItems = memo(function RunItems({
  group,
  cancelled = false,
  hideInput = false,
  verbosity = 'normal',
  cardsDefaultOpen = false,
}: {
  group: RunGroup;
  /** 用户已请求取消且服务端最终报 failed 时，按取消态展示。 */
  cancelled?: boolean;
  /**
   * @deprecated 被  的认领取代：run 的用户输入现在是一个 item，
   * 历史消息被认领后由 run-input item 让位，不再靠内容比对隐藏气泡。
   */
  hideInput?: boolean;
  verbosity?: Verbosity;
  /** 卡片默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  cardsDefaultOpen?: boolean;
}) {
  const copy = useMessageCopy();
  const status =
    group.status === 'cancelled' || (cancelled && group.status === 'failed')
      ? 'cancelled'
      : group.status;
  // 流式**只表示“还在收字”**，不再决定用哪种渲染：正文一律 Markdown（见 AssistantText）。
  // 之前这里用 `plainText` 把 running / cancelled 整段降级成纯文本，于是 run 结束瞬间
  // 整段重排；取消态更糟——文字会从 md 退回到纯文本。
  const streamingText = group.status === 'running';
  // 操作行只在 run 落定后出现（与之前 `!plainText` 的判定等价）：停止 / 取消时不留
  // 一根悬在文字下方、随后会变的控件。
  const showActions = !streamingText && status !== 'cancelled';
  // 流式文本已经渲染在 items 里时，不再重复显示 run.completed.output。
  const inlineText = group.items
    .filter((item): item is { kind: 'text'; text: string; key: string } => item.kind === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
  const outputAlreadyShown = group.output !== undefined && inlineText.includes(group.output.trim());
  const completedOutput = group.status === 'completed' ? group.output : undefined;
  // 可见性判定只在 chat-visibility.ts 一处（history 侧共用同一规则），见该模块头注释。
  const foldedItems = useMemo(() => foldToolItems(group.items), [group.items]);
  const runRunning = group.status === 'running';
  const renderItems = useMemo(
    () => filterTimelineItems(foldedItems, { verbosity, running: runRunning }),
    [foldedItems, verbosity, runRunning],
  );
  // minimal 档把工具卡整体藏掉了，用一行紧凑状态说明「正在跑某个工具」，避免看起来卡住。
  const toolHint = useMemo(
    () => runningToolHint(foldedItems, { verbosity, running: runRunning }),
    [foldedItems, verbosity, runRunning],
  );
  // 只有最后一个思考块可能仍在流式输出；更早的块已经结束。
  const lastReasoningKey = useMemo(() => {
    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const item = renderItems[index];
      if (item?.kind === 'reasoning') return item.key;
    }
    return undefined;
  }, [renderItems]);
  // 0.17：流式尾部缓冲单独渲染；minimal 只隐藏思考流，正文仍然可见。
  const liveText = group.status === 'running' ? group.liveText : undefined;
  const liveReasoning =
    group.status === 'running' && reasoningVisible(verbosity) ? group.liveReasoning : undefined;
  // 「正在思考」的判据（只有既有的 `running` 状态，没有定时器）：
  // run 在跑、但这一轮**还没有任何可见内容**（正文 / 思考 / 工具卡）。以前这里用
  // `!group.liveReasoning`（未经过 verbosity 过滤）判断，minimal 档把思考流藏起来后
  // 这句话会被一起藏掉，于是「跑着却什么都看不到」—— 现在只认**实际会渲染**的那几项
  // （`renderItems` 已经过 chat-visibility 过滤：minimal 档的工具卡不在里面）。
  // 有工具在跑时显示的是那一行工具状态，不再叠一条「正在思考」。
  const hasVisibleContent = renderItems.some(
    (item) => item.kind === 'text' || item.kind === 'reasoning' || item.kind === 'tool',
  );
  const showThinking =
    runRunning && !hasVisibleContent && !liveText && !liveReasoning && toolHint === undefined;

  // 「助手」发言人名挂在**这一轮的第一块**（正文或思考卡）上：一个 run 只出现一次，
  // 与历史态的 groupStart 同一口径（连续同发言人不重复）。还没 flush 成 item 的尾部
  // 缓冲自己带头 —— 判据是「items 里还没有正文 / 思考项」。
  const speakerKey = useMemo(
    () => renderItems.find((item) => item.kind === 'text' || item.kind === 'reasoning')?.key,
    [renderItems],
  );
  const speakerTaken = speakerKey !== undefined;
  const tailReasoningSpeaker = !speakerTaken && liveReasoning !== undefined;
  const tailTextSpeaker = !speakerTaken && liveReasoning === undefined;

  // 输入的发言人：与 live item / 历史消息同一个判定（agent-sender.ts），
  // 有 sender 就渲染 agent 卡，否则用户气泡。
  const inputSender = agentSenderOfName(group.inputName);
  // 失败卡与时间线上的 `run-failure` item 是同一个组件、同一份数据（`runFailureOfGroup`）：
  // 子 agent transcript 走这里，主时间线走 item —— 两条路径都不会为同一 run 出第二张卡。
  const failure = status === 'failed' ? runFailureOfGroup(group) : undefined;

  return (
    <>
      {group.input &&
        !hideInput &&
        (inputSender !== undefined ? (
          <AgentMessageCard
            sender={inputSender}
            content={group.input}
            ts={group.startedAt}
            defaultOpen={cardsDefaultOpen}
          />
        ) : (
          <UserBubble text={group.input} ts={group.startedAt} refs={group.inputRefs} />
        ))}
      {renderItems.map((item) => {
        if (item.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={item.key}
              text={item.text}
              streaming={group.status === 'running' && item.key === lastReasoningKey}
              speaker={item.key === speakerKey}
            />
          );
        }
        if (item.kind === 'text') {
          return (
            <AssistantText
              key={item.key}
              text={item.text}
              streaming={streamingText}
              speaker={item.key === speakerKey}
              // 工具栏在正文**下方一行、左对齐**（`mt-1`）：没有覆盖层，不遮正文
              // （显隐规则在 MessageActions 自己身上）。
              actions={
                showActions && item.text.trim().length > 0 ? (
                  <MessageActions
                    className="mt-1"
                    actions={[
                      {
                        id: 'copy',
                        label: t('chat.message.copy'),
                        onSelect: () => copy(item.text),
                      },
                    ]}
                  />
                ) : undefined
              }
            />
          );
        }
        if (item.kind === 'tool') {
          return (
            <ToolCard
              key={item.key}
              card={item}
              verbosity={verbosity}
              defaultOpen={cardsDefaultOpen}
            />
          );
        }
        if (item.kind === 'notice') {
          return <NoticeRow key={item.key} event={item.event} defaultOpen={cardsDefaultOpen} />;
        }
        return <EventRow key={item.key} event={item.event} defaultOpen={cardsDefaultOpen} />;
      })}
      {liveReasoning && (
        <ReasoningBlock text={liveReasoning} streaming speaker={tailReasoningSpeaker} />
      )}
      {/* 收字尾巴：**不播入场**。它不是「追加的一项」—— 每 flush 一段正文它就被摘下再挂上
          （item 落位后尾巴清空，下一个 token 又出现），播了就是反复淡入；flush 落位的那份
          由 items 里的 AssistantText 负责。助手正文本身不折叠（见 AssistantText 头注释）。 */}
      {liveText && <AssistantText text={liveText} streaming speaker={tailTextSpeaker} />}
      {/* minimal 档的在飞工具：一行状态（工具名 + 运行中），不带参数 / 输出；
          工具结束或 run 结束即消失（判定见 chat-visibility#runningToolHint）。 */}
      {toolHint && (
        <div className="run-waiting text-muted" role="status">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" aria-hidden="true" />
          <span className="font-mono text-sm text-ink">{toolHint.name}</span>
          <span aria-hidden="true">·</span>
          {t('chat.tool.status.running')}
        </div>
      )}
      {showThinking && <ThinkingHint />}
      {completedOutput !== undefined && !outputAlreadyShown && (
        // 同一容器：`run.completed.output` 兜底的那段正文也是助手正文（同样不折）。
        // 它可能是一轮里唯一的内容块，那就由它带头（`speaker`）。
        <AssistantText
          text={completedOutput}
          speaker={!speakerTaken}
          actions={
            <MessageActions
              className="mt-1"
              actions={[
                {
                  id: 'copy',
                  label: t('chat.message.copy'),
                  onSelect: () => copy(completedOutput),
                },
              ]}
            />
          }
        />
      )}
      {failure !== undefined && <RunFailureCard failure={failure} defaultOpen={cardsDefaultOpen} />}
      {status === 'cancelled' && (
        <div className="stream-notice cancelled" role="status">
          <StatusGlyph status="cancelled" />
        </div>
      )}
    </>
  );
});

/**
 * 排队：与运行态工具卡同一张 StreamCard（单行摘要折叠，长输入不撑高）。
 *
 * 「取消排队」是**可操作控件**：放在 actions 插槽（始终可见），不进 summary，
 * 这样折叠状态下也能取消，且 summary 里没有可点元素。
 */
export function QueuedNotice({
  item,
  onCancel,
  defaultOpen = false,
}: {
  item: QueuedSubmission;
  onCancel: (runId: string) => void;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；排队卡是纯信息卡。 */
  defaultOpen?: boolean;
}) {
  const status = item.cancelled ? 'cancelled' : 'queued';
  const position =
    item.queuePosition != null
      ? t('chat.run.queuedPosition', { position: item.queuePosition })
      : t('chat.run.queuedUnknown');
  return (
    <StreamCard
      // 宽度跟内容列一致：长输入不再把卡片撑出可见列（w-full + min-w-0 + max-w-full）。
      className="stream-notice w-full min-w-0 max-w-full"
      defaultOpen={defaultOpen}
      title={
        <StatusChip status={status} label={item.cancelled ? t('chat.run.cancelled') : position} />
      }
      summary={item.input}
      actions={
        !item.cancelled ? (
          <div className="px-2.5 pb-1">
            <Button
              variant="link"
              className="stream-notice-action"
              onClick={() => onCancel(item.runId)}
              disabled={item.cancelling}
            >
              {item.cancelling ? t('chat.run.cancelling') : t('chat.run.cancelQueue')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <p className="m-0 min-w-0 px-2.5 pb-2 break-words whitespace-pre-wrap wrap-anywhere text-sm text-muted">
        {item.input}
      </p>
    </StreamCard>
  );
}
