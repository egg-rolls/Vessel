import { formatTimestamp, formatTokenCount } from '../../format';
import type { RunEvent } from '../../gateway/types';
import { t } from '../../i18n';
import { errorMetaOf, formatErrorMeta } from '../../state/error-visibility';
import { eventTag } from '../../state/events';

export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * `llm.request` 的消息条数（0.18）：服务端可能已把请求摘要化，
 * 只保留 `message_count` 而不再下发 `messages`。
 *
 * 优先用 `message_count`；否则用 `messages.length`；两者都没有时返回 null，
 * 调用方不渲染任何 msgs 数字（不能伪造成 0）。
 */
export function messageCountOf(data: Record<string, unknown>): number | null {
  if (typeof data.message_count === 'number') return data.message_count;
  if (Array.isArray(data.messages)) return data.messages.length;
  return null;
}

function ToolPayload({ label, value, open }: { label: string; value: unknown; open?: boolean }) {
  const text = payloadText(value);
  if (!text) return null;
  return (
    <details className="ml-2 inline-block align-top" open={open}>
      <summary className="inline cursor-pointer text-sm text-accent">{label}</summary>
      <pre className="mt-1.5 max-h-72 max-w-3xl overflow-auto rounded-sm bg-deep px-2.5 py-2 font-mono text-sm leading-relaxed text-muted whitespace-pre-wrap wrap-anywhere">
        {text}
      </pre>
    </details>
  );
}

function renderEventBody(event: RunEvent) {
  switch (event.type) {
    case 'tool.call.started': {
      const d = event.data as {
        tool_name?: string;
        arguments?: unknown;
        args?: unknown;
        truncated?: boolean;
      };
      const args = d.arguments !== undefined ? d.arguments : d.args;
      return (
        <>
          <span className="font-mono text-md">{d.tool_name ?? 'tool'}</span>
          {args !== undefined && (
            <>
              <span className="text-muted">{truncate(payloadText(args), 160)}</span>
              <ToolPayload label={t('chat.event.args')} value={args} />
              {d.truncated === true && (
                <span className="text-muted">{t('chat.event.truncated')}</span>
              )}
            </>
          )}
        </>
      );
    }
    case 'tool.call.completed': {
      const d = event.data as {
        tool_name?: string;
        duration_ms?: number;
        result?: unknown;
        truncated?: boolean;
      };
      return (
        <>
          <span className="font-mono text-md">{d.tool_name ?? 'tool'}</span>
          {d.duration_ms != null && <span className="text-muted">{d.duration_ms}ms</span>}
          {d.result !== undefined && (
            <>
              <span className="text-muted">{truncate(payloadText(d.result), 160)}</span>
              <ToolPayload label={t('chat.event.result')} value={d.result} />
              {d.truncated === true && (
                <span className="text-muted">{t('chat.event.truncated')}</span>
              )}
            </>
          )}
        </>
      );
    }
    case 'tool.call.failed': {
      const d = event.data as { tool_name?: string; error?: string };
      const meta = formatErrorMeta(errorMetaOf(event.data));
      return (
        <>
          <span className="font-mono text-md">{d.tool_name ?? 'tool'}</span>
          {meta && <span className="error-meta font-mono tabular-nums">{meta}</span>}
          <ToolPayload label={t('chat.event.errorExpanded')} value={d.error ?? 'error'} open />
        </>
      );
    }
    case 'guardrail.blocked': {
      const d = event.data as { guardrail_name?: string; reason?: string };
      return (
        <>
          <span className="font-mono text-md">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="text-muted">{truncate(d.reason ?? '', 160)}</span>
        </>
      );
    }
    case 'guardrail.modified': {
      const d = event.data as { guardrail_name?: string; stage?: string };
      return (
        <>
          <span className="font-mono text-md">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="text-muted">{d.stage ?? ''}</span>
        </>
      );
    }
    case 'llm.request': {
      const d = event.data as { messages?: unknown; message_count?: unknown; tools?: unknown };
      const messages = messageCountOf(event.data);
      const tools = Array.isArray(d.tools) ? d.tools.length : 0;
      const parts: string[] = [];
      if (messages !== null) parts.push(`${messages} msgs`);
      if (tools > 0) parts.push(`${tools} tools`);
      return <span className="text-muted">{parts.join(' · ')}</span>;
    }
    case 'llm.response': {
      const d = event.data as { finish_reason?: string; usage?: { total_tokens?: number } };
      return (
        <span className="text-muted">
          {d.finish_reason ?? ''}
          {d.usage?.total_tokens != null ? ` · ${d.usage.total_tokens} tok` : ''}
        </span>
      );
    }
    case 'error': {
      const d = event.data as { error?: string };
      const meta = formatErrorMeta(errorMetaOf(event.data));
      return (
        <>
          {meta && <span className="error-meta font-mono tabular-nums">{meta}</span>}
          <span className="text-danger">{truncate(d.error ?? 'error', 240)}</span>
        </>
      );
    }
    default:
      return <span className="text-muted">{truncate(JSON.stringify(event.data), 200)}</span>;
  }
}

const TAG_TONE: Record<string, string> = {
  'tag-tool-start': 'bg-info-soft text-info',
  'tag-tool-done': 'bg-success-soft text-success',
  'tag-tool-fail': 'bg-danger-soft text-danger',
  'tag-error': 'bg-danger-soft text-danger',
  'tag-guard': 'bg-warn-soft text-warn',
  'tag-llm': 'bg-accent-soft text-accent',
  'tag-raw': 'text-muted',
};

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortId(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? truncate(value, 12) : '?';
}

/**
 * 上下文生命周期事件 → 一条语义 notice。
 *
 * 与原始事件卡的区别：这里只呈现用户能行动的信号（水位百分比、压缩、轮换），
 * 文案在渲染时取 `t()`，locale 切换会跟着重算；未知类型返回 null 由调用方回退。
 */
function noticeView(event: RunEvent): { tone: 'info' | 'warn' | 'danger'; text: string } | null {
  const data = event.data;
  switch (event.type) {
    case 'context.pressure': {
      const used = numberOf(data.used);
      const max = numberOf(data.max);
      const ratio = numberOf(data.ratio);
      const percent =
        ratio !== undefined
          ? Math.round(ratio * 100)
          : used !== undefined && max !== undefined && max > 0
            ? Math.round((used / max) * 100)
            : undefined;
      return {
        tone: 'warn',
        text: t('chat.notice.contextPressure', {
          percent: percent ?? '?',
          used: used !== undefined ? formatTokenCount(used) : '?',
          max: max !== undefined ? formatTokenCount(max) : '?',
        }),
      };
    }
    case 'context.compacted': {
      return {
        tone: 'info',
        text: t('chat.notice.contextCompacted', {
          removed: numberOf(data.removed) ?? 0,
          remaining: numberOf(data.remaining) ?? 0,
          reason: typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : 'auto',
        }),
      };
    }
    case 'agent.limit.warning': {
      return {
        tone: 'warn',
        text: t('chat.notice.limitWarning', {
          key: typeof data.key === 'string' && data.key.length > 0 ? data.key : 'limit',
          current: numberOf(data.current) ?? '?',
          max: numberOf(data.max) ?? '?',
        }),
      };
    }
    case 'agent.rotating': {
      return {
        tone: 'info',
        text: t('chat.notice.rotating', {
          from: shortId(data.from_session_id),
          to: shortId(data.to_session_id),
        }),
      };
    }
    case 'agent.rotated': {
      return {
        tone: 'info',
        text: t('chat.notice.rotated', {
          from: shortId(data.from_session_id),
          to: shortId(data.to_session_id),
          epoch: numberOf(data.epoch) ?? '?',
        }),
      };
    }
    default:
      return null;
  }
}

export function NoticeRow({ event }: { event: RunEvent }) {
  const view = noticeView(event);
  if (!view) return <EventRow event={event} />;
  return (
    <div className={`stream-notice ${view.tone}`} role="status">
      <span className="min-w-0 flex-1 wrap-anywhere">{view.text}</span>
    </div>
  );
}

export function EventRow({ event }: { event: RunEvent }) {
  const tag = eventTag(event.type);
  const indent = tag.cls.startsWith('tag-tool-') ? ' ml-2.5 pl-3' : '';
  return (
    <div className={`flex items-baseline gap-2.5 py-1 text-md leading-relaxed text-muted${indent}`}>
      <span className="font-mono text-sm tabular-nums text-faint">
        {formatTimestamp(event.ts, { withMs: true })}
      </span>
      <span
        className={`rounded-xs bg-sunken px-1.5 font-mono text-sm leading-4 tracking-wide whitespace-nowrap ${TAG_TONE[tag.cls] ?? 'text-faint'}`}
      >
        {tag.label}
      </span>
      <span className="min-w-0 flex-1 wrap-anywhere">{renderEventBody(event)}</span>
    </div>
  );
}
