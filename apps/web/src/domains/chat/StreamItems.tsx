import { memo, type ReactNode, useMemo, useState } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip, StatusGlyph } from '../../components/StatusChip';
import {
  Button,
  cn,
  Icon,
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
import { resolveUiVisibility, showsInternalEvents } from '../../state/visibility';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import { AgentMessageCard } from './AgentMessageCard';
import { agentSenderOfName } from './agent-sender';
import { filterTimelineItems, reasoningVisible, runningToolHint } from './chat-visibility';
import { composerIconControlClass, composerQuietIconTone } from './composer-controls';
import { EnvCard } from './EnvCard';
import { EventRow, NoticeRow } from './EventRow';
import {
  type ContextChangeEntry,
  contextChangeEntries,
  envCardOfPromptContext,
} from './env-notice';
import { humanizeRunError } from './error-text';
import { MessageRefs } from './MessageRefs';
import { ReasoningBlock } from './ReasoningBlock';
import { StreamCard } from './StreamCard';
import { ToolCard } from './ToolCard';
import { foldToolItems } from './tool-cards';
import { type PromptContextItem, type RunFailure, runFailureOfGroup } from './transcript-items';

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

/** 条带里的一条待处理输入（= inbox 条目；**没有 run id** —— 它还没变成一次执行）。 */
export interface QueuedSubmission {
  /** 条目 id（inbox 的 message_id）：取消 / 展开 / 折叠的稳定 key。 */
  id: string;
  input: string;
  submittedAt: number;
  /**
   * 写操作在途（取消排队 / 收回编辑）：两颗图标键一起禁用，取消那颗读屏名换「取消中…」。
   * 只是本地的在途标记 —— 它是「同一条消息同时只允许一次写」的唯一实现。
   */
  cancelling: boolean;
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
 * 容器里另有一件东西：
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
 * 信息层级（用户口径「折叠只留红点 + 错误，状态卡和 run id 放进展开体」）：
 * - 折叠态：语义圆点 + 单行错误摘要。卡头的 title / meta 槽**故意空着** —— 状态 chip 与
 *   run id 都在展开体里，卡头再放一次就是同一事实看两遍；
 * - 展开体（自上而下）：第一行运行失败状态 chip、第二行短 run id（hover 有完整 id），
 *   之后才是完整错误原文 / 人话提示，会话记录来源行垫底；
 * - `actions` 插槽（error-meta 含可重试标记 + 「查看运行详情」深链）在卡头外，折叠不影响。
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
  // 「能不能展开」仍然只由**可展示内容**决定（错误原文 / 人话提示 / 来源行）：状态 chip 与
  // run id 只是展开体里的排头两行，不能因为它们把没有错误原文的纯行头变成可展开卡。
  const expanded = error !== undefined || hint !== null || failure.source === 'session';
  // 0.52：错误文本分级。内部 reason 翻成人话；原文只在 debug 口径（与内部事件同一开关）下露出。
  const { config: configState } = useConfigStoreApi();
  const humanized = humanizeRunError(error);
  const showRawError = showsInternalEvents(
    resolveUiVisibility(configState.status === 'success' ? configState.data : null),
  );
  const body = expanded ? (
    <>
      {/* 展开体顶部两行（顺序固定，各占一行）：运行失败状态 → 运行 ID。
          两者都用既有排版类，不再进卡头。 */}
      <div className="flex flex-col items-start gap-1 pt-1">
        <StatusChip status="failed" label={t('chat.run.failed')} />
        <span className="text-2xs text-muted font-mono tabular-nums" title={failure.runId}>
          {t('chat.run.failure.run', { id: truncate(failure.runId, 12) })}
        </span>
      </div>
      {/* 0.52：错误文本分级 —— 内部 reason（lease_expired / stale_fence …）先翻成人话，
          原文只在 debug 口径下露出（ 或 Observe 面）。
          用户开着 normal 却在失败卡里看到  就是这里漏的。 */}
      <pre className="run-error-body">
        {humanized !== undefined && humanized.key !== undefined
          ? t(humanized.key)
          : (error ?? t('chat.run.noError'))}
      </pre>
      {humanized?.key !== undefined && showRawError && error !== undefined && (
        <pre className="run-error-body text-2xs text-muted">{error}</pre>
      )}
      {hint !== null && <p className="run-error-hint">{hint}</p>}
      {failure.source === 'session' && (
        <p className="run-error-hint">{t('chat.run.failure.fromRecord')}</p>
      )}
    </>
  ) : undefined;
  // `title` 是 StreamCard 的必填 prop，`null` 是合法 ReactNode（渲染成一个空 span，空占位
  // 的间距由 chat.css 里 `.run-failure-card ... .stream-card-title:empty` 收掉）。
  // `meta` 不传；折叠态的整行宽度都留给下面这行错误摘要。
  return (
    <StreamCard
      className="run-failure-card w-full min-w-0 max-w-full"
      tone="danger"
      defaultOpen={defaultOpen}
      ariaLabel={t('chat.run.failure.aria')}
      title={null}
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
 * 「环境信息 · 上下文」卡（`prompt.system_context`）：**模型这一轮看到的系统消息**。
 *
 * 用户裁定（0.52）：不再有「模型上下文」这种卡 —— 它就是**环境信息**的一种（scope
 * `context`，见 `env-notice.ts` 与 `packages/agent/src/env-info-scope.ts`）。
 *
 * 为什么这里不是另画一张卡：渲染**走 `EnvCard`**（环境信息的唯一渲染入口）。本组件只负责
 * 「把事件数据翻成一张环境信息卡」——组装 `EnvNoticeCard`（摘要 + 变更行）与两段全量原文块，
 * 外壳、卡头、展开机制全归 `EnvCard`。这样「环境信息只有一张卡」是结构事实，不是约定。
 *
 * 两种形态（同一张卡，数据决定形状）：
 * - **有 `changed`（增量）**：摘要只列「这次变了什么」（`模型: A → B`、`工具: 12 → 14`），
 *   展开仍是**全量快照** —— 用户要能一眼看出变化，也要能核对模型到底看到了什么；
 * - **没有 `changed`**（首次 / 旧日志 = 不知道）：退回全量摘要（模型 · 消息数 · 工具数 ·
 *   token）。**绝不**渲成「0 项变更」：那是编造结论。
 *
 * 数据来源只有一个：事件流（live + 回放投影，见 `transcript-items.ts` 的
 * `promptContextOfEvent`）。它不是 message，所以刷新后的可见性靠事件回放或
 * `sessions.get.system_context` 的派生快照。
 */
export function PromptContextCard({
  context,
  defaultOpen = false,
  entering = false,
}: {
  /** `transcript-items.ts` 解析出的卡片数据（含两段原文）。 */
  context: PromptContextItem;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；用户手动开合优先。 */
  defaultOpen?: boolean;
  /** 本帧才追加进来的项：入场只播一次（判定见 `TranscriptWindow.tsx`）。 */
  entering?: boolean;
}) {
  const changes = contextChangeEntries(context.changed ?? []);
  const hasChanges = changes.length > 0;
  // 增量形态的摘要 = 只列变了的项；否则退回全量摘要（首次 / 不知道）。
  // 全量摘要这几条**只进折叠态那一行**（facts），不进展开体：展开体给的是证据
  // （原文块 / hash / 窗口上限），不把摘要再抄一遍（用户 0.52 裁定）。
  const summaryParts = hasChanges
    ? changes.map((entry) => changeLineText(entry))
    : [
        context.model,
        context.messageCount !== undefined
          ? t('chat.modelContext.messages', { count: context.messageCount })
          : undefined,
        context.toolsCount !== undefined
          ? t('chat.modelContext.tools', { count: context.toolsCount })
          : undefined,
        context.estimatedTokens !== undefined
          ? t('chat.modelContext.tokens', { count: compactTokens(context.estimatedTokens) })
          : undefined,
      ].filter((part): part is string => part !== undefined && part.length > 0);
  return (
    <EnvCard
      env={envCardOfPromptContext(hasChanges ? summaryParts : [], [
        ...(context.systemPrompt !== undefined
          ? [{ labelKey: 'chat.modelContext.system', text: context.systemPrompt }]
          : []),
        ...(context.selfCard !== undefined
          ? [{ labelKey: 'chat.modelContext.selfCard', text: context.selfCard }]
          : []),
      ])}
      ts={context.ts}
      defaultOpen={defaultOpen}
      entering={entering}
      // 卡头 meta：有增量时「N 项变更」（全量摘要时留空 —— EnvCard 的「N 条」在这里恒为 1）。
      meta={hasChanges ? t('chat.env.changed.count', { count: changes.length }) : undefined}
      // 折叠态那一行：模型 / 条数 / 工具数 / 估算 tokens —— 一眼要看的事实。
      facts={hasChanges ? undefined : summaryParts}
      // 展开区首行：hash / 上一份 hash / 窗口上限，与其它卡同一处等宽小字。
      footnote={
        <>
          <span className="shrink-0 tabular-nums" title={context.hash}>
            {t('chat.modelContext.hash', { hash: context.hash })}
          </span>
          {context.previousHash !== undefined && (
            <span className="shrink-0 tabular-nums" title={context.previousHash}>
              {t('chat.env.changed.from', { hash: context.previousHash })}
            </span>
          )}
          {context.contextMax !== undefined && (
            <span className="shrink-0 tabular-nums">
              {t('chat.modelContext.contextMax', { count: compactTokens(context.contextMax) })}
            </span>
          )}
        </>
      }
    />
  );
}
/** `changed` 词表 → 本地化标签的键（认不出的键原样显示，不吞掉这条变更）。 */
const CHANGED_LABELS: Readonly<Record<string, string>> = {
  system_prompt: 'chat.env.changed.systemPrompt',
  self_card: 'chat.env.changed.selfCard',
  model: 'chat.env.changed.model',
  tools: 'chat.env.changed.tools',
};

/** `added` / `removed` / `replaced` 这类值词要本地化；`A → B`、数字原样显示。 */
const CHANGED_VALUE_WORDS: Readonly<Record<string, string>> = {
  added: 'chat.env.changed.added',
  removed: 'chat.env.changed.removed',
  replaced: 'chat.env.changed.replaced',
};

/** 一条增量 → 一行文本（`模型: A → B`）。标签与值词本地化，值本身是事实、不翻译。 */
function changeLineText(entry: ContextChangeEntry): string {
  const labelKey = CHANGED_LABELS[entry.key];
  const label = labelKey !== undefined ? t(labelKey as never) : entry.key;
  if (entry.value === undefined) return label;
  const valueKey = CHANGED_VALUE_WORDS[entry.value];
  const value = valueKey !== undefined ? t(valueKey as never) : entry.value;
  return `${label}: ${value}`;
}

/**
 * token 数的紧凑写法（`1.2k` / `850`）：折叠态摘要只有一行，五位以上的整数会把
 * 模型名和工具数挤出去。不引入新的 format 模块：整个 web 只有这一处需要它。
 */
function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
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
  // `interrupted`（S1d：快照说这一 run 被中断）在展示上等同取消态：run 已经不再往下跑，
  // 不留停止按钮 / 操作行；但组里的 `status` 仍是 `interrupted`，不会被当成完成。
  const status =
    group.status === 'cancelled' ||
    group.status === 'interrupted' ||
    (cancelled && group.status === 'failed')
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
              {...(item.startedAt !== undefined ? { time: item.startedAt } : {})}
            />
          );
        }
        if (item.kind === 'text') {
          return (
            <AssistantText
              key={item.key}
              text={item.text}
              streaming={streamingText}
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
      {liveReasoning && <ReasoningBlock text={liveReasoning} streaming />}
      {/* 收字尾巴：**不播入场**。它不是「追加的一项」—— 每 flush 一段正文它就被摘下再挂上
          （item 落位后尾巴清空，下一个 token 又出现），播了就是反复淡入；flush 落位的那份
          由 items 里的 AssistantText 负责。助手正文本身不折叠（见 AssistantText 头注释）。 */}
      {liveText && <AssistantText text={liveText} streaming />}
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
        <AssistantText
          text={completedOutput}
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
 * 排队卡里那两颗圆键的**底色层**：纯白 10% 半透明（`bg-white/10`），当成压在琥珀带上的一层
 * 玻璃 —— 用户要的是「透出下层颜色」，而不是形状层那个不透明灰（`bg-sunken`）。
 *
 * 为什么用「白色 + 透明度」而不是给三套主题各配一个色值：`--amber-soft` 在浅色档是暖白、
 * 在暗色两档（`prefers-color-scheme: dark` / `[data-theme="dark"]`）是暖黑，白 10% 叠在两种
 * 底上都读成「同一块底被提亮一点」，不用再维护一套随主题翻转的变量。hover 再加一档白
 * （`enabled:hover:bg-white/20`）：Button 的 `--hover-tint` 叠在**半透明**底上会被下层的琥珀
 * 带偏，白档给的是确定的「亮一档」，三个主题一致。禁用态两档都不生效（`enabled:` 挡住
 * hover），只剩这层白纱 + 形状层的 `disabled:opacity-100`，圆的形状不会塌。
 */
const QUEUED_ICON_VEIL = 'bg-white/10 enabled:hover:bg-white/20';

/**
 * 排队：与运行态工具卡同一张 StreamCard（单行摘要折叠，长输入不撑高）。
 *
 * 卡面走 **notice 家族**（`notice-block`：圆角 + 弱底色 + 统一内衬，与失败卡 / 运行时
 * 提示卡同一套），而不是以前那条 `.stream-notice` —— 那是「一行 notice」的行 flex
 * （`display: flex; flex-wrap: wrap`），套在卡上会让卡头、取消、展开体各自贴着内容宽度：
 * 短输入是一小截、长输入才撑开，卡片看起来「随内容变宽」（用户报过）。块级卡面下三者
 * 都按列宽排，短输入与多行输入卡宽一致。
 *
 * **色调就是这个组件要表达的东西**（用户裁决）：排队中的那条还没真正发出去，卡面用
 * 琥珀档（`--amber-soft` 底 + `--amber-ink` 文字，见 tokens.css：amber 是「未发送 / 排队中」
 * 专用语义色，不是通用 warn），把「未发送」与「正式消息」一眼分开。0.53 起这张卡只有一个
 * 状态（还在等）：取消成功 ⇒ 条目从 inbox 消失 ⇒ 整张卡消失，不再有「已取消」残留档。
 *
 * 卡面挂 `notice-block`：`tone` 的 neutral 档刻意不带家族类（工具卡 / 环境卡 /
 * agent 卡是裸行，不该被套上 notice 卡面），所以这里自己点家族类拿圆角 / 内衬；颜色由
 * 排队态那个修饰类（`stream-card-queued-waiting`，见 chat.css）覆盖成 amber。`tone` 保持
 * 默认 neutral —— StreamCard 的词表里没有 amber，也不该为一张卡去改卡原语。
 *
 * 卡头那颗胶囊落在琥珀底上，所以显式传 `StatusChip` 的 `onBand` 变体（不透明底 + ink
 * 文字），不用「淡底淡字」的默认档。
 *
 * 卡头左侧只留**一个**状态标记：`StatusChip` 的字形（○ 排队）已经表达了状态，
 * notice 家族的身份圆点不再叠一个（见 chat.css 的 `.stream-card-queued`）。
 *
 * 写操作是**可操作控件**，落在**正文下面一行**（用户裁决）：不进 `summary`（那里不放
 * 可点元素），也不用 StreamCard 的 `actions` 槽 —— 那个槽在卡头之后、展开体之前渲染，
 * 键就落在消息正文**上方**（用户报过）。这里把它们放进展开体、跟在正文段落之后。
 *
 * 两颗都是**圆形图标键**（`composerIconControlClass` 的 32px 正圆 + `Icon`）—— 与输入框的
 * 发送键 / 回形针同一套形状与三态，只是色调走次要档（`composerQuietIconTone`）：卡面是
 * 琥珀底，主色调的 accent 圆在暖底上会读成「主操作」，而这几颗都是次要动作。名字只走
 * `aria-label` + `title`（同一句 i18n），不再用可见文字：卡宽要跟列一致，几个中文标签会把
 * 那一行挤到换行。底色不用形状层的不透明灰，见 `QUEUED_ICON_VEIL`。
 *
 * **谁有写操作由调用方决定**（本组件只负责「给了就画」）：human 源给三颗（收回编辑 +
 * 取消排队 + 我已处理），agent 源一颗都不给 —— 它的回收语义是 unhold 留档（消息回到可读
 * unread，模型仍能 read），把它画成一个「撤掉」的按钮就是在伪装删除。
 *
 * **身份在卡内**：卡头 `meta` 槽写「这条是谁给的」（`human:` / `<agent 名>:`），
 * 正文 `summary` 仍只放那句话 —— 读起来是「等待中　human: 说的话」。以前身份是卡外左侧
 * 一个标签，卡片只是「条带里的一行」；现在身份是卡头的轻量标记，卡片自己就说得清是谁。
 * 顺序天然由 StreamCard 的卡头给出（`title` → `meta` → `summary`），所以身份一定落在
 * 「等待中」胶囊之后、正文之前，不需要在这里补间距（卡头是 `gap: 10px` 的 flex 行）。
 *
 * 不把身份拼进 `summary` 的理由：`summary` 是单行 ellipsis 的正文位，拼进去身份会跟着
 * 长文本一起被截掉，也失去「等宽小字 + 弱化色」的层次；`meta` 槽天生就是「标题后的
 * 轻量标记」（`font-mono text-2xs`）。
 */
export function QueuedNotice({
  item,
  onCancel,
  onEdit,
  onClaim,
  label,
  identity,
  defaultOpen = false,
}: {
  item: QueuedSubmission;
  /**
   * 取消：按**条目 id**（不是 run id —— 待处理条目没有 run）。
   *
   * 缺省 = 不给「取消排队」（agent 源：recall 对它只是 unhold 留档，画成删除就是骗人）。
   */
  onCancel?: (id: string) => void;
  /**
   * 收回编辑：按**条目 id**。缺省 = 不给这颗键（同上，只有 human 源的 recall 是真删）。
   *
   * 动作本身（peek 正文 → 回填草稿 → recall）在调用方：本组件不知道草稿槽在哪，
   * 也不该知道。
   */
  onEdit?: (id: string) => void;
  /**
   * 我已处理（claim）：按**条目 id**。缺省 = 不给这颗键。
   *
   * 语义是「这条我自己处理了，别再送给模型」，**不可逆**（拿走的条目再也回不来），所以
   * 名字必须走 `aria-label` / `title`，不能只画一个图形 —— 没有字的图标键读不出「不可逆」。
   * 只有 human 源给：agent 源的条目是别人发给这具 body 的输入，人没有「代它处理」的立场。
   */
  onClaim?: (id: string) => void;
  /**
   * 卡头文案；缺省「等待中」（`chat.pending.waiting`）。
   *
   * 不编队列序号：条目落盘后没有权威顺序（`ts` 只保证「谁先到」），而 run 的
   * `queue_position` 是调度器口径、对没有 run 的条目无意义。
   */
  label?: string;
  /**
   * 身份（这条待处理输入是谁给的）：卡头 `meta` 槽，落在「等待中」胶囊之后。
   *
   * 由调用方给**纯名字**（条带：`human` 走 i18n，agent 源给名 / id），冒号在这里补 ——
   * 卡面统一是 `<身份>: <说的话>`，不指望上游记得带分隔符。缺省 = 不渲染身份槽
   * （卡头回到「胶囊 + 摘要」两段，与没有身份的排队项一致）。
   */
  identity?: string;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；排队卡是纯信息卡。 */
  defaultOpen?: boolean;
}) {
  // 待处理条目只有一种状态：还在等（取消成功 ⇒ 条目消失 ⇒ 整张卡消失，没有残留态）。
  const status = 'queued';
  const stateClass = 'stream-card-queued-waiting';
  // 两颗键的公共形：形状层只取一次（与输入框的发送键 / 回形针同一份），色调走次要档，
  // 底色换成这层白纱（`QUEUED_ICON_VEIL`；twMerge 会把形状层的 `bg-sunken` 让掉）。
  const controlClass = cn(composerIconControlClass, composerQuietIconTone, QUEUED_ICON_VEIL);
  // 取消在途：三颗都禁用 —— 同一条消息不能同时被「收回来」「撤掉」「标记已处理」，
  // 那是三条写操作的竞争（claim 还不可逆，抢在前面最糟）。
  const busy = item.cancelling;
  // 写操作行：一颗键都没给（agent 源）就整个不出现 —— 不留「有槽无键」的空行。
  // 一行最多三颗 32px 正圆：卡片本身就是满宽块（`.notice-block`），这一行按列宽排，
  // 小屏也不会把卡撑宽（`flex-none` + 定尺寸盒子）。
  // 只有**上方**间距（`pt-1.5`）：横向内衬由展开体那条 `.notice-block > .event-block-body`
  // 统一给（10px），这里再补 px 就是双重内衬，键会比正文多缩 10px。
  let controls: ReactNode = null;
  if (onCancel !== undefined || onEdit !== undefined || onClaim !== undefined) {
    controls = (
      <div className="flex items-center gap-1.5 pt-1.5">
        {onEdit !== undefined && (
          <Button
            variant="plain"
            className={controlClass}
            aria-label={t('chat.pending.edit')}
            title={t('chat.pending.edit')}
            disabled={busy}
            onClick={() => onEdit(item.id)}
          >
            <Icon name="edit" size={14} />
          </Button>
        )}
        {onCancel !== undefined && (
          <Button
            variant="plain"
            className={controlClass}
            // 名字沿用可见文字那一版的 key（`chat.run.cancelQueue` = 「取消排队」），
            // 在途时换成「取消中…」—— 图标键没有文字态，这层反馈只能走 title / 读屏名。
            aria-label={busy ? t('chat.run.cancelling') : t('chat.run.cancelQueue')}
            title={busy ? t('chat.run.cancelling') : t('chat.run.cancelQueue')}
            disabled={busy}
            onClick={() => onCancel(item.id)}
          >
            <Icon name="retract" size={14} />
          </Button>
        )}
        {onClaim !== undefined && (
          <Button
            variant="plain"
            className={controlClass}
            // 不可逆动作，名字必须完整说出来（图标键没有文字态）。
            aria-label={busy ? t('chat.pending.claimInFlight') : t('chat.pending.claim')}
            title={busy ? t('chat.pending.claimInFlight') : t('chat.pending.claim')}
            disabled={busy}
            onClick={() => onClaim(item.id)}
          >
            {/* 不可逆动作，图形语义不能借：`Icon` 里的 `chevron` 在 StreamCard 卡头已是
                展开 / 收起，用在这里会被读成「展开」。所以这一颗走专门的 `check`
                （「已处理」最直接的图形），不是临时找一个近似的。 */}
            <Icon name="check" size={14} />
          </Button>
        )}
      </div>
    );
  }
  return (
    <StreamCard
      // 卡宽跟列一致（w-full + min-w-0 + max-w-full）：短输入不缩水、长输入不撑宽。
      className={`notice-block stream-card-queued w-full min-w-0 max-w-full ${stateClass}`.trim()}
      defaultOpen={defaultOpen}
      title={
        <StatusChip
          status={status}
          label={label ?? t('chat.pending.waiting')}
          // 排队中的胶囊在琥珀底上 ⇒ onBand（不透明底 + ink 文字）。
          variant="onBand"
        />
      }
      summary={item.input}
      // 身份：`human:` / `<agent 名>:` —— 卡头 flex 顺序是 title → meta → summary，
      // 所以它一定落在「等待中」胶囊之后、正文之前。颜色用这条带的前景色 `--amber`
      //（tokens.css 里 amber 档的「前景 / 图标」角色，展开 chevron 同色）：meta 槽默认的
      // `text-faint` 压在 `--amber-soft` 上只有约 3.8:1，2xs 小字读不清。
      meta={identity === undefined ? undefined : <span className="text-amber">{identity}:</span>}
    >
      {/* 正文是用户自己写的那条消息，压在琥珀底上也要读得清：用 ink，不用 muted。
          内衬由 `.notice-block > .event-block-body` 给，这里不再补 px。 */}
      <p className="m-0 min-w-0 break-words whitespace-pre-wrap wrap-anywhere text-sm text-ink">
        {item.input}
      </p>
      {/* 两颗键**在正文之后**（用户裁决：工具栏属于「对这条消息的操作」，读它的人先看字
          再动手）。不进卡头、也不走 StreamCard 的 `actions` 槽 —— 那个槽渲染在卡头与展开体
          之间，键就跑到正文上方去了。折叠态 `<details>` 只渲染 `<summary>`，`actions` 槽与
          这段展开体同样不可见，所以换到这里没有拿走任何「折叠时也能点」的能力。 */}
      {controls}
    </StreamCard>
  );
}
