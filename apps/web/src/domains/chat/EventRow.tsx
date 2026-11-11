import { formatTimestamp, formatTokenCount } from '../../format';
import type { RunEvent } from '../../gateway/types';
import { t } from '../../i18n';
import { errorMetaOf, formatErrorMeta } from '../../state/error-visibility';
import { tierOf } from '../../state/event-visibility';
import { eventTag } from '../../state/events';
import { StreamCard } from './StreamCard';

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

/**
 * 事件的单行核心摘要（折叠态 summary）。
 *
 * 只保留用户扫一眼需要的信息；完整载荷在展开区由 `EventPayload` 渲染。
 * 错误事件（`error` / `*.failed`）的错误文本必须留在这里，不能只藏在展开区。
 */
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
          <span className="text-danger">{truncate(d.error ?? 'error', 240)}</span>
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
    default: {
      // 兜底的 `*.failed`：摘要保留错误文本，展开区仍有完整载荷。
      const d = event.data as { error?: unknown };
      if (event.type.endsWith('.failed') && typeof d.error === 'string' && d.error.length > 0) {
        const meta = formatErrorMeta(errorMetaOf(event.data));
        return (
          <>
            {meta && <span className="error-meta font-mono tabular-nums">{meta}</span>}
            <span className="text-danger">{truncate(d.error, 240)}</span>
          </>
        );
      }
      return <span className="text-muted">{truncate(jsonPreview(event.data), 200)}</span>;
    }
  }
}

/**
 * 原始事件 data 的 JSON 预览，按对象引用缓存。
 *
 * 未分类事件行在流式期间每帧重渲，`JSON.stringify` 对大 payload 不便宜；
 * `event.data` 是每次事件新造的对象、渲染期间引用稳定，WeakMap 既命中又不会泄漏。
 */
const jsonPreviewCache = new WeakMap<object, string>();

function jsonPreview(data: unknown): string {
  if (typeof data !== 'object' || data === null) return JSON.stringify(data) ?? String(data);
  const cached = jsonPreviewCache.get(data);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(data) ?? String(data);
  jsonPreviewCache.set(data, text);
  return text;
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
    case 'agent.restarting': {
      return {
        tone: 'info',
        text: t('chat.notice.restarting', {
          session: shortId(data.from_session_id ?? data.session_id),
          from: numberOf(data.from_epoch) ?? '?',
          epoch: numberOf(data.epoch) ?? '?',
        }),
      };
    }
    case 'agent.restarted': {
      return {
        tone: 'info',
        text: t('chat.notice.restarted', {
          session: shortId(data.from_session_id ?? data.session_id),
          from: numberOf(data.from_epoch) ?? '?',
          epoch: numberOf(data.epoch) ?? '?',
        }),
      };
    }
    case 'agent.compact_forked': {
      return {
        tone: 'info',
        text: t('chat.notice.compactForked', {
          from: shortId(data.from_session_id),
          to: shortId(data.to_session_id),
          epoch: numberOf(data.epoch) ?? '?',
        }),
      };
    }
    // 失败类 notice：错误文本 + 来源阶段（只换表示层，可见性仍归 `errorLevel`，
    // 见 events.ts 里这两个 case 的注释）。
    case 'run.finalize.failed': {
      const error = typeof data.error === 'string' && data.error.length > 0 ? data.error : 'error';
      const phase =
        typeof data.phase === 'string' && data.phase.length > 0 ? data.phase : 'finalize';
      return {
        tone: 'danger',
        text: t('chat.notice.finalizeFailed', { phase, error: truncate(error, 240) }),
      };
    }
    case 'guardrail.error': {
      const name =
        typeof data.guardrail_name === 'string' && data.guardrail_name.length > 0
          ? data.guardrail_name
          : 'guardrail';
      const stage = typeof data.stage === 'string' && data.stage.length > 0 ? data.stage : '?';
      const error = typeof data.error === 'string' && data.error.length > 0 ? data.error : 'error';
      return {
        tone: 'danger',
        text: t('chat.notice.guardrailError', { name, stage, error: truncate(error, 240) }),
      };
    }
    // hook.* 是内部执行细节：折叠成一行 notice，展开仍是完整载荷。
    case 'hook.started':
    case 'hook.completed':
    case 'hook.system_prompt_ignored':
    case 'hook.additional_context_deprecated': {
      const name =
        typeof data.hook_name === 'string' && data.hook_name.length > 0
          ? data.hook_name
          : event.type;
      return { tone: 'info', text: t('chat.notice.hook', { name }) };
    }
    // 「旧身体这一轮回复产出过、但被 epoch fencing 丢弃」的唯一解释：团队日志对已退役
    // Binding 的 run.completed 是**显式抑制**的，所以这段话为什么没出现，只有这里能说。
    case 'agent.reply.stale': {
      return {
        tone: 'warn',
        text: t('chat.notice.replyStale', {
          message: shortId(data.message_id),
          epoch: numberOf(data.epoch) ?? '?',
        }),
      };
    }
    // 旧身体退役：`reason`（rotate / restart / close / 回收）只在这条事件的 data 里
    // （服务端 `body_history` DTO 没有这个字段），所以 notice 必须把它念出来，
    // 不能只剩一句「已退役」。
    case 'agent.retired': {
      return {
        tone: 'info',
        text: t('chat.notice.retired', {
          reason: typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : '?',
          epoch: numberOf(data.epoch) ?? '?',
          body: shortId(data.body_id),
        }),
      };
    }
    // rotate 审批被拒：拒绝原因（`denied_by_human` / `no_human_channel`）与当时的
    // 上下文水位只在这条事件的 data 里。
    case 'agent.rotate.denied': {
      return {
        tone: 'warn',
        text: t('chat.notice.rotateDenied', {
          reason: typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : '?',
          percent: numberOf(data.context_percent) ?? '?',
        }),
      };
    }
    default:
      // **未登记的类型**（第三方插件 / 上游事件 / 旧 trace）：`buildGroup` 的 default
      // 分支把它落成 notice 而不是原始事件卡，这里给出唯一的「未知事件类型 · 已折叠」
      // 文案 —— 展开区仍是原始载荷，但时间线上绝不出现裸 JSON。
      // 已登记但没有 typed notice 的类型返回 null，由调用方退回原始事件行（摘要逐类型给）。
      return tierOf(event.type) === undefined
        ? { tone: 'info', text: t('chat.notice.unknownEvent', { type: event.type }) }
        : null;
  }
}

/** 展开区：事件元信息 + 完整原始载荷。 */
function EventPayload({ event }: { event: RunEvent }) {
  // 运行时可能缺省 data；类型上它不可空，先落到 unknown 再判空，避免伪造 "undefined"。
  const data: unknown = event.data;
  const text = data === undefined || data === null ? '' : payloadText(data);
  return (
    <div className="event-block-body">
      <div className="event-raw-label">{t('chat.event.raw')}</div>
      <dl className="event-meta-list" aria-label={t('chat.event.meta')}>
        <dt>{t('chat.event.type')}</dt>
        <dd className="font-mono wrap-anywhere">{event.type}</dd>
        <dt>{t('chat.event.time')}</dt>
        <dd className="font-mono tabular-nums">{formatTimestamp(event.ts, { withMs: true })}</dd>
        <dt>{t('chat.event.runId')}</dt>
        <dd className="font-mono wrap-anywhere">{event.run_id}</dd>
      </dl>
      <div className="event-raw-label">{t('chat.event.rawData')}</div>
      <pre className="event-raw-pre">{text || t('chat.event.empty')}</pre>
    </div>
  );
}

/**
 * 上下文生命周期 / 内部事件 → 一张语义色调卡（与工具卡同一套 StreamCard）。
 *
 * 折叠态只显示一行语义文案；展开后是完整载荷。默认开合听调用方的卡片开关。
 */
export function NoticeRow({
  event,
  defaultOpen = false,
}: {
  event: RunEvent;
  defaultOpen?: boolean;
}) {
  const view = noticeView(event);
  if (!view) return <EventRow event={event} defaultOpen={defaultOpen} />;
  return (
    <StreamCard
      tone={view.tone}
      defaultOpen={defaultOpen}
      title={
        <span className="notice-block-text" role="status">
          {view.text}
        </span>
      }
    >
      <EventPayload event={event} />
    </StreamCard>
  );
}

/** 原始事件行：时间 + 标签 + 单行预览，展开看完整载荷。 */
export function EventRow({
  event,
  defaultOpen = false,
}: {
  event: RunEvent;
  defaultOpen?: boolean;
}) {
  const tag = eventTag(event.type);
  return (
    <StreamCard
      defaultOpen={defaultOpen}
      title={
        <>
          <span className="shrink-0 font-mono text-sm tabular-nums text-faint">
            {formatTimestamp(event.ts, { withMs: true })}
          </span>
          <span
            className={
              'shrink-0 rounded-xs bg-sunken px-1.5 font-mono text-sm leading-4 tracking-wide whitespace-nowrap ' +
              (TAG_TONE[tag.cls] ?? 'text-faint')
            }
          >
            {tag.label}
          </span>
        </>
      }
      summary={renderEventBody(event)}
    >
      <EventPayload event={event} />
    </StreamCard>
  );
}
