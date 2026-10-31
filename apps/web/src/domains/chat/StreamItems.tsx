import { memo, useEffect, useMemo, useState } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip, StatusGlyph } from '../../components/StatusChip';
import { Button } from '../../components/ui';
import { formatClock } from '../../format';
import { describeGatewayErrorText } from '../../gateway/errors';
import { t } from '../../i18n';
import { formatErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import type { Verbosity } from '../../state/visibility';
import { EventRow, NoticeRow } from './EventRow';
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
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-sm text-faint hover:text-muted">
        {t('chat.reasoning.summary')}
        {seconds !== undefined ? ` · ${seconds}s` : ''}
        {streaming ? (
          <span className="reasoning-live text-info"> · {t('chat.reasoning.live')}</span>
        ) : null}
      </summary>
      <div className="px-2.5 py-2 text-md leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {clampedVisible ? clamped : text}
      </div>
      {lines.length > REASONING_PREVIEW_LINES && (
        <Button
          variant="link"
          className="mx-2.5 mb-2 text-xs"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? t('chat.reasoning.collapse') : t('chat.reasoning.expand')}
        </Button>
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
    <div className="msg-user flex max-w-full justify-end">
      <div className="msg-bubble">
        {text}
        {clock && (
          <time
            className="mt-1 block text-right font-mono text-2xs tabular-nums text-faint"
            dateTime={new Date(ts ?? 0).toISOString()}
          >
            {clock}
          </time>
        )}
      </div>
    </div>
  );
}

/** 失败 run 内联成一条 notice：错误 envelope + 可展开详情 + 运行详情链接。 */
function FailureNotice({ group }: { group: RunGroup }) {
  const meta = formatErrorMeta(group.errorMeta);
  const hint = describeGatewayErrorText(group.error);
  return (
    <div className="stream-notice failed" role="alert">
      <StatusGlyph status="failed" />
      {meta && (
        <span className="error-meta font-mono tabular-nums">
          {meta}
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
      {hint && <p className="run-error-hint">{hint}</p>}
      <a
        className="ml-auto inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm bg-sunken px-2.5 py-1 text-sm tracking-wide text-ink no-underline transition-colors duration-150 tint-hover tint-press"
        href={runDetailHref(group)}
      >
        {t('chat.run.detail')}
      </a>
    </div>
  );
}

/**
 * 会话流里的实时内容（0.18）。
 *
 * 这里不再有 RunCard / RunSection：一个 run 的输入、正文、思考、工具与错误
 * 直接展开成平铺的消息项，和 `Transcript` 的历史消息共享同一个列表与间距。
 * 失败/取消只留一条内联 notice；停止入口在底部 Composer 区域。
 */
export const RunItems = memo(function RunItems({
  group,
  cancelled = false,
  hideInput = false,
  verbosity = 'normal',
}: {
  group: RunGroup;
  /** 用户已请求取消且服务端最终报 failed 时，按取消态展示。 */
  cancelled?: boolean;
  /** 历史消息里已经有同一条用户输入时，不再重复显示 run.input。 */
  hideInput?: boolean;
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
    // minimal：只保留正文、上下文 notice、失败工具与非工具事件（失败永不静默）。
    return items.filter(
      (item) =>
        item.kind === 'text' ||
        item.kind === 'notice' ||
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
  const showWaiting =
    group.status === 'running' && !liveText && !group.liveReasoning && renderItems.length === 0;

  return (
    <>
      {group.input && !hideInput && <UserBubble text={group.input} ts={group.startedAt} />}
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
            <div className="msg-assistant max-w-full" key={item.key}>
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
        if (item.kind === 'notice') {
          return <NoticeRow key={item.key} event={item.event} />;
        }
        return <EventRow key={item.key} event={item.event} />;
      })}
      {liveReasoning && <ReasoningBlock text={liveReasoning} streaming />}
      {liveText && (
        <div className="msg-assistant max-w-full">
          <div className="msg-text live-text">{liveText}</div>
        </div>
      )}
      {showWaiting && (
        <div className="run-waiting text-muted" role="status">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" aria-hidden="true" />
          {t('chat.run.waiting')}
        </div>
      )}
      {group.status === 'completed' && group.output && !outputAlreadyShown && (
        <div className="msg-assistant max-w-full">
          <Markdown className="msg-text" text={group.output} />
        </div>
      )}
      {group.status === 'failed' && status === 'failed' && <FailureNotice group={group} />}
      {status === 'cancelled' && (
        <div className="stream-notice cancelled" role="status">
          <StatusGlyph status="cancelled" />
        </div>
      )}
    </>
  );
});

/** 排队：流末尾的一条轻量 notice，不占独立卡片。 */
export function QueuedNotice({
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
    <div className={`stream-notice ${status}`} role="status">
      <StatusChip status={status} label={item.cancelled ? t('chat.run.cancelled') : position} />
      <span className="stream-notice-input">{item.input}</span>
      {!item.cancelled && (
        <Button
          variant="link"
          className="stream-notice-action"
          onClick={() => onCancel(item.runId)}
          disabled={item.cancelling}
        >
          {item.cancelling ? t('chat.run.cancelling') : t('chat.run.cancelQueue')}
        </Button>
      )}
    </div>
  );
}
