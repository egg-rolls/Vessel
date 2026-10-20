import { useMemo } from 'react';
import { formatRoute } from '../../app/router';
import { Markdown } from '../../components/Markdown';
import { StatusChip } from '../../components/StatusChip';
import { formatTimestamp } from '../../format';
import { describeGatewayErrorText } from '../../gateway/errors';
import type { RunGroup } from '../../state/events';
import { EventRow } from './EventRow';
import { ToolCard } from './ToolCard';
import { foldToolItems } from './tool-cards';

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

/** 单次 run 卡片：顶部 run.started 边界，底部 run.completed/run.failed 边界。 */
export function RunCard({
  group,
  cancelled,
  cancelling,
  hideInput = false,
  onCancel,
}: {
  group: RunGroup;
  cancelled: boolean;
  cancelling: boolean;
  /** 历史消息里已经有同一条用户输入时，不再重复显示 run.input。 */
  hideInput?: boolean;
  onCancel: (group: RunGroup) => void;
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
  const renderItems = useMemo(() => foldToolItems(group.items), [group.items]);
  const errorHint = describeGatewayErrorText(group.error);

  return (
    <div className={`run-card ${status}`}>
      <div className="run-header">
        <StatusChip status={status} />
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {group.startedAt != null && <span className="dim">{formatTimestamp(group.startedAt)}</span>}
        {group.sessionId && <span className="dim">session {truncate(group.sessionId, 16)}</span>}
        {group.status === 'running' && group.jobId && !cancelled && (
          <button
            type="button"
            className="btn btn-danger-ghost btn-small"
            onClick={() => onCancel(group)}
            disabled={cancelling}
          >
            {cancelling ? '取消中…' : '取消 run'}
          </button>
        )}
      </div>

      {group.input && !hideInput && <div className="run-input">{group.input}</div>}

      <div className="run-items">
        {renderItems.map((item) => {
          if (item.kind === 'text') {
            return group.status === 'running' || status === 'running' ? (
              <div className="text-block" key={item.key}>
                {item.text}
              </div>
            ) : (
              <Markdown className="text-block" key={item.key} text={item.text} />
            );
          }
          if (item.kind === 'tool') return <ToolCard key={item.key} card={item} />;
          return <EventRow key={item.key} event={item.event} />;
        })}
      </div>

      {group.status === 'completed' && (
        <div className="run-footer completed">
          <div className="foot-meta">
            <StatusChip status="completed" />
            {group.durationMs != null && <span className="dim">{group.durationMs}ms</span>}
            {group.iterations != null && <span className="dim">{group.iterations} iters</span>}
            {group.completedAt != null && (
              <span className="dim">{formatTimestamp(group.completedAt)}</span>
            )}
          </div>
          {group.output && !outputAlreadyShown && (
            <Markdown className="run-output" text={group.output} />
          )}
        </div>
      )}
      {group.status === 'failed' && status === 'failed' && (
        <div className="run-footer failed">
          <StatusChip status="failed" />
          <details className="run-error">
            <summary className="run-error-summary">
              <span className="run-error-preview">
                {group.error ? truncate(group.error, 240) : '（无错误详情）'}
              </span>
              {group.error !== undefined && group.error.length > 240 && (
                <span className="run-error-toggle">展开</span>
              )}
            </summary>
            <pre className="run-error-body">{group.error || '（无错误详情）'}</pre>
          </details>
          {errorHint && <p className="run-error-hint">{errorHint}</p>}
          <a className="btn btn-small run-detail-link" href={runDetailHref(group)}>
            查看运行详情
          </a>
        </div>
      )}
      {status === 'cancelled' && (
        <div className="run-footer cancelled">
          <StatusChip status="cancelled" />
        </div>
      )}
    </div>
  );
}

/** 排队卡片：queued 阶段服务端不发事件，由提交响应 + 轮询驱动。 */
export function QueuedCard({
  item,
  onCancel,
}: {
  item: QueuedSubmission;
  onCancel: (runId: string) => void;
}) {
  const status = item.cancelled ? 'cancelled' : 'queued';
  const position =
    item.queuePosition != null ? `排队中 · 第 ${item.queuePosition} 位` : '排队中 · 位置未知';
  return (
    <div className={`run-card ${status}`}>
      <div className="run-header">
        <StatusChip status={status} label={item.cancelled ? '已取消' : position} />
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
            {item.cancelling ? '取消中…' : '取消排队'}
          </button>
        )}
      </div>
      <div className="run-input">{item.input}</div>
    </div>
  );
}
