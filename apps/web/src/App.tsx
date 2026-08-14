import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ConnectionState, GatewayClient } from './gatewayClient';
import type { RunEvent, SessionInfo, StreamChunk, ToolSchema } from './types';

const GATEWAY_URL =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8642';

// ── 时间线模型：RunEvent 按 run_id 分组，并把 llm.stream.chunk 的 text_delta 拼成文本块 ──
type TimelineItem = { kind: 'text'; text: string } | { kind: 'event'; event: RunEvent };

interface RunGroup {
  runId: string;
  sessionId?: string;
  input?: string;
  output?: string;
  error?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  iterations?: number;
  items: TimelineItem[];
}

function buildGroup(runId: string, events: RunEvent[]): RunGroup {
  const group: RunGroup = { runId, status: 'running', items: [] };
  let buf = '';
  const flush = () => {
    if (buf) {
      group.items.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'run.started': {
        const d = ev.data as { input?: string; session_id?: string };
        group.input = d.input;
        group.sessionId = d.session_id;
        group.startedAt = ev.ts;
        continue;
      }
      case 'run.completed': {
        flush();
        const d = ev.data as { output?: string; duration_ms?: number; iterations?: number };
        group.output = d.output;
        group.durationMs = d.duration_ms;
        group.iterations = d.iterations;
        group.status = 'completed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'run.failed': {
        flush();
        const d = ev.data as { error?: string; duration_ms?: number };
        group.error = d.error;
        group.durationMs = d.duration_ms;
        group.status = 'failed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'llm.stream.chunk': {
        const chunk = (ev.data as { chunk?: StreamChunk }).chunk;
        if (chunk?.type === 'text_delta' && chunk.delta) buf += chunk.delta;
        else if (chunk?.type === 'finish') flush();
        continue;
      }
      default:
        flush();
        group.items.push({ kind: 'event', event: ev });
    }
  }
  flush();
  return group;
}

function groupEvents(events: RunEvent[]): RunGroup[] {
  const byRun = new Map<string, RunEvent[]>();
  for (const ev of events) {
    const list = byRun.get(ev.run_id);
    if (list) list.push(ev);
    else byRun.set(ev.run_id, [ev]);
  }
  return [...byRun.entries()].map(([runId, list]) => buildGroup(runId, list));
}

// ── 工具函数 ──
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatTime(ts?: number): string {
  if (ts == null) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 行内时间戳（带毫秒，便于区分同一秒内的多条事件） */
function formatRowTime(ts: number): string {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('zh-CN', { hour12: false });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 从 llm.request.data.tools 提取工具 schema（宽松解析，过滤非法项） */
function extractToolSchemas(raw: unknown[]): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fn = (item as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') continue;
    const f = fn as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof f.name !== 'string') continue;
    out.push({
      type: 'function',
      function: {
        name: f.name,
        description: typeof f.description === 'string' ? f.description : undefined,
        parameters:
          f.parameters && typeof f.parameters === 'object'
            ? (f.parameters as Record<string, unknown>)
            : undefined,
      },
    });
  }
  return out;
}

// ── 事件类型标签（时间线色块）──
function eventTag(type: string): { label: string; cls: string } {
  if (type.startsWith('tool.call.')) {
    if (type.endsWith('.failed')) return { label: 'tool.fail', cls: 'tag-tool-fail' };
    if (type.endsWith('.completed')) return { label: 'tool.ok', cls: 'tag-tool-done' };
    return { label: 'tool', cls: 'tag-tool-start' };
  }
  if (type.startsWith('guardrail.')) return { label: type, cls: 'tag-guard' };
  if (type.startsWith('llm.')) return { label: type, cls: 'tag-llm' };
  if (type === 'error') return { label: 'error', cls: 'tag-error' };
  return { label: type, cls: 'tag-raw' };
}

// ── 单条事件渲染：时间戳 + 类型色块 + 内容 ──
function EventRow({ event }: { event: RunEvent }) {
  const tag = eventTag(event.type);
  return (
    <div className={`row ${tag.cls}`}>
      <span className="ts dim">{formatRowTime(event.ts)}</span>
      <span className={`type-tag ${tag.cls}`}>{tag.label}</span>
      {renderEventBody(event)}
    </div>
  );
}

function renderEventBody(event: RunEvent) {
  switch (event.type) {
    case 'tool.call.started': {
      const d = event.data as { tool_name?: string; arguments?: unknown };
      const args = d.arguments == null ? '' : JSON.stringify(d.arguments);
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {args && <span className="dim">{truncate(args, 160)}</span>}
        </>
      );
    }
    case 'tool.call.completed': {
      const d = event.data as { tool_name?: string; duration_ms?: number };
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {d.duration_ms != null && <span className="dim">{d.duration_ms}ms</span>}
        </>
      );
    }
    case 'tool.call.failed': {
      const d = event.data as { tool_name?: string; error?: string };
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          <span className="err">{truncate(d.error ?? '', 160)}</span>
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

// ── 单次 run 卡片：顶部 run.started 边界，底部 run.completed/run.failed 边界 ──
function RunCard({ group }: { group: RunGroup }) {
  return (
    <div className={`run-card ${group.status}`}>
      <div className="run-header">
        <span className={`status-chip ${group.status}`}>{group.status}</span>
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {group.startedAt != null && <span className="dim">{formatTime(group.startedAt)}</span>}
        {group.sessionId && <span className="dim">session {truncate(group.sessionId, 16)}</span>}
      </div>

      {group.input && <div className="run-input">{group.input}</div>}

      <div className="run-items">
        {group.items.map((it) =>
          it.kind === 'text' ? (
            <div className="text-block" key={`text-${it.text}`}>
              {it.text}
            </div>
          ) : (
            <EventRow
              key={`ev-${it.event.ts}-${it.event.type}-${it.event.run_id}`}
              event={it.event}
            />
          ),
        )}
      </div>

      {group.status === 'completed' && (
        <div className="run-footer completed">
          <div className="foot-meta">
            ✓ completed
            {group.durationMs != null && <span className="dim">{group.durationMs}ms</span>}
            {group.iterations != null && <span className="dim">{group.iterations} iters</span>}
            {group.completedAt != null && (
              <span className="dim">{formatTime(group.completedAt)}</span>
            )}
          </div>
          {group.output && <pre className="run-output">{group.output}</pre>}
        </div>
      )}
      {group.status === 'failed' && (
        <div className="run-footer failed">✗ failed {truncate(group.error ?? '', 240)}</div>
      )}
    </div>
  );
}

// ── 主应用 ──
export default function App() {
  const [token, setToken] = useState<string>(() => {
    const url = new URLSearchParams(window.location.search).get('token');
    return url ?? localStorage.getItem('vessel.token') ?? '';
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  const client = useMemo(() => new GatewayClient(GATEWAY_URL), []);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const setTokenAndPersist = (v: string) => {
    setToken(v);
    if (v) localStorage.setItem('vessel.token', v);
    else localStorage.removeItem('vessel.token');
  };

  const refreshSessions = useCallback(
    (silent = false) => {
      const tk = token.trim();
      if (!tk) return;
      client
        .fetchSessions(tk)
        .then(setSessions)
        .catch((e: unknown) => {
          if (!silent) setError(e instanceof Error ? e.message : String(e));
        });
    },
    [token, client],
  );

  // WS 连接 + 事件订阅（token 变化时重连；断线后 1.5s 自动重连并重新回放历史）
  useEffect(() => {
    const tk = token.trim();
    if (!tk) {
      setConnState('idle');
      setEvents([]);
      return;
    }

    setEvents([]);
    let reconnectTimer: number | undefined;
    const offEvent = client.onEvent((ev) => setEvents((prev) => [...prev, ev]));
    const offState = client.onState((s) => {
      if (s === 'closed' || s === 'error') {
        setConnState('reconnecting');
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          setEvents([]);
          client
            .connect(tk)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }, 1500);
      } else {
        setConnState(s);
      }
    });
    client.connect(tk).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      offEvent();
      offState();
      window.clearTimeout(reconnectTimer);
      client.close();
    };
  }, [token, client]);

  // 会话列表：首次拉取 + 每 8s 静默刷新
  useEffect(() => {
    if (!token.trim()) {
      setSessions([]);
      return;
    }
    refreshSessions(false);
    const id = window.setInterval(() => refreshSessions(true), 8000);
    return () => window.clearInterval(id);
  }, [token, refreshSessions]);

  // 新事件自动滚动到底部
  useEffect(() => {
    if (events.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  const handleSend = async () => {
    const tk = token.trim();
    const text = input.trim();
    if (!tk || !text || sending) return;
    setSending(true);
    setError(null);
    setLastOutput(null);
    try {
      const output = await client.run(tk, text, selectedId ?? undefined);
      setLastOutput(output);
      setInput('');
      refreshSessions(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const groups = useMemo(() => groupEvents(events), [events]);
  const visibleGroups = useMemo(() => {
    if (!selectedId) return groups;
    return groups.filter((g) => g.sessionId === selectedId);
  }, [groups, selectedId]);

  // 最近一次 llm.request 携带的工具 schema（gateway 无工具列表端点，从事件流提取）
  const toolSchemas = useMemo<ToolSchema[] | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type !== 'llm.request') continue;
      const tools = ev.data.tools;
      if (Array.isArray(tools)) return extractToolSchemas(tools);
    }
    return null;
  }, [events]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Vessel</span>
        <span className={`conn conn-${connState}`} title="gateway 连接状态">
          <span className="conn-dot" />
          {connState === 'reconnecting' ? '重连中…' : connState}
        </span>
        <input
          className="token-input"
          type="password"
          value={token}
          onChange={(e) => setTokenAndPersist(e.target.value)}
          placeholder="gateway token（或 ?token=）"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="gateway-url dim">{GATEWAY_URL}</span>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => refreshSessions(false)}
          disabled={!token.trim()}
        >
          刷新
        </button>
      </header>

      {error && (
        <button type="button" className="error-banner" onClick={() => setError(null)}>
          {error} <span className="dim">(点击关闭)</span>
        </button>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">
            会话 <span className="dim">({sessions.length})</span>
          </div>
          <div className="sessions">
            <button
              type="button"
              className={`session-item ${selectedId === null ? 'active' : ''}`}
              onClick={() => setSelectedId(null)}
            >
              <div className="session-title">全部 runs</div>
              <div className="session-preview dim">不筛选会话</div>
            </button>
            {sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                className={`session-item ${s.session_id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(s.session_id)}
              >
                <div className="session-title">{s.title || s.preview || s.session_id}</div>
                <div className="session-preview">{s.preview || s.session_id}</div>
                <div className="session-meta">
                  <span className={`chip ${s.status}`}>{s.status}</span>
                  <span>{s.message_count} msgs</span>
                  <span className="dim">{formatTime(s.updated_at)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="sidebar-title">
            工具 <span className="dim">({toolSchemas?.length ?? 0})</span>
          </div>
          <div className="tools">
            {toolSchemas === null ? (
              <div className="tools-empty dim">运行一次后显示工具</div>
            ) : toolSchemas.length === 0 ? (
              <div className="tools-empty dim">本次 run 未携带工具</div>
            ) : (
              toolSchemas.map((t) => (
                <div
                  className="tool-item"
                  key={t.function.name}
                  title={t.function.description ?? t.function.name}
                >
                  <div className="tool-name">
                    <span className="tool-dot" />
                    <span className="mono">{t.function.name}</span>
                  </div>
                  {t.function.description && (
                    <div className="tool-desc">{truncate(t.function.description, 90)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        <main className="timeline">
          {visibleGroups.length === 0 && (
            <div className="empty">
              {events.length === 0 ? '等待事件…（连接 gateway 后自动回放历史）' : '当前筛选无事件'}
            </div>
          )}
          {visibleGroups.map((g) => (
            <RunCard key={g.runId} group={g} />
          ))}
          <div ref={bottomRef} />
        </main>
      </div>

      <footer className="control">
        <span className="control-session" title={selectedId ?? undefined}>
          {selectedId ? `→ ${truncate(selectedId, 20)}` : '新会话'}
        </span>
        <input
          className="control-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={token.trim() ? '输入 prompt，回车发送' : '请先填入 token'}
          disabled={!token.trim() || sending}
        />
        <button
          type="button"
          className="send-btn"
          onClick={() => void handleSend()}
          disabled={!token.trim() || sending || !input.trim()}
        >
          {sending ? '运行中…' : '发送'}
        </button>
        {lastOutput != null && (
          <span className="dim last-output">✓ {truncate(lastOutput, 60)}</span>
        )}
      </footer>
    </div>
  );
}
