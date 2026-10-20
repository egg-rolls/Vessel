import { formatTimestamp } from '../../format';
import type { RunEvent } from '../../gateway/types';
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

function ToolPayload({ label, value, open }: { label: string; value: unknown; open?: boolean }) {
  const text = payloadText(value);
  if (!text) return null;
  return (
    <details className="event-details" open={open}>
      <summary className="event-summary">{label}</summary>
      <pre className="event-payload">{text}</pre>
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
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {args !== undefined && (
            <>
              <span className="dim">{truncate(payloadText(args), 160)}</span>
              <ToolPayload label="参数" value={args} />
              {d.truncated === true && <span className="dim">（已截断）</span>}
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
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {d.duration_ms != null && <span className="dim">{d.duration_ms}ms</span>}
          {d.result !== undefined && (
            <>
              <span className="dim">{truncate(payloadText(d.result), 160)}</span>
              <ToolPayload label="结果" value={d.result} />
              {d.truncated === true && <span className="dim">（已截断）</span>}
            </>
          )}
        </>
      );
    }
    case 'tool.call.failed': {
      const d = event.data as { tool_name?: string; error?: string };
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          <ToolPayload label="错误（已展开）" value={d.error ?? 'error'} open />
        </>
      );
    }
    case 'guardrail.blocked': {
      const d = event.data as { guardrail_name?: string; reason?: string };
      return (
        <>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{truncate(d.reason ?? '', 160)}</span>
        </>
      );
    }
    case 'guardrail.modified': {
      const d = event.data as { guardrail_name?: string; stage?: string };
      return (
        <>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{d.stage ?? ''}</span>
        </>
      );
    }
    case 'llm.request': {
      const d = event.data as { messages?: unknown[]; tools?: unknown[] };
      return (
        <span className="dim">
          {d.messages?.length ?? 0} msgs{d.tools?.length ? ` · ${d.tools.length} tools` : ''}
        </span>
      );
    }
    case 'llm.response': {
      const d = event.data as { finish_reason?: string; usage?: { total_tokens?: number } };
      return (
        <span className="dim">
          {d.finish_reason ?? ''}
          {d.usage?.total_tokens != null ? ` · ${d.usage.total_tokens} tok` : ''}
        </span>
      );
    }
    case 'error': {
      const d = event.data as { error?: string };
      return <span className="err">{truncate(d.error ?? 'error', 240)}</span>;
    }
    default:
      return <span className="dim">{truncate(JSON.stringify(event.data), 200)}</span>;
  }
}

export function EventRow({ event }: { event: RunEvent }) {
  const tag = eventTag(event.type);
  return (
    <div className={`row ${tag.cls}`}>
      <span className="ts dim">{formatTimestamp(event.ts, { withMs: true })}</span>
      <span className={`type-tag ${tag.cls}`}>{tag.label}</span>
      <span className="event-body">{renderEventBody(event)}</span>
    </div>
  );
}
