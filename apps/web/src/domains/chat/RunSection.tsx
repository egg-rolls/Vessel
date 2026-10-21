import { memo, useEffect, useMemo, useState } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip } from '../../components/StatusChip';
import { formatClock, formatTimestamp } from '../../format';
import { describeGatewayErrorText } from '../../gateway/errors';
import { t } from '../../i18n';
import { formatErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { EventRow } from './EventRow';
import { ToolCard } from './ToolCard';
import { foldToolItems } from './tool-cards';

const REASONING_PREVIEW_LINES = 12;

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

/**
 * 可折叠的思考过程块：流式期间默认展开，run 结束后自动折叠；
 * 用户手动切换后不再被自动开合打断。内容按纯文本渲染，不进入正文 Markdown。
 */
function ReasoningBlock({
  text,
  streaming,
  startedAt,
  endedAt,
}: {
  text: string;
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  const [open, setOpen] = useState(streaming);
  const [userToggled, setUserToggled] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!userToggled) setOpen(streaming);
  }, [streaming, userToggled]);

  const lines = text.split('\n');
  const clamped = lines.slice(0, REASONING_PREVIEW_LINES).join('\n');
  const clampedVisible = !showAll && lines.length > REASONING_PREVIEW_LINES;
  const seconds =
    startedAt !== undefined && endedAt !== undefined && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : undefined;

  return (
    <details
      className="reasoning-block"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setUserToggled(true);
        setOpen(next);
      }}
    >
      <summary className="reasoning-summary">
        {t('chat.reasoning.summary')}
        {seconds !== undefined ? ` · ${seconds}s` : ''}
        {streaming ? <span className="reasoning-live"> · {t('chat.reasoning.live')}</span> : null}
      </summary>
      <div className="reasoning-text">{clampedVisible ? clamped : text}</div>
      {lines.length > REASONING_PREVIEW_LINES && (
        <button
          type="button"
          className="link-btn reasoning-more"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? t('chat.reasoning.collapse') : t('chat.reasoning.expand')}
        </button>
      )}
    </details>
  );
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

function UserBubble({ text, ts }: { text: string; ts?: number }) {
  const clock = formatClock(ts);
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        {text}
        {clock && (
          <time className="msg-time" dateTime={new Date(ts ?? 0).toISOString()}>
            {clock}
          </time>
        )}
      </div>
    </div>
  );
}

/**
 * 会话流里的一个 run 段（0.18）。
 *
 * run 不再是独立卡片：顶部只有一条细分割线（状态 / 时间 / run id / 取消），
 * 正文、思考、工具与错误和历史消息共用同一套消息样式，和 `Transcript`
 * 一起组成一条按时间正序的对话流。
 */
export const RunSection = memo(function RunSection({
  group,
  cancelled,
  cancelling,
  hideInput = false,
  onCancel,
  verbosity = 'normal',
}: {
  group: RunGroup;
  cancelled: boolean;
  cancelling: boolean;
  /** 历史消息里已经有同一条用户输入时，不再重复显示 run.input。 */
  hideInput?: boolean;
  onCancel: (group: RunGroup) => void;
  verbosity?: Verbosity;
}) {
  const status =
    group.status === 'cancelled' || (cancelled && group.status === 'failed')
      ? 'cancelled'
      : group.status;
  // 流式文本已经渲染在 items 里时，不再重复显示 run.completed.output。
  const inlineText = group.items
    .filter((item): item is { kind: 'text'; text: string; key: string } => item.kind === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
  const outputAlreadyShown = group.output !== undefined && inlineText.includes(group.output.trim());
  const renderItems = useMemo(() => {
    const items = foldToolItems(group.items);
    if (verbosity !== 'minimal') return items;
    // minimal：只保留正文、失败工具与非工具事件（失败永不静默）。
    return items.filter(
      (item) =>
        item.kind === 'text' ||
        item.kind === 'event' ||
        (item.kind === 'tool' && item.status === 'error'),
    );
  }, [group.items, verbosity]);
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
    group.status === 'running' && verbosity !== 'minimal' ? group.liveReasoning : undefined;
  const errorHint = describeGatewayErrorText(group.error);
  const showTimes = verbosity !== 'minimal';
  const showWaiting =
    group.status === 'running' && !liveText && !group.liveReasoning && renderItems.length === 0;

  return (
    <section
      className={`run-section ${status}`}
      aria-label={t('chat.run.label', { id: group.runId })}
    >
      <div className="run-divider">
        <StatusChip status={status} />
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {showTimes && group.startedAt != null && (
          <span className="dim">{formatTimestamp(group.startedAt)}</span>
        )}
        {group.status === 'running' && group.jobId && !cancelled && (
          <button
            type="button"
            className="btn btn-danger-ghost btn-small"
            onClick={() => onCancel(group)}
            disabled={cancelling}
          >
            {cancelling ? t('chat.run.cancelling') : t('chat.run.cancel')}
          </button>
        )}
      </div>

      {group.input && !hideInput && <UserBubble text={group.input} ts={group.startedAt} />}

      <div className="run-stream">
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
              <div className="msg msg-assistant" key={item.key}>
                {group.status === 'running' ? (
                  <div className="msg-text">{item.text}</div>
                ) : (
                  <Markdown className="msg-text" text={item.text} />
                )}
              </div>
            );
          }
          if (item.kind === 'tool') {
            return <ToolCard key={item.key} card={item} verbosity={verbosity} />;
          }
          return <EventRow key={item.key} event={item.event} />;
        })}
        {liveReasoning && <ReasoningBlock text={liveReasoning} streaming />}
        {liveText && (
          <div className="msg msg-assistant">
            <div className="msg-text live-text">{liveText}</div>
          </div>
        )}
        {showWaiting && (
          <div className="run-waiting dim" role="status">
            <span className="run-waiting-dot" aria-hidden="true" />
            {t('chat.run.waiting')}
          </div>
        )}
      </div>

      {group.status === 'completed' && (
        <>
          {group.output && !outputAlreadyShown && (
            <div className="msg msg-assistant">
              <Markdown className="msg-text" text={group.output} />
            </div>
          )}
          <div className="run-summary completed">
            <StatusChip status="completed" />
            {showTimes && group.durationMs != null && (
              <span className="dim">{group.durationMs}ms</span>
            )}
            {showTimes && group.iterations != null && (
              <span className="dim">{t('chat.run.iterations', { count: group.iterations })}</span>
            )}
            {showTimes && group.completedAt != null && (
              <span className="dim">{formatTimestamp(group.completedAt)}</span>
            )}
          </div>
        </>
      )}
      {group.status === 'failed' && status === 'failed' && (
        <div className="run-summary failed">
          <StatusChip status="failed" />
          {formatErrorMeta(group.errorMeta) && (
            <span className="error-meta mono">
              {formatErrorMeta(group.errorMeta)}
              {group.errorMeta?.retryable === true ? ` · ${t('chat.run.retryable')}` : ''}
            </span>
          )}
          <details className="run-error">
            <summary className="run-error-summary">
              <span className="run-error-preview">
                {group.error ? truncate(group.error, 240) : t('chat.run.noError')}
              </span>
              {group.error !== undefined && group.error.length > 240 && (
                <span className="run-error-toggle">{t('chat.run.expand')}</span>
              )}
            </summary>
            <pre className="run-error-body">{group.error || t('chat.run.noError')}</pre>
          </details>
          {errorHint && <p className="run-error-hint">{errorHint}</p>}
          <a className="btn btn-small run-detail-link" href={runDetailHref(group)}>
            {t('chat.run.detail')}
          </a>
        </div>
      )}
      {status === 'cancelled' && (
        <div className="run-summary cancelled">
          <StatusChip status="cancelled" />
        </div>
      )}
    </section>
  );
});

/** 排队段：queued 阶段服务端不发事件，由提交响应 + 轮询驱动。 */
export function QueuedSection({
  item,
  onCancel,
}: {
  item: QueuedSubmission;
  onCancel: (runId: string) => void;
}) {
  const status = item.cancelled ? 'cancelled' : 'queued';
  const position =
    item.queuePosition != null
      ? t('chat.run.queuedPosition', { position: item.queuePosition })
      : t('chat.run.queuedUnknown');
  return (
    <section
      className={`run-section ${status}`}
      aria-label={t('chat.run.label', { id: item.runId })}
    >
      <div className="run-divider">
        <StatusChip status={status} label={item.cancelled ? t('chat.run.cancelled') : position} />
        <span className="mono run-id" title={item.runId}>
          {truncate(item.runId, 24)}
        </span>
        {!item.cancelled && (
          <button
            type="button"
            className="btn btn-danger-ghost btn-small"
            onClick={() => onCancel(item.runId)}
            disabled={item.cancelling}
          >
            {item.cancelling ? t('chat.run.cancelling') : t('chat.run.cancelQueue')}
          </button>
        )}
      </div>
      <UserBubble text={item.input} ts={item.submittedAt} />
    </section>
  );
}
