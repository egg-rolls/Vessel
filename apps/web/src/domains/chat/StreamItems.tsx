import { memo, useMemo } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip, StatusGlyph } from '../../components/StatusChip';
import { Button, type MessageAction, MessageActions, useMessageCopy } from '../../components/ui';
import { formatClock } from '../../format';
import { describeGatewayErrorText } from '../../gateway/errors';
import { t } from '../../i18n';
import { formatErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { AgentMessageCard } from './AgentMessageCard';
import { agentSenderOfName } from './agent-sender';
import { filterTimelineItems, reasoningVisible, runningToolHint } from './chat-visibility';
import { EventRow, NoticeRow } from './EventRow';
import { ReasoningBlock } from './ReasoningBlock';
import { StreamCard } from './StreamCard';
import { ToolCard } from './ToolCard';
import { foldToolItems } from './tool-cards';
import { type RunFailure, runFailureOfGroup } from './transcript-items';

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** 失败 run 的详情深链（与 RunsView 的 `#/runs?tab=live&run=…` 一致）。 */
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

export function UserBubble({ text, ts }: { text: string; ts?: number }) {
  const clock = formatClock(ts);
  return (
    <div className="msg-user group flex max-w-full flex-col items-end gap-1">
      <div className="msg-bubble">{text}</div>
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
  // 流式与取消态都按纯文本渲染：run 终止的瞬间不把同一段文字换成 Markdown +
  // 操作行，避免打断（stop）时整段高度突变导致滚动区跳动。
  const plainText = group.status === 'running' || status === 'cancelled';
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
  const showWaiting =
    group.status === 'running' &&
    !liveText &&
    !group.liveReasoning &&
    renderItems.length === 0 &&
    // 有工具在跑时显示的是那一行工具状态，不再叠一条「正在思考…」。
    toolHint === undefined;

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
          <UserBubble text={group.input} ts={group.startedAt} />
        ))}
      {renderItems.map((item) => {
        if (item.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={item.key}
              text={item.text}
              streaming={group.status === 'running' && item.key === lastReasoningKey}
              startedAt={item.startedAt}
              endedAt={item.endedAt}
            />
          );
        }
        if (item.kind === 'text') {
          return (
            <div className="msg-assistant group max-w-full" key={item.key}>
              {plainText ? (
                <div className="msg-text">{item.text}</div>
              ) : (
                <Markdown className="msg-text" text={item.text} />
              )}
              {!plainText && item.text.trim().length > 0 && (
                <MessageActions
                  className="mt-1"
                  actions={[
                    { id: 'copy', label: t('chat.message.copy'), onSelect: () => copy(item.text) },
                  ]}
                />
              )}
            </div>
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
      {liveText && (
        <div className="msg-assistant max-w-full">
          <div className="msg-text live-text">{liveText}</div>
        </div>
      )}
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
      {showWaiting && (
        <div className="run-waiting text-muted" role="status">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" aria-hidden="true" />
          {t('chat.run.waiting')}
        </div>
      )}
      {completedOutput !== undefined && !outputAlreadyShown && (
        <div className="msg-assistant group max-w-full">
          <Markdown className="msg-text" text={completedOutput} />
          <MessageActions
            className="mt-1"
            actions={[
              { id: 'copy', label: t('chat.message.copy'), onSelect: () => copy(completedOutput) },
            ]}
          />
        </div>
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
